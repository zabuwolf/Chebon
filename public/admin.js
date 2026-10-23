const $ = s => document.querySelector(s);
const money = n => (n || 0).toLocaleString('vi-VN') + 'đ';
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const OPEN = ['new', 'preparing', 'done'];
const STATUS_LABEL = { new: 'Mới', preparing: 'Đang làm', done: 'Đã lên món', paid: 'Đã thu', cancelled: 'Đã huỷ' };

const state = {
  orders: new Map(), // id -> order
  filter: 'open',
  tab: 'orders',
  menu: [],
  bill: [], // order ids in the open bill sheet
};

async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: { 'Content-Type': 'application/json' },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && !path.endsWith('/login')) { showLogin(); throw new Error('Phiên đăng nhập đã hết'); }
  if (!res.ok) throw new Error(data.error || 'Lỗi kết nối');
  return data;
}

let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 3000);
}

// Vietnam day key (YYYY-MM-DD) for a timestamp; the shop runs on UTC+7.
const vnDay = (ms = Date.now()) => new Date(ms + 7 * 3600e3).toISOString().slice(0, 10);
const addDays = (key, n) => vnDay(Date.parse(key + 'T00:00:00Z') - 7 * 3600e3 + n * 864e5);
const hhmm = ms => new Date(ms).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' });

// ---------- login ----------

function showLogin() {
  $('#app').hidden = true;
  $('#login').hidden = false;
  source?.close();
  setTimeout(() => $('#f-pass').focus(), 50);
}

$('#login-form').addEventListener('submit', async e => {
  e.preventDefault();
  $('#login-error').textContent = '';
  try {
    await api('/api/admin/login', { method: 'POST', body: { password: $('#f-pass').value } });
    $('#f-pass').value = '';
    unlockSound();
    start();
  } catch (err) {
    $('#login-error').textContent = err.message;
  }
});

$('#logout').addEventListener('click', async () => {
  await api('/api/admin/logout', { method: 'POST' }).catch(() => {});
  showLogin();
});

// ---------- sound ----------

// Browsers keep audio muted until the user taps something; the bell button
// stays visible until sound is actually running.
let audio;
const syncSoundBtn = () => $('#sound-btn').classList.toggle('on', audio?.state === 'running');
function unlockSound() {
  try {
    if (!audio) {
      audio = new (window.AudioContext || window.webkitAudioContext)();
      audio.addEventListener('statechange', syncSoundBtn);
    }
    audio.resume().then(syncSoundBtn);
  } catch {}
}
function ding() {
  if (!audio || audio.state !== 'running') return;
  const now = audio.currentTime;
  [[880, 0], [1320, 0.18], [880, 0.5], [1320, 0.68]].forEach(([f, t]) => {
    const o = audio.createOscillator(), g = audio.createGain();
    o.type = 'sine';
    o.frequency.value = f;
    g.gain.setValueAtTime(0.0001, now + t);
    g.gain.exponentialRampToValueAtTime(0.4, now + t + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, now + t + 0.16);
    o.connect(g).connect(audio.destination);
    o.start(now + t);
    o.stop(now + t + 0.18);
  });
}
$('#sound-btn').addEventListener('click', () => { unlockSound(); ding(); toast('Đã bật chuông báo đơn mới'); });
document.addEventListener('click', () => { if (audio?.state === 'suspended') audio.resume(); }, { capture: true });
document.addEventListener('visibilitychange', syncSoundBtn);

let titleTimer;
function flashTitle(text) {
  clearInterval(titleTimer);
  let on = false;
  titleTimer = setInterval(() => { document.title = (on = !on) ? text : 'Bon · Quản lý quán'; }, 1000);
}
window.addEventListener('focus', () => { clearInterval(titleTimer); document.title = 'Bon · Quản lý quán'; });

// ---------- realtime ----------

let source;
function connect() {
  source?.close();
  source = new EventSource('/api/admin/events');
  const live = $('#live');
  source.onopen = () => {
    live.className = 'live on';
    live.querySelector('span').textContent = 'Đang nhận đơn';
    loadOrders(); // catch anything missed while disconnected
  };
  source.onerror = () => {
    live.className = 'live off';
    live.querySelector('span').textContent = 'Mất kết nối…';
    // A 401 makes EventSource give up; check whether we were logged out.
    if (source.readyState === EventSource.CLOSED) api('/api/admin/me').then(r => r.loggedIn ? setTimeout(connect, 3000) : showLogin());
  };
  source.addEventListener('order', e => {
    const o = JSON.parse(e.data);
    const isNew = !state.orders.has(o.id) && o.status === 'new';
    state.orders.set(o.id, o);
    renderOrders();
    if (isNew) {
      ding();
      navigator.vibrate?.([200, 100, 200]);
      toast(`Đơn mới #${o.code} · ${o.table_no ? 'Bàn ' + o.table_no : 'Mang về'} · ${money(o.total)}`);
      flashTitle(`🔔 Đơn mới #${o.code}`);
    }
    if (state.bill.includes(o.id)) renderBill();
  });
}

// ---------- tabs ----------

$('#tabs').addEventListener('click', e => {
  const b = e.target.closest('[data-tab]');
  if (b) showTab(b.dataset.tab);
});

function showTab(tab) {
  state.tab = tab;
  document.querySelectorAll('#tabs [data-tab]').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  document.querySelectorAll('.view').forEach(v => (v.hidden = v.id !== 'view-' + tab));
  if (tab === 'stats') loadStats();
  if (tab === 'menu') loadMenu();
  if (tab === 'qr') renderQR();
  window.scrollTo(0, 0);
}

// ---------- orders ----------

let ordersDay = vnDay();
async function loadOrders() {
  try {
    const list = await api('/api/admin/orders');
    ordersDay = vnDay();
    state.orders = new Map(list.map(o => [o.id, o]));
    renderOrders();
  } catch (e) {
    toast(e.message);
  }
}

const FILTERS = [['open', 'Đang phục vụ'], ['history', 'Lịch sử hôm nay']];
const RANK = { new: 0, preparing: 1, done: 2 };

// One group per table; takeaway orders each stand alone.
function groupByTable(orders) {
  const groups = new Map();
  for (const o of orders.sort((a, b) => a.created_at - b.created_at)) {
    const key = o.table_no ? 't:' + o.table_no : 'a:' + o.id;
    if (!groups.has(key)) groups.set(key, { table: o.table_no, orders: [] });
    groups.get(key).orders.push(o);
  }
  // Tables needing attention first, then whoever has waited longest.
  return [...groups.values()].sort((a, b) => {
    const ra = Math.min(...a.orders.map(o => RANK[o.status]));
    const rb = Math.min(...b.orders.map(o => RANK[o.status]));
    return ra - rb || a.orders[0].created_at - b.orders[0].created_at;
  });
}

function renderOrders() {
  const all = [...state.orders.values()];
  const today = all.filter(o => vnDay(o.created_at) === ordersDay);
  const paid = today.filter(o => o.status === 'paid');
  const open = all.filter(o => OPEN.includes(o.status));
  const newCount = open.filter(o => o.status === 'new').length;
  const groups = groupByTable(open);

  $('#today-summary').innerHTML = `
    <div class="t"><small>Đã thu hôm nay</small><b>${money(paid.reduce((s, o) => s + o.total, 0))}</b></div>
    <div class="t"><small>Chưa thu</small><b>${money(open.reduce((s, o) => s + o.total, 0))}</b></div>
    <div class="t"><small>Bàn đang phục vụ</small><b>${groups.length}</b></div>
    <div class="t${newCount ? ' alert' : ''}"><small>Đơn mới chờ nhận</small><b>${newCount}</b></div>`;

  const badge = $('#tab-new-count');
  badge.hidden = !newCount;
  badge.textContent = newCount;

  const history = today.filter(o => !OPEN.includes(o.status)).sort((a, b) => b.updated_at - a.updated_at);
  const counts = { open: groups.length, history: history.length };
  $('#order-filters').innerHTML = FILTERS.map(([key, label]) =>
    `<button class="chip${state.filter === key ? ' active' : ''}" data-filter="${key}">${label}<span class="n">${counts[key]}</span></button>`
  ).join('');

  const list = $('#order-list');
  list.className = state.filter === 'open' ? 'table-grid' : 'history';
  if (state.filter === 'open') {
    list.innerHTML = groups.length ? groups.map(tableCard).join('')
      : '<p class="empty">Chưa có bàn nào gọi món. Đơn mới sẽ tự hiện ở đây 🔔</p>';
  } else {
    list.innerHTML = history.length ? `<div class="card">${history.map(historyRow).join('')}</div>`
      : '<p class="empty">Hôm nay chưa có đơn nào thanh toán.</p>';
  }
}

function tableCard(g) {
  const total = g.orders.reduce((s, o) => s + o.total, 0);
  const names = [...new Set(g.orders.map(o => o.customer_name))].join(', ');
  const newN = g.orders.filter(o => o.status === 'new').length;
  const allDone = g.orders.every(o => o.status === 'done');
  const tag = newN ? `<span class="status new">${newN} đơn mới</span>`
    : allDone ? '<span class="status done">Đã lên đủ món</span>'
    : '<span class="status preparing">Đang làm</span>';
  return `<article class="card tcard${newN ? ' has-new' : ''}">
    <header class="t-head">
      <div class="t-title">
        <span class="t-name${g.table ? '' : ' away'}">${g.table ? 'Bàn ' + esc(g.table) : 'Mang về'}</span>
        ${tag}
      </div>
      <div class="t-meta">${esc(names)} · ${g.orders.length} lượt gọi · từ ${hhmm(g.orders[0].created_at)}</div>
    </header>
    <div class="t-orders">${g.orders.map(orderBlock).join('')}</div>
    <footer class="t-foot">
      <div><small>Tổng ${g.table ? 'bàn' : 'đơn'}</small><b>${money(total)}</b></div>
      <button class="btn${allDone ? '' : ' soft'}" data-bill="${g.orders[0].id}">Tính tiền</button>
    </footer>
  </article>`;
}

function orderBlock(o) {
  const actions = {
    new: `<button class="btn sm" data-act="preparing" data-id="${o.id}">Nhận đơn</button>
          <button class="btn danger sm" data-act="cancelled" data-id="${o.id}">Huỷ</button>`,
    preparing: `<button class="btn sm" data-act="done" data-id="${o.id}">Xong món</button>`,
    done: '',
  }[o.status];
  return `<section class="ob ${o.status}">
    <div class="ob-head">
      <span class="ob-code">#${o.code}</span>
      <span class="ob-time">${hhmm(o.created_at)}</span>
      <span class="status ${o.status}">${STATUS_LABEL[o.status]}</span>
    </div>
    <div class="ob-who">${esc(o.customer_name)} · <a href="tel:${esc(o.phone)}">${esc(o.phone)}</a></div>
    <ul class="o-items">${o.items.map(i => `<li><span class="q">${i.qty}×</span><span class="nm">${esc(i.name)}</span><span class="pr">${money(i.price * i.qty)}</span></li>`).join('')}</ul>
    ${o.note ? `<div class="o-note">📝 ${esc(o.note)}</div>` : ''}
    ${actions ? `<div class="o-actions">${actions}</div>` : ''}
  </section>`;
}

function historyRow(o) {
  const undo = o.status === 'paid'
    ? `<button class="linkbtn" data-act="done" data-id="${o.id}">Huỷ thu tiền</button>`
    : `<button class="linkbtn" data-act="new" data-id="${o.id}">Khôi phục</button>`;
  return `<div class="hrow ${o.status}">
    <div class="h-main">
      <div class="h-top"><b>${o.table_no ? 'Bàn ' + esc(o.table_no) : 'Mang về'}</b><span>#${o.code} · ${hhmm(o.created_at)} · ${esc(o.customer_name)}</span></div>
      <div class="h-items">${o.items.map(i => `${i.qty}× ${esc(i.name)}`).join(', ')}</div>
    </div>
    <div class="h-side"><b>${money(o.total)}</b><span class="status ${o.status}">${STATUS_LABEL[o.status]}</span>${undo}</div>
  </div>`;
}

$('#order-filters').addEventListener('click', e => {
  const b = e.target.closest('[data-filter]');
  if (!b) return;
  state.filter = b.dataset.filter;
  renderOrders();
});

$('#order-list').addEventListener('click', async e => {
  const act = e.target.closest('[data-act]');
  const bill = e.target.closest('[data-bill]');
  if (bill) return openBill(Number(bill.dataset.bill));
  if (!act) return;
  if (act.dataset.act === 'cancelled' && !confirm('Huỷ đơn này?')) return;
  act.disabled = true;
  try {
    const o = await api('/api/admin/orders/' + act.dataset.id, { method: 'PATCH', body: { status: act.dataset.act } });
    state.orders.set(o.id, o);
    renderOrders();
  } catch (err) {
    toast(err.message);
    act.disabled = false;
  }
});

// ---------- bill: settle one order, or every unpaid order of the same table ----------

function openBill(id) {
  const o = state.orders.get(id);
  state.bill = o.table_no
    ? [...state.orders.values()].filter(x => x.table_no === o.table_no && OPEN.includes(x.status)).map(x => x.id)
    : [id];
  $('#bill-title').textContent = o.table_no ? `Tính tiền · Bàn ${o.table_no}` : `Tính tiền · Đơn #${o.code}`;
  renderBill();
  $('#backdrop').classList.add('open');
  $('#bill-sheet').classList.add('open');
}

function renderBill() {
  const orders = state.bill.map(id => state.orders.get(id)).filter(o => o && OPEN.includes(o.status));
  // Merge identical dishes across the table's orders into one line.
  const lines = new Map();
  for (const o of orders) for (const i of o.items) {
    const k = i.name + '|' + i.price;
    const l = lines.get(k) || { ...i, qty: 0 };
    l.qty += i.qty;
    lines.set(k, l);
  }
  const total = orders.reduce((s, o) => s + o.total, 0);
  $('#bill-body').innerHTML = orders.length ? `
    <p class="hint">${orders.length} đơn: ${orders.map(o => '#' + o.code).join(', ')} · ${esc(orders[0].customer_name)}${orders.length > 1 ? ' và khách cùng bàn' : ''}</p>
    <table class="table">
      <tr><th>Món</th><th class="num">SL</th><th class="num">Thành tiền</th></tr>
      ${[...lines.values()].map(l => `<tr><td>${esc(l.name)}<br><small style="color:var(--muted)">${money(l.price)}</small></td><td class="num">${l.qty}</td><td class="num">${money(l.price * l.qty)}</td></tr>`).join('')}
    </table>` : '<p class="empty">Bàn này đã thanh toán hết.</p>';
  $('#bill-total').textContent = money(total);
  $('#bill-pay').disabled = !orders.length;
  $('#bill-pay').textContent = orders.length ? `Đã thu ${money(total)}` : 'Đã thu tiền';
}

function closeBill() {
  state.bill = [];
  $('#backdrop').classList.remove('open');
  $('#bill-sheet').classList.remove('open');
}
$('#backdrop').addEventListener('click', closeBill);
document.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', closeBill));

$('#bill-pay').addEventListener('click', async () => {
  const ids = state.bill.filter(id => OPEN.includes(state.orders.get(id)?.status));
  if (!ids.length) return;
  $('#bill-pay').disabled = true;
  try {
    const updated = await api('/api/admin/orders/pay', { method: 'POST', body: { ids } });
    updated.forEach(o => state.orders.set(o.id, o));
    renderOrders();
    closeBill();
    toast(`Đã thu ${money(updated.reduce((s, o) => s + o.total, 0))}`);
  } catch (err) {
    toast(err.message);
    $('#bill-pay').disabled = false;
  }
});

// ---------- revenue ----------

function presetRange(key) {
  const today = vnDay();
  const month = today.slice(0, 8) + '01';
  switch (key) {
    case 'yesterday': return [addDays(today, -1), addDays(today, -1)];
    case '7d': return [addDays(today, -6), today];
    case 'month': return [month, today];
    case 'lastmonth': { const end = addDays(month, -1); return [end.slice(0, 8) + '01', end]; }
    default: return [today, today];
  }
}

$('#range-presets').addEventListener('click', e => {
  const b = e.target.closest('[data-range]');
  if (!b) return;
  document.querySelectorAll('#range-presets .chip').forEach(c => c.classList.toggle('active', c === b));
  [$('#r-from').value, $('#r-to').value] = presetRange(b.dataset.range);
  loadStats();
});
['#r-from', '#r-to'].forEach(s => $(s).addEventListener('change', () => {
  document.querySelectorAll('#range-presets .chip').forEach(c => c.classList.remove('active'));
  if ($('#r-from').value > $('#r-to').value) $('#r-to').value = $('#r-from').value;
  loadStats();
}));

async function loadStats() {
  if (!$('#r-from').value) [$('#r-from').value, $('#r-to').value] = presetRange('today');
  try {
    const s = await api(`/api/admin/stats?from=${$('#r-from').value}&to=${$('#r-to').value}`);
    renderStats(s);
  } catch (e) {
    toast(e.message);
  }
}

function renderStats(s) {
  const avg = s.paidCount ? Math.round(s.revenue / s.paidCount) : 0;
  $('#stat-tiles').innerHTML = `
    <div class="tile hero"><small>Doanh thu (đã thu tiền)</small><b>${money(s.revenue)}</b><span>${s.paidCount} đơn</span></div>
    <div class="tile"><small>Trung bình / đơn</small><b>${money(avg)}</b></div>
    <div class="tile"><small>Chưa thu tiền</small><b>${money(s.unpaid)}</b><span>${s.unpaidCount} đơn</span></div>
    <div class="tile"><small>Đơn bị huỷ</small><b>${s.cancelledCount}</b></div>`;

  $('#chart-panel').hidden = s.byDay.length < 2;
  if (s.byDay.length >= 2) renderChart(s.byDay);

  $('#top-items').innerHTML = s.topItems.length
    ? `<tr><th>#</th><th>Món</th><th class="num">SL</th><th class="num">Doanh thu</th></tr>` +
      s.topItems.map((i, n) => `<tr><td>${n + 1}</td><td>${esc(i.name)}</td><td class="num">${i.qty}</td><td class="num">${money(i.amount)}</td></tr>`).join('')
    : '<tr><td class="empty">Chưa có đơn đã thanh toán trong khoảng này.</td></tr>';
}

function niceMax(v) {
  if (v <= 0) return 100000;
  const p = 10 ** Math.floor(Math.log10(v));
  return [1, 2, 2.5, 5, 10].map(m => m * p).find(m => m >= v);
}
const short = n => n >= 1e6 ? (n / 1e6).toLocaleString('vi-VN', { maximumFractionDigits: 1 }) + 'tr' : n >= 1e3 ? Math.round(n / 1e3) + 'k' : String(n);
const dm = key => key.slice(8, 10) + '/' + key.slice(5, 7);

function renderChart(days) {
  const max = niceMax(Math.max(...days.map(d => d.revenue)));
  const grid = [0.5, 1].map(f => `<div class="gridline" style="bottom:${f * 100}%"><span>${short(max * f)}</span></div>`).join('');
  $('#chart').innerHTML = grid + days.map((d, i) =>
    `<div class="bar-wrap" data-i="${i}" tabindex="0" aria-label="${dm(d.date)}: ${money(d.revenue)}, ${d.count} đơn">
      <div class="bar" style="height:${(d.revenue / max) * 100}%"></div></div>`).join('') +
    `<div class="chart-axis" style="position:absolute;left:0;right:0;bottom:-22px"><span>${dm(days[0].date)}</span><span>${dm(days.at(-1).date)}</span></div>`;
  $('#chart').style.marginBottom = '26px';

  const tip = $('#chart-tip');
  const show = el => {
    const d = days[el.dataset.i];
    const r = el.getBoundingClientRect();
    tip.innerHTML = `<b>${dm(d.date)}</b> · ${money(d.revenue)} · ${d.count} đơn`;
    tip.style.left = r.left + r.width / 2 + 'px';
    tip.style.top = Math.max(r.top + r.height - el.firstElementChild.offsetHeight, r.top) + 'px';
    tip.hidden = false;
    document.querySelectorAll('.bar-wrap.hl').forEach(b => b.classList.remove('hl'));
    el.classList.add('hl');
  };
  const hide = () => { tip.hidden = true; document.querySelectorAll('.bar-wrap.hl').forEach(b => b.classList.remove('hl')); };
  $('#chart').querySelectorAll('.bar-wrap').forEach(el => {
    el.addEventListener('pointerenter', () => show(el));
    el.addEventListener('focus', () => show(el));
    el.addEventListener('pointerleave', hide);
    el.addEventListener('blur', hide);
  });
}
window.addEventListener('scroll', () => ($('#chart-tip').hidden = true), { passive: true });

// ---------- menu ----------

async function loadMenu() {
  try {
    state.menu = await api('/api/admin/menu');
    renderMenu();
  } catch (e) {
    toast(e.message);
  }
}

function renderMenu() {
  $('#menu-admin').innerHTML = state.menu.map(c => `
    <div class="m-cat">
      <h3>${esc(c.name)}</h3>
      ${c.items.map(i => `
        <div class="m-item${i.available ? '' : ' off'}" data-id="${i.id}">
          <input class="m-name" value="${esc(i.name)}" data-field="name" aria-label="Tên món">
          <label class="m-price"><input type="number" inputmode="numeric" min="0" step="1" value="${i.price / 1000}" data-field="price" aria-label="Giá (nghìn đồng)">k</label>
          <label class="switch" title="${i.available ? 'Còn món' : 'Hết món'}"><input type="checkbox" data-field="available" ${i.available ? 'checked' : ''} aria-label="Còn món"><span></span></label>
          <button class="m-del" data-del="${i.id}" aria-label="Xoá món">🗑</button>
        </div>`).join('')}
      <form class="m-add" data-cat="${c.id}">
        <input class="input" name="name" placeholder="Thêm món mới…" maxlength="60" required>
        <input class="input" name="price" type="number" inputmode="numeric" min="0" placeholder="Giá (k)" required>
        <button class="btn sm">Thêm</button>
      </form>
    </div>`).join('');
}

async function saveItem(id, patch) {
  try {
    state.menu = await api('/api/admin/items/' + id, { method: 'PATCH', body: patch });
    renderMenu();
    toast('Đã lưu');
  } catch (e) {
    toast(e.message);
    renderMenu();
  }
}

$('#menu-admin').addEventListener('change', e => {
  const input = e.target.closest('[data-field]');
  if (!input) return;
  const id = Number(input.closest('[data-id]').dataset.id);
  const f = input.dataset.field;
  if (f === 'available') return saveItem(id, { available: input.checked });
  if (f === 'price') return saveItem(id, { price: Math.round(Number(input.value) * 1000) });
  if (f === 'name') return saveItem(id, { name: input.value });
});

$('#menu-admin').addEventListener('click', async e => {
  const del = e.target.closest('[data-del]');
  if (!del) return;
  const name = del.closest('.m-item').querySelector('.m-name').value;
  if (!confirm(`Xoá món "${name}" khỏi thực đơn?`)) return;
  try {
    state.menu = await api('/api/admin/items/' + del.dataset.del, { method: 'DELETE' });
    renderMenu();
  } catch (err) {
    toast(err.message);
  }
});

$('#menu-admin').addEventListener('submit', async e => {
  e.preventDefault();
  const f = e.target;
  try {
    state.menu = await api('/api/admin/items', {
      method: 'POST',
      body: { categoryId: Number(f.dataset.cat), name: f.name.value, price: Math.round(Number(f.price.value) * 1000) },
    });
    renderMenu();
    toast('Đã thêm món');
  } catch (err) {
    toast(err.message);
  }
});

// ---------- QR ----------

async function renderQR() {
  const n = Math.max(1, Math.min(60, Number($('#qr-count').value) || 1));
  const tables = [...Array(n)].map((_, i) => String(i + 1));
  $('#qr-grid').innerHTML = [...tables, ''].map(t => `
    <div class="qr-card">
      <img class="logo" src="logo.svg" alt="Bon">
      <div class="t">${t ? 'Bàn ' + t : 'Mang về'}</div>
      <div class="qr"><img src="/api/admin/qr.svg?table=${encodeURIComponent(t)}" alt="Mã QR ${t ? 'bàn ' + t : 'mang về'}" loading="lazy"></div>
      <p>Quét mã để gọi món</p>
    </div>`).join('');
  try {
    const { base } = await api('/api/admin/qr-base');
    $('#qr-base').textContent = 'Mã QR dẫn tới: ' + base;
    const local = /localhost|127\.0\.0\.1|192\.168\.|10\.\d+\.|172\.(1[6-9]|2\d|3[01])\./.test(base);
    $('#qr-warn').hidden = !local;
    $('#qr-warn').textContent = 'Lưu ý: địa chỉ này chỉ dùng được trong mạng nội bộ/máy này. Khi đưa web lên tên miền thật, hãy in lại mã QR.';
  } catch {}
}
$('#qr-count').addEventListener('change', renderQR);
$('#qr-print').addEventListener('click', () => window.print());

// ---------- start ----------

function start() {
  $('#login').hidden = true;
  $('#app').hidden = false;
  showTab(state.tab);
  loadOrders();
  connect();
}

// Reload when the day rolls over or the phone wakes the tab up.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && !$('#app').hidden) {
    if (vnDay() !== ordersDay) loadOrders();
    if (source?.readyState === EventSource.CLOSED) connect();
  }
});

api('/api/admin/me').then(r => (r.loggedIn ? start() : showLogin())).catch(showLogin);

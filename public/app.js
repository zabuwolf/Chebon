const $ = s => document.querySelector(s);
const money = n => n.toLocaleString('vi-VN') + 'đ';
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const store = {
  get(key, fallback) {
    try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch {}
  },
};

const STATUS = {
  new: ['Chờ quán xác nhận', 1],
  preparing: ['Đang làm món', 2],
  done: ['Món đã xong', 3],
  paid: ['Đã thanh toán', 4],
  cancelled: ['Đã huỷ', 0],
};

// Table number comes from the QR code (?ban=5); a QR without it is for takeaway.
const params = new URLSearchParams(location.search);
const qrTable = (params.get('ban') || '').trim().slice(0, 10);

const state = {
  user: store.get('bon_user', null),
  table: qrTable || store.get('bon_table', ''),
  menu: [],
  cart: new Map(), // itemId -> qty
  orders: store.get('bon_orders', []), // tokens, newest first
};

async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: { 'Content-Type': 'application/json' },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Lỗi kết nối, vui lòng thử lại');
  return data;
}

let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2600);
}

// ---------- welcome ----------

function showWelcome() {
  $('#shop').hidden = true;
  $('#welcome').hidden = false;
  $('#f-name').value = state.user?.name || '';
  $('#f-phone').value = state.user?.phone || '';
  $('#f-table').value = state.table;
  $('#f-table-field').hidden = !!qrTable;
  $('#welcome-table').hidden = !qrTable;
  $('#welcome-table').textContent = 'Bàn ' + qrTable;
}

$('#welcome-form').addEventListener('submit', e => {
  e.preventDefault();
  const name = $('#f-name').value.trim();
  let phone = $('#f-phone').value.replace(/[\s.\-()]/g, '');
  if (phone.startsWith('+84')) phone = '0' + phone.slice(3);
  const err = $('#welcome-error');
  if (!name) return (err.textContent = 'Bạn nhập tên giúp quán nhé');
  if (!/^0\d{9}$/.test(phone)) return (err.textContent = 'Số điện thoại cần đủ 10 số, VD: 0912345678');
  err.textContent = '';
  state.user = { name, phone };
  store.set('bon_user', state.user);
  if (!qrTable) {
    state.table = $('#f-table').value.trim();
    store.set('bon_table', state.table);
  }
  showShop();
});

$('#edit-info').addEventListener('click', showWelcome);

// ---------- menu ----------

function showShop() {
  $('#welcome').hidden = true;
  $('#shop').hidden = false;
  $('#hello-name').textContent = state.user.name;
  const pill = $('#table-pill');
  pill.hidden = false;
  pill.textContent = state.table ? 'Bàn ' + state.table : 'Mang về';
  if (!state.menu.length) loadMenu();
  window.scrollTo(0, 0);
}

async function loadMenu() {
  try {
    state.menu = await api('/api/menu');
    renderMenu();
  } catch (e) {
    $('#menu').innerHTML = `<p class="empty">${esc(e.message)}<br><button class="btn sm soft" onclick="loadMenu()" style="margin-top:12px">Thử lại</button></p>`;
  }
}

function findItem(id) {
  for (const c of state.menu) for (const i of c.items) if (i.id === id) return i;
}

function itemControls(item) {
  if (!item.available) return '';
  const qty = state.cart.get(item.id) || 0;
  if (!qty) return `<button class="add" data-add="${item.id}" aria-label="Thêm ${esc(item.name)}">+</button>`;
  return `<div class="stepper">
    <button data-dec="${item.id}" aria-label="Bớt">−</button><span>${qty}</span><button data-add="${item.id}" aria-label="Thêm">+</button>
  </div>`;
}

function renderMenu() {
  const cats = state.menu.filter(c => c.items.length);
  $('#cats').innerHTML = cats.map((c, i) =>
    `<button class="chip${i ? '' : ' active'}" data-cat="${c.id}">${esc(c.name)}</button>`).join('');
  $('#menu').innerHTML = cats.map(c => `
    <section id="cat-${c.id}" data-cat-section="${c.id}">
      <h2>${esc(c.name)} <small>${c.items.length} món</small></h2>
      <div class="items">${c.items.map(i => `
        <div class="item${i.available ? '' : ' off'}${state.cart.has(i.id) ? ' in-cart' : ''}" data-item="${i.id}">
          <div class="info"><div class="name">${esc(i.name)}</div><div class="price">${money(i.price)}</div></div>
          <div class="ctl">${itemControls(i)}</div>
        </div>`).join('')}
      </div>
    </section>`).join('');
  watchSections();
  renderCart();
}

function refreshItem(id) {
  const el = document.querySelector(`[data-item="${id}"]`);
  if (!el) return;
  el.querySelector('.ctl').innerHTML = itemControls(findItem(id));
  el.classList.toggle('in-cart', state.cart.has(id));
}

function changeQty(id, delta) {
  const item = findItem(id);
  if (!item || !item.available) return;
  const qty = Math.max(0, Math.min(50, (state.cart.get(id) || 0) + delta));
  if (qty) state.cart.set(id, qty); else state.cart.delete(id);
  refreshItem(id);
  renderCart();
}

document.addEventListener('click', e => {
  const add = e.target.closest('[data-add]');
  const dec = e.target.closest('[data-dec]');
  if (add) changeQty(Number(add.dataset.add), 1);
  if (dec) changeQty(Number(dec.dataset.dec), -1);
});

$('#cats').addEventListener('click', e => {
  const chip = e.target.closest('[data-cat]');
  if (!chip) return;
  document.getElementById('cat-' + chip.dataset.cat).scrollIntoView({ behavior: 'smooth' });
});

// Highlight the category chip for the section currently on screen.
let sectionObserver;
function watchSections() {
  sectionObserver?.disconnect();
  sectionObserver = new IntersectionObserver(entries => {
    for (const en of entries) {
      if (!en.isIntersecting) continue;
      const id = en.target.dataset.catSection;
      document.querySelectorAll('.chip').forEach(c => {
        const on = c.dataset.cat === id;
        c.classList.toggle('active', on);
        if (on) c.scrollIntoView({ block: 'nearest', inline: 'center', behavior: 'smooth' });
      });
    }
  }, { rootMargin: '-120px 0px -65% 0px' });
  document.querySelectorAll('[data-cat-section]').forEach(s => sectionObserver.observe(s));
}

// ---------- cart ----------

function cartTotals() {
  let qty = 0, total = 0;
  for (const [id, q] of state.cart) {
    const item = findItem(id);
    if (!item) continue;
    qty += q;
    total += item.price * q;
  }
  return { qty, total };
}

function renderCart() {
  const { qty, total } = cartTotals();
  $('#cartbar').hidden = qty === 0;
  $('#cart-qty').textContent = qty;
  $('#cart-total').textContent = money(total);
  $('#cart-sum').textContent = money(total);
  $('#place-order').disabled = qty === 0;
  $('#cart-lines').innerHTML = qty === 0
    ? '<p class="empty">Chưa có món nào trong giỏ.</p>'
    : [...state.cart].map(([id, q]) => {
        const i = findItem(id);
        return `<div class="line">
          <div class="info"><div class="name" style="font-weight:700">${esc(i.name)}</div><div class="sub">${money(i.price)} × ${q} = <b>${money(i.price * q)}</b></div></div>
          <div class="stepper"><button data-dec="${id}" aria-label="Bớt">−</button><span>${q}</span><button data-add="${id}" aria-label="Thêm">+</button></div>
        </div>`;
      }).join('');
  if (state.user) {
    $('#cart-who').textContent = `${state.user.name} · ${state.user.phone} · ${state.table ? 'Bàn ' + state.table : 'Mang về'}`;
  }
  if (qty === 0 && $('#cart-sheet').classList.contains('open')) closeSheets();
}

// ---------- sheets ----------

function openSheet(id) {
  closeSheets();
  $('#backdrop').classList.add('open');
  $(id).classList.add('open');
  document.body.style.overflow = 'hidden';
}
function closeSheets() {
  document.querySelectorAll('.sheet.open').forEach(s => s.classList.remove('open'));
  $('#backdrop').classList.remove('open');
  document.body.style.overflow = '';
  stopPolling();
}
$('#backdrop').addEventListener('click', closeSheets);
document.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', closeSheets));
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeSheets(); });

$('#open-cart').addEventListener('click', () => {
  $('#cart-error').textContent = '';
  openSheet('#cart-sheet');
});

$('#place-order').addEventListener('click', async () => {
  const btn = $('#place-order');
  btn.disabled = true;
  btn.textContent = 'Đang gửi…';
  $('#cart-error').textContent = '';
  try {
    const order = await api('/api/orders', {
      method: 'POST',
      body: {
        name: state.user.name,
        phone: state.user.phone,
        table: state.table,
        note: $('#f-note').value,
        items: [...state.cart].map(([id, qty]) => ({ id, qty })),
      },
    });
    state.orders = [order.token, ...state.orders.filter(t => t !== order.token)].slice(0, 10);
    store.set('bon_orders', state.orders);
    state.cart.clear();
    $('#f-note').value = '';
    renderMenu();
    updateOrdersBtn();
    toast(`Đã gửi đơn #${order.code}! Quán đang chuẩn bị.`);
    openOrders();
  } catch (e) {
    $('#cart-error').textContent = e.message;
    if (/hết|thực đơn/.test(e.message)) loadMenu();
  } finally {
    btn.disabled = cartTotals().qty === 0;
    btn.textContent = 'Đặt món';
  }
});

// ---------- my orders ----------

function updateOrdersBtn() {
  $('#orders-btn').hidden = state.orders.length === 0;
  $('#orders-count').textContent = state.orders.length;
}
$('#orders-btn').addEventListener('click', openOrders);

let pollTimer;
function stopPolling() { clearInterval(pollTimer); pollTimer = null; }

function openOrders() {
  openSheet('#orders-sheet');
  loadOrders();
  pollTimer = setInterval(loadOrders, 5000);
}

async function loadOrders() {
  const results = await Promise.all(state.orders.map(t => api('/api/orders/' + t).catch(e => (e.message === 'Không tìm thấy đơn' ? null : undefined))));
  // Forget tokens the server no longer knows about.
  const keep = state.orders.filter((t, i) => results[i] !== null);
  if (keep.length !== state.orders.length) {
    state.orders = keep;
    store.set('bon_orders', keep);
    updateOrdersBtn();
  }
  const orders = results.filter(Boolean);
  $('#orders-list').innerHTML = orders.length ? orders.map(orderCard).join('') : '<p class="empty">Bạn chưa có đơn nào.</p>';
}

function orderCard(o) {
  const [label, step] = STATUS[o.status] || [o.status, 0];
  const time = new Date(o.createdAt).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' });
  const progress = o.status === 'cancelled' ? '' :
    `<div class="progress">${[1, 2, 3, 4].map(n => `<i class="${n <= step ? 'on' : ''}"></i>`).join('')}</div>`;
  return `<div class="card order-card">
    <div class="head"><span class="code">#${o.code}</span><span class="status ${o.status}">${label}</span></div>
    ${progress}
    <div class="meta">${time} · ${o.table ? 'Bàn ' + esc(o.table) : 'Mang về'}</div>
    <ul>${o.items.map(i => `<li><span>${i.qty} × ${esc(i.name)}</span><span>${money(i.price * i.qty)}</span></li>`).join('')}</ul>
    ${o.note ? `<div class="meta">Ghi chú: ${esc(o.note)}</div>` : ''}
    <div class="sum" style="margin-top:8px"><span>Tổng</span><span>${money(o.total)}</span></div>
    ${o.status === 'new' ? `<button class="btn danger sm block" style="margin-top:12px" onclick="cancelOrder('${o.token}')">Huỷ đơn</button>` : ''}
  </div>`;
}

async function cancelOrder(token) {
  if (!confirm('Huỷ đơn này?')) return;
  try {
    await api(`/api/orders/${token}/cancel`, { method: 'POST' });
    toast('Đã huỷ đơn');
  } catch (e) {
    toast(e.message);
  }
  loadOrders();
}

// ---------- start ----------

updateOrdersBtn();
if (state.user) showShop(); else showWelcome();

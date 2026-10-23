const express = require('express');
const crypto = require('crypto');
const path = require('path');
const QRCode = require('qrcode');
const db = require('./db');

const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'bon123';
// Without SESSION_SECRET the owner has to log in again after every restart.
const SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const PUBLIC_URL = (process.env.PUBLIC_URL || '').replace(/\/$/, '');

const DAY = 24 * 3600 * 1000;
const TZ_OFFSET = 7 * 3600 * 1000; // Vietnam, UTC+7, no DST
const STATUSES = ['new', 'preparing', 'done', 'paid', 'cancelled'];
const OPEN_STATUSES = ['new', 'preparing', 'done'];

const app = express();
app.set('trust proxy', true);
app.use(express.json({ limit: '20kb' }));
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));

// ---------- helpers ----------

const startOfDay = ms => Math.floor((ms + TZ_OFFSET) / DAY) * DAY - TZ_OFFSET;
const dayKey = ms => new Date(ms + TZ_OFFSET).toISOString().slice(0, 10);
const parseDay = s => (/^\d{4}-\d{2}-\d{2}$/.test(s || '') ? Date.parse(s + 'T00:00:00Z') - TZ_OFFSET : null);

function bad(res, message, code = 400) {
  return res.status(code).json({ error: message });
}

function normalizePhone(raw) {
  let p = String(raw || '').replace(/[\s.\-()]/g, '');
  if (p.startsWith('+84')) p = '0' + p.slice(3);
  else if (p.startsWith('84') && p.length === 11) p = '0' + p.slice(2);
  return /^0\d{9}$/.test(p) ? p : null;
}

const clean = (s, max) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

function loadOrder(where, arg) {
  const o = db.prepare(`SELECT * FROM orders WHERE ${where}`).get(arg);
  if (!o) return null;
  o.items = db.prepare('SELECT item_id, name, price, qty FROM order_items WHERE order_id = ? ORDER BY id').all(o.id);
  return o;
}

function withItems(orders) {
  if (!orders.length) return orders;
  const rows = db.prepare(
    `SELECT order_id, item_id, name, price, qty FROM order_items
     WHERE order_id IN (${orders.map(() => '?').join(',')}) ORDER BY id`
  ).all(...orders.map(o => o.id));
  const byOrder = new Map(orders.map(o => [o.id, (o.items = [])]));
  for (const r of rows) byOrder.get(r.order_id).push(r);
  return orders;
}

// What a customer may see about their own order.
const publicOrder = o => ({
  token: o.token, code: o.code, table: o.table_no, status: o.status, total: o.total,
  note: o.note, createdAt: o.created_at, items: o.items.map(({ name, price, qty }) => ({ name, price, qty })),
});

// Simple in-memory rate limiter: `limit` hits per `windowMs` per IP and bucket.
const hits = new Map();
function rateLimit(bucket, limit, windowMs) {
  return (req, res, next) => {
    const key = bucket + ':' + req.ip;
    const now = Date.now();
    const list = (hits.get(key) || []).filter(t => now - t < windowMs);
    if (list.length >= limit) return bad(res, 'Bạn thao tác quá nhanh, vui lòng thử lại sau ít phút.', 429);
    list.push(now);
    hits.set(key, list);
    next();
  };
}
setInterval(() => {
  const now = Date.now();
  for (const [k, list] of hits) if (list.every(t => now - t > 3600e3)) hits.delete(k);
}, 600e3).unref();

// ---------- realtime (Server-Sent Events) for the owner ----------

const clients = new Set();
function broadcast(event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) res.write(msg);
}
setInterval(() => { for (const res of clients) res.write(': ping\n\n'); }, 25e3).unref();

// ---------- owner session ----------

function sign(value) {
  return crypto.createHmac('sha256', SECRET).update(value).digest('base64url');
}

function isAdmin(req) {
  const m = /(?:^|;\s*)bon_admin=([^;]+)/.exec(req.headers.cookie || '');
  if (!m) return false;
  const [exp, sig] = decodeURIComponent(m[1]).split('.');
  if (!exp || !sig || Number(exp) < Date.now()) return false;
  const expected = sign(exp);
  return sig.length === expected.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
}

function requireAdmin(req, res, next) {
  if (!isAdmin(req)) return bad(res, 'Chưa đăng nhập', 401);
  next();
}

app.post('/api/admin/login', rateLimit('login', 10, 15 * 60e3), (req, res) => {
  const given = Buffer.from(String(req.body?.password || ''));
  const real = Buffer.from(ADMIN_PASSWORD);
  if (given.length !== real.length || !crypto.timingSafeEqual(given, real)) {
    return bad(res, 'Sai mật khẩu', 401);
  }
  const exp = String(Date.now() + 30 * DAY);
  const secure = req.secure ? '; Secure' : '';
  res.setHeader('Set-Cookie',
    `bon_admin=${encodeURIComponent(exp + '.' + sign(exp))}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${30 * 86400}${secure}`);
  res.json({ ok: true });
});

app.post('/api/admin/logout', (req, res) => {
  res.setHeader('Set-Cookie', 'bon_admin=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');
  res.json({ ok: true });
});

app.get('/api/admin/me', (req, res) => res.json({ loggedIn: isAdmin(req) }));

// ---------- customer API ----------

function menu() {
  const cats = db.prepare('SELECT id, name FROM categories ORDER BY sort, id').all();
  const items = db.prepare(
    `SELECT id, category_id, name, price, available FROM items
     WHERE deleted = 0 ORDER BY sort, id`
  ).all();
  return cats.map(c => ({
    ...c,
    items: items.filter(i => i.category_id === c.id).map(i => ({ ...i, available: !!i.available })),
  }));
}

app.get('/api/menu', (req, res) => res.json(menu()));

app.post('/api/orders', rateLimit('order', 8, 5 * 60e3), (req, res) => {
  const b = req.body || {};
  const name = clean(b.name, 40);
  const phone = normalizePhone(b.phone);
  const table = clean(b.table, 10);
  const note = clean(b.note, 200);
  if (!name) return bad(res, 'Vui lòng nhập tên');
  if (!phone) return bad(res, 'Số điện thoại không hợp lệ');
  if (!Array.isArray(b.items) || b.items.length === 0) return bad(res, 'Giỏ hàng đang trống');
  if (b.items.length > 30) return bad(res, 'Đơn có quá nhiều món');

  const qtyById = new Map();
  for (const it of b.items) {
    const id = Number(it?.id), qty = Number(it?.qty);
    if (!Number.isInteger(id) || !Number.isInteger(qty) || qty < 1 || qty > 50) return bad(res, 'Số lượng không hợp lệ');
    qtyById.set(id, (qtyById.get(id) || 0) + qty);
  }

  const getItem = db.prepare('SELECT id, name, price, available FROM items WHERE id = ? AND deleted = 0');
  const lines = [];
  for (const [id, qty] of qtyById) {
    const item = getItem.get(id);
    if (!item) return bad(res, 'Có món không còn trong thực đơn, vui lòng tải lại trang');
    if (!item.available) return bad(res, `Món "${item.name}" vừa hết, bạn chọn món khác nhé`);
    lines.push({ ...item, qty });
  }
  const total = lines.reduce((s, l) => s + l.price * l.qty, 0);

  const now = Date.now();
  const token = crypto.randomBytes(12).toString('base64url');
  let orderId;
  db.exec('BEGIN IMMEDIATE');
  try {
    const code = db.prepare('SELECT COUNT(*) AS n FROM orders WHERE created_at >= ?').get(startOfDay(now)).n + 1;
    orderId = db.prepare(
      `INSERT INTO orders (token, code, table_no, customer_name, phone, note, status, total, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'new', ?, ?, ?)`
    ).run(token, code, table, name, phone, note, total, now, now).lastInsertRowid;
    const insLine = db.prepare('INSERT INTO order_items (order_id, item_id, name, price, qty) VALUES (?, ?, ?, ?, ?)');
    for (const l of lines) insLine.run(orderId, l.id, l.name, l.price, l.qty);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }

  const order = loadOrder('id = ?', orderId);
  broadcast('order', order);
  res.json(publicOrder(order));
});

app.get('/api/orders/:token', (req, res) => {
  const o = loadOrder('token = ?', req.params.token);
  if (!o) return bad(res, 'Không tìm thấy đơn', 404);
  res.json(publicOrder(o));
});

app.post('/api/orders/:token/cancel', (req, res) => {
  const o = loadOrder('token = ?', req.params.token);
  if (!o) return bad(res, 'Không tìm thấy đơn', 404);
  if (o.status !== 'new') return bad(res, 'Quán đã nhận đơn nên không huỷ được, bạn báo nhân viên nhé');
  db.prepare("UPDATE orders SET status = 'cancelled', updated_at = ? WHERE id = ?").run(Date.now(), o.id);
  const updated = loadOrder('id = ?', o.id);
  broadcast('order', updated);
  res.json(publicOrder(updated));
});

// ---------- owner API ----------

app.get('/api/admin/events', requireAdmin, (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 3000\n\n');
  clients.add(res);
  req.on('close', () => clients.delete(res));
});

// Orders of one day, plus every still-open order regardless of day.
app.get('/api/admin/orders', requireAdmin, (req, res) => {
  const from = parseDay(req.query.date) ?? startOfDay(Date.now());
  const orders = db.prepare(
    `SELECT * FROM orders
     WHERE (created_at >= ? AND created_at < ?) OR status IN ('new', 'preparing', 'done')
     ORDER BY created_at DESC`
  ).all(from, from + DAY);
  res.json(withItems(orders));
});

function setStatus(ids, status) {
  const now = Date.now();
  const stmt = db.prepare(
    `UPDATE orders SET status = ?, updated_at = ?, paid_at = CASE WHEN ? = 'paid' THEN ? ELSE NULL END WHERE id = ?`
  );
  db.exec('BEGIN');
  for (const id of ids) stmt.run(status, now, status, now, id);
  db.exec('COMMIT');
  const updated = withItems(db.prepare(`SELECT * FROM orders WHERE id IN (${ids.map(() => '?').join(',')})`).all(...ids));
  updated.forEach(o => broadcast('order', o));
  return updated;
}

app.patch('/api/admin/orders/:id', requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const status = req.body?.status;
  if (!STATUSES.includes(status)) return bad(res, 'Trạng thái không hợp lệ');
  if (!db.prepare('SELECT id FROM orders WHERE id = ?').get(id)) return bad(res, 'Không tìm thấy đơn', 404);
  res.json(setStatus([id], status)[0]);
});

// Settle a whole table at once: mark every given open order as paid.
app.post('/api/admin/orders/pay', requireAdmin, (req, res) => {
  const ids = (req.body?.ids || []).map(Number).filter(Number.isInteger);
  if (!ids.length || ids.length > 100) return bad(res, 'Không có đơn nào để thu tiền');
  const open = db.prepare(
    `SELECT id FROM orders WHERE id IN (${ids.map(() => '?').join(',')}) AND status IN ('new', 'preparing', 'done')`
  ).all(...ids).map(r => r.id);
  if (!open.length) return bad(res, 'Các đơn này đã được thu tiền');
  res.json(setStatus(open, 'paid'));
});

app.get('/api/admin/stats', requireAdmin, (req, res) => {
  const today = startOfDay(Date.now());
  const from = parseDay(req.query.from) ?? today;
  const to = (parseDay(req.query.to) ?? from) + DAY;
  if (to <= from || to - from > 366 * DAY) return bad(res, 'Khoảng thời gian không hợp lệ');

  const sum = db.prepare(
    `SELECT
       COALESCE(SUM(CASE WHEN status = 'paid' THEN total END), 0) AS revenue,
       COUNT(CASE WHEN status = 'paid' THEN 1 END) AS paidCount,
       COALESCE(SUM(CASE WHEN status IN ('new','preparing','done') THEN total END), 0) AS unpaid,
       COUNT(CASE WHEN status IN ('new','preparing','done') THEN 1 END) AS unpaidCount,
       COUNT(CASE WHEN status = 'cancelled' THEN 1 END) AS cancelledCount
     FROM orders WHERE created_at >= ? AND created_at < ?`
  ).get(from, to);

  const topItems = db.prepare(
    `SELECT oi.name, SUM(oi.qty) AS qty, SUM(oi.qty * oi.price) AS amount
     FROM order_items oi JOIN orders o ON o.id = oi.order_id
     WHERE o.status = 'paid' AND o.created_at >= ? AND o.created_at < ?
     GROUP BY oi.name ORDER BY amount DESC, qty DESC LIMIT 15`
  ).all(from, to);

  const byDayRows = db.prepare(
    `SELECT CAST((created_at + ?) / ? AS INTEGER) AS d, SUM(total) AS revenue, COUNT(*) AS count
     FROM orders WHERE status = 'paid' AND created_at >= ? AND created_at < ?
     GROUP BY d`
  ).all(TZ_OFFSET, DAY, from, to);
  const byDayMap = new Map(byDayRows.map(r => [r.d, r]));
  const byDay = [];
  for (let t = from; t < to; t += DAY) {
    const r = byDayMap.get(Math.floor((t + TZ_OFFSET) / DAY));
    byDay.push({ date: dayKey(t), revenue: r?.revenue || 0, count: r?.count || 0 });
  }

  res.json({ from: dayKey(from), to: dayKey(to - DAY), ...sum, topItems, byDay });
});

app.get('/api/admin/menu', requireAdmin, (req, res) => res.json(menu()));

app.post('/api/admin/items', requireAdmin, (req, res) => {
  const categoryId = Number(req.body?.categoryId);
  const name = clean(req.body?.name, 60);
  const price = Number(req.body?.price);
  if (!db.prepare('SELECT id FROM categories WHERE id = ?').get(categoryId)) return bad(res, 'Nhóm món không hợp lệ');
  if (!name) return bad(res, 'Vui lòng nhập tên món');
  if (!Number.isInteger(price) || price < 0 || price > 10_000_000) return bad(res, 'Giá không hợp lệ');
  const sort = db.prepare('SELECT COALESCE(MAX(sort), 0) + 1 AS s FROM items WHERE category_id = ?').get(categoryId).s;
  db.prepare('INSERT INTO items (category_id, name, price, sort) VALUES (?, ?, ?, ?)').run(categoryId, name, price, sort);
  res.json(menu());
});

app.patch('/api/admin/items/:id', requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const item = db.prepare('SELECT * FROM items WHERE id = ? AND deleted = 0').get(id);
  if (!item) return bad(res, 'Không tìm thấy món', 404);
  const b = req.body || {};
  const name = b.name !== undefined ? clean(b.name, 60) : item.name;
  const price = b.price !== undefined ? Number(b.price) : item.price;
  const available = b.available !== undefined ? (b.available ? 1 : 0) : item.available;
  if (!name) return bad(res, 'Vui lòng nhập tên món');
  if (!Number.isInteger(price) || price < 0 || price > 10_000_000) return bad(res, 'Giá không hợp lệ');
  db.prepare('UPDATE items SET name = ?, price = ?, available = ? WHERE id = ?').run(name, price, available, id);
  res.json(menu());
});

// Soft delete so past orders keep their history.
app.delete('/api/admin/items/:id', requireAdmin, (req, res) => {
  db.prepare('UPDATE items SET deleted = 1 WHERE id = ?').run(Number(req.params.id));
  res.json(menu());
});

app.get('/api/admin/qr.svg', requireAdmin, async (req, res) => {
  const table = clean(req.query.table, 10);
  const base = PUBLIC_URL || `${req.protocol}://${req.get('host')}`;
  const url = base + '/' + (table ? `?ban=${encodeURIComponent(table)}` : '');
  const svg = await QRCode.toString(url, {
    type: 'svg', margin: 1, errorCorrectionLevel: 'M', color: { dark: '#2f4a40', light: '#ffffff' },
  });
  res.type('image/svg+xml').set('X-QR-Url', url).send(svg);
});

app.get('/api/admin/qr-base', requireAdmin, (req, res) => {
  res.json({ base: PUBLIC_URL || `${req.protocol}://${req.get('host')}` });
});

app.use('/api', (req, res) => bad(res, 'Không tìm thấy', 404));

app.use((err, req, res, next) => {
  console.error(err);
  bad(res, 'Có lỗi xảy ra, vui lòng thử lại', 500);
});

app.listen(PORT, () => {
  console.log(`Bon đang chạy tại http://localhost:${PORT}`);
  console.log(`Trang chủ quán:   http://localhost:${PORT}/admin`);
  if (!process.env.ADMIN_PASSWORD) console.warn('⚠ Đang dùng mật khẩu mặc định "bon123" — hãy đặt biến ADMIN_PASSWORD khi chạy thật.');
});

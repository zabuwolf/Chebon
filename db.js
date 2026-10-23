const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new DatabaseSync(path.join(DATA_DIR, 'bon.db'));
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS categories (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    sort INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS items (
    id INTEGER PRIMARY KEY,
    category_id INTEGER NOT NULL REFERENCES categories(id),
    name TEXT NOT NULL,
    price INTEGER NOT NULL,
    available INTEGER NOT NULL DEFAULT 1,
    deleted INTEGER NOT NULL DEFAULT 0,
    sort INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS orders (
    id INTEGER PRIMARY KEY,
    token TEXT NOT NULL UNIQUE,
    code INTEGER NOT NULL,
    table_no TEXT NOT NULL DEFAULT '',
    customer_name TEXT NOT NULL,
    phone TEXT NOT NULL,
    note TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'new',
    total INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    paid_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_orders_created ON orders(created_at);
  CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);

  CREATE TABLE IF NOT EXISTS order_items (
    id INTEGER PRIMARY KEY,
    order_id INTEGER NOT NULL REFERENCES orders(id),
    item_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    price INTEGER NOT NULL,
    qty INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_order_items_order ON order_items(order_id);
`);

// Seed the menu from the printed menu board on first run.
const MENU = [
  ['Chè', [
    ['Chè Thập Cẩm', 25], ['Chè Đậu Xanh', 25], ['Chè Đậu Đỏ', 25], ['Chè Hạt Sen', 25],
    ['Chè Bưởi', 25], ['Chè Ngô', 25], ['Chè Thái', 25], ['Chè Thái Caramen', 25],
    ['Chè Thái Thập Cẩm', 25],
  ]],
  ['Tào Phớ', [
    ['Tào Phớ Nước Đường', 15], ['Tào Phớ Sữa Đậu', 15], ['Tào Phớ Bưởi', 20],
    ['Tào Phớ Đậu Đỏ', 20], ['Tào Phớ Đậu Xanh', 20], ['Tào Phớ Hạt Sen', 20],
    ['Tào Phớ Caramen', 20], ['Tào Phớ Thập Cẩm', 20],
  ]],
  ['Caramen', [['Caramen Bưởi', 20], ['Caramen Cốt Dừa', 20], ['Caramen Sương Sáo', 20]]],
  ['Sữa Chua', [['Sữa Chua Caramen', 20], ['Sữa Chua Thạch Trân Châu', 20]]],
  ['Mùa Đông', [
    ['Bánh Trôi Tàu', 20], ['Chè Đỗ Đen Nóng', 20], ['Chè Mochi Cốm', 25], ['Chè Mochi Sắn', 25],
  ]],
  ['Đồ Ăn Vặt', [['Nem Chua Rán (x5)', 35], ['Khoai Tây Chiên', 30]]],
  ['Topping', [['Khúc Bạch Chân Mèo', 10], ['Khúc Bạch Pho Mai', 10]]],
];

if (db.prepare('SELECT COUNT(*) AS n FROM categories').get().n === 0) {
  const insCat = db.prepare('INSERT INTO categories (name, sort) VALUES (?, ?)');
  const insItem = db.prepare('INSERT INTO items (category_id, name, price, sort) VALUES (?, ?, ?, ?)');
  db.exec('BEGIN');
  MENU.forEach(([cat, items], ci) => {
    const catId = insCat.run(cat, ci).lastInsertRowid;
    items.forEach(([name, k], ii) => insItem.run(catId, name, k * 1000, ii));
  });
  db.exec('COMMIT');
}

module.exports = db;

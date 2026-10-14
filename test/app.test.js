import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { open } from '../src/db.js';
import { createApp } from '../src/app.js';

let server, base, db;
before(async () => {
  db = open(':memory:');
  const dir = new URL('../migrations/', import.meta.url);
  for (const f of readdirSync(dir).filter((f) => f.endsWith('.up.sql')).sort())
    db.exec(readFileSync(new URL(f, dir), 'utf8'));          // every migration, in order
  db.exec("INSERT INTO menu_items (name, price) VALUES ('Phở bò', 45.5), ('Trà đá', 5)");
  server = createApp(db).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://localhost:${server.address().port}`;
});
after(() => server.close());

const call = async (method, path, body) => {
  const res = await fetch(base + path, { method, headers: { 'content-type': 'application/json' }, body: body && JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
};

// both stored columns, straight from the DB (spread: node:sqlite rows have a null prototype)
const stored = (id) => ({ ...db.prepare('SELECT price, price_vnd FROM menu_items WHERE id = ?').get(id) });

test('GET /menu/:id returns price in thousands of dong and priceVnd in dong', async () => {
  assert.deepEqual(await call('GET', '/menu/1'), { status: 200, body: { id: 1, name: 'Phở bò', price: 45.5, priceVnd: 45500 } });
});

test('PATCH /menu/:id changes the price', async () => {
  const r = await call('PATCH', '/menu/2', { price: 6 });
  assert.equal(r.status, 200);
  assert.equal(r.body.price, 6);
});

test('POST /orders totals at the current price', async () => {
  const r = await call('POST', '/orders', { items: [{ menuItemId: 1, qty: 2 }, { menuItemId: 2, qty: 1 }] });
  assert.deepEqual(r, { status: 201, body: { id: 1, total: 97 } });
});

test('errors have one shape', async () => {
  assert.deepEqual((await call('GET', '/menu/999')).body.error, 'not_found');
  assert.equal((await call('PATCH', '/menu/1', { price: -1 })).status, 400);
});

// The tests below create their own items so the order total above stays put.

test('POST /menu with price writes both columns', async () => {
  const r = await call('POST', '/menu', { name: 'Bún chả', price: 40.5 });
  assert.equal(r.status, 201);
  assert.equal(r.body.price, 40.5);
  assert.equal(r.body.priceVnd, 40500);
  assert.deepEqual(stored(r.body.id), { price: 40.5, price_vnd: 40500 });
});

test('POST /menu with priceVnd writes both columns', async () => {
  const r = await call('POST', '/menu', { name: 'Cà phê sữa', priceVnd: 25000 });
  assert.equal(r.status, 201);
  assert.equal(r.body.price, 25);
  assert.equal(r.body.priceVnd, 25000);
  assert.deepEqual(stored(r.body.id), { price: 25, price_vnd: 25000 });
});

test('PATCH /menu/:id with price writes both columns', async () => {
  const { body: { id } } = await call('POST', '/menu', { name: 'Bánh mì', price: 20 });
  const r = await call('PATCH', `/menu/${id}`, { price: 22.5 });
  assert.equal(r.status, 200);
  assert.equal(r.body.priceVnd, 22500);
  assert.deepEqual(stored(id), { price: 22.5, price_vnd: 22500 });
});

test('PATCH /menu/:id with priceVnd writes both columns', async () => {
  const { body: { id } } = await call('POST', '/menu', { name: 'Chè', price: 15 });
  const r = await call('PATCH', `/menu/${id}`, { priceVnd: 17500 });
  assert.equal(r.status, 200);
  assert.equal(r.body.price, 17.5);
  assert.deepEqual(stored(id), { price: 17.5, price_vnd: 17500 });
});

test('priceVnd must be an integer', async () => {
  const post = await call('POST', '/menu', { name: 'Xôi', priceVnd: 15000.5 });
  assert.equal(post.status, 400);
  assert.equal(post.body.error, 'invalid_body');
  const patch = await call('PATCH', '/menu/1', { priceVnd: 45500.5 });
  assert.equal(patch.status, 400);
  assert.deepEqual(stored(1), { price: 45.5, price_vnd: null });   // untouched
});

test('price and priceVnd must agree when both are sent', async () => {
  assert.equal((await call('PATCH', '/menu/1', { price: 45.5, priceVnd: 45000 })).status, 400);
  assert.equal((await call('POST', '/menu', { name: 'Gỏi cuốn', price: 30, priceVnd: 30000 })).status, 201);
});

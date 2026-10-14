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
  // price_vnd only: menu_items.price is about to be dropped
  db.exec("INSERT INTO menu_items (name, price_vnd) VALUES ('Phở bò', 45500), ('Trà đá', 5000)");
  server = createApp(db).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://localhost:${server.address().port}`;
});
after(() => server.close());

const call = async (method, path, body) => {
  const res = await fetch(base + path, { method, headers: { 'content-type': 'application/json' }, body: body && JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
};

// price_vnd straight from the DB. Never select price here: a later migration drops it.
const storedVnd = (id) => db.prepare('SELECT price_vnd FROM menu_items WHERE id = ?').get(id).price_vnd;

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

test('POST /menu with price writes price_vnd', async () => {
  const r = await call('POST', '/menu', { name: 'Bún chả', price: 40.5 });
  assert.equal(r.status, 201);
  assert.equal(r.body.price, 40.5);
  assert.equal(r.body.priceVnd, 40500);
  assert.equal(storedVnd(r.body.id), 40500);
});

test('POST /menu with priceVnd writes price_vnd', async () => {
  const r = await call('POST', '/menu', { name: 'Cà phê sữa', priceVnd: 25000 });
  assert.equal(r.status, 201);
  assert.equal(r.body.price, 25);
  assert.equal(r.body.priceVnd, 25000);
  assert.equal(storedVnd(r.body.id), 25000);
});

test('PATCH /menu/:id with price writes price_vnd', async () => {
  const { body: { id } } = await call('POST', '/menu', { name: 'Bánh mì', price: 20 });
  const r = await call('PATCH', `/menu/${id}`, { price: 22.5 });
  assert.equal(r.status, 200);
  assert.equal(r.body.priceVnd, 22500);
  assert.equal(storedVnd(id), 22500);
});

test('PATCH /menu/:id with priceVnd writes price_vnd', async () => {
  const { body: { id } } = await call('POST', '/menu', { name: 'Chè', price: 15 });
  const r = await call('PATCH', `/menu/${id}`, { priceVnd: 17500 });
  assert.equal(r.status, 200);
  assert.equal(r.body.price, 17.5);
  assert.equal(storedVnd(id), 17500);
});

test('priceVnd must be an integer', async () => {
  const post = await call('POST', '/menu', { name: 'Xôi', priceVnd: 15000.5 });
  assert.equal(post.status, 400);
  assert.equal(post.body.error, 'invalid_body');
  const patch = await call('PATCH', '/menu/1', { priceVnd: 45500.5 });
  assert.equal(patch.status, 400);
  assert.equal(storedVnd(1), 45500);   // untouched
});

test('price and priceVnd must agree when both are sent', async () => {
  assert.equal((await call('PATCH', '/menu/1', { price: 45.5, priceVnd: 45000 })).status, 400);
  assert.equal((await call('POST', '/menu', { name: 'Gỏi cuốn', price: 30, priceVnd: 30000 })).status, 201);
});

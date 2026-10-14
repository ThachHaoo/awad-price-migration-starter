// Backfill menu_items.price_vnd from price, in small batches.
//
// Run this ONLY once every running instance is v2. A v1 instance still writes
// price alone: any row it creates or PATCHes after this script has passed it
// ends up with price_vnd NULL or stale, and nothing would come back for it.
// Check with scripts/check.js afterwards (disagree = 0, price_vnd_null = 0).
//
// Why the condition is not just `price_vnd IS NULL`: a row can have a price_vnd
// that is set but wrong. If v1 ran again after v2 (a rollback, or a mixed
// deploy), its PATCH changed price and left the old price_vnd behind. Matching
// "NULL or disagrees with price" repairs those rows too, and makes the script
// safe to re-run: a row it has fixed no longer matches, so the loop ends.
//
// Each batch is its own BEGIN IMMEDIATE ... COMMIT, so the write lock is held
// for one batch only and live v2 writes get in between batches.
//
//   BATCH=500 PAUSE_MS=50 node scripts/backfill.js
//
// Ctrl+C stops after the batch in progress; press it twice to quit at once
// (the open transaction is rolled back by SQLite).
import { setTimeout as sleep } from 'node:timers/promises';
import { open } from '../src/db.js';

const positiveInt = (name, fallback) => {
  const n = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(n) || n < 0 || (name === 'BATCH' && n === 0)) {
    console.error(`${name} must be a ${name === 'BATCH' ? 'positive' : 'non-negative'} integer, got ${process.env[name]}`);
    process.exit(2);
  }
  return n;
};
const BATCH = positiveInt('BATCH', 500);
const PAUSE_MS = positiveInt('PAUSE_MS', 50);

const PENDING = 'price IS NOT NULL AND (price_vnd IS NULL OR price_vnd <> CAST(round(price * 1000) AS INTEGER))';

const db = open();
const remaining = db.prepare(`SELECT count(*) n FROM menu_items WHERE ${PENDING}`);
const update = db.prepare(`
  UPDATE menu_items SET price_vnd = CAST(round(price * 1000) AS INTEGER)
  WHERE id IN (SELECT id FROM menu_items WHERE ${PENDING} LIMIT ?)`);

let stopping = false;
process.on('SIGINT', () => {
  if (stopping) process.exit(130);
  stopping = true;
  console.log('\nSIGINT: stopping after the current batch (Ctrl+C again to quit now)');
});

console.log(`rows to backfill: ${remaining.get().n} (batch ${BATCH}, pause ${PAUSE_MS} ms)`);

const started = Date.now();
let total = 0;
let batches = 0;
let finished = false;
while (!stopping) {
  db.exec('BEGIN IMMEDIATE');
  let changes;
  try {
    changes = Number(update.run(BATCH).changes);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    console.error(`batch ${batches + 1} failed and was rolled back: ${e.message}`);
    console.error(`done before the failure: ${total} rows in ${batches} batches`);
    process.exit(1);
  }
  if (changes === 0) { finished = true; break; }
  total += changes;
  batches += 1;
  if (!stopping) await sleep(PAUSE_MS);
}

const seconds = ((Date.now() - started) / 1000).toFixed(1);
console.log(`updated ${total} rows in ${batches} batches, ${seconds} s`);
if (!finished) {
  console.log(`STOPPED PART-WAY: ${remaining.get().n} rows still need price_vnd; run again to finish`);
  process.exit(130);
}
console.log('done: no rows left to backfill');

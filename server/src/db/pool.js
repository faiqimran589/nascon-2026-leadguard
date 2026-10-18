// One shared connection pool to PostgreSQL (Neon in production) plus small helpers.
import pg from 'pg';
import { config } from '../config.js';

// Return numeric/bigint columns as JS numbers (amounts here are far below 2^53).
pg.types.setTypeParser(1700, (v) => (v === null ? null : Number(v))); // numeric
pg.types.setTypeParser(20, (v) => (v === null ? null : Number(v)));   // bigint / count(*)
// Return DATE columns as plain 'YYYY-MM-DD' strings (no time-zone shifting).
pg.types.setTypeParser(1082, (v) => v);

export const pool = new pg.Pool({
  connectionString: config.databaseUrl,
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 15_000,
});

pool.on('error', (err) => {
  // Neon closes idle connections when it scales to zero; the pool reconnects on the next query.
  console.error('[db] idle client error:', err.message);
});

export function query(text, params) {
  return pool.query(text, params);
}

export async function one(text, params) {
  const { rows } = await pool.query(text, params);
  return rows[0] || null;
}

// Run fn(client) inside a transaction. Rolls back on any error.
export async function tx(fn) {
  const client = await pool.connect();
  client.afterCommit = [];
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    for (const cb of client.afterCommit) { try { cb(); } catch (e) { console.error('[afterCommit]', e); } }
    return result;
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* ignore */ }
    throw err;
  } finally {
    client.afterCommit = null;
    client.release();
  }
}

// Run cb once the surrounding transaction commits (or right away when not in a transaction).
export function onCommit(db, cb) {
  if (db && Array.isArray(db.afterCommit)) db.afterCommit.push(cb);
  else setImmediate(cb);
}

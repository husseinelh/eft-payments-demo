import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * better-sqlite3 is a SYNCHRONOUS native binding — no async/await, no callbacks.
 * `db.prepare(sql).get()` returns the row immediately, the way an ADO.NET
 * ExecuteScalar would. Calls block the event loop for microseconds, which is
 * the right trade for an embedded file database.
 */

// ESM has no __dirname, so it gets derived from import.meta.url.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_PATH = path.join(DATA_DIR, 'eft.db');

fs.mkdirSync(DATA_DIR, { recursive: true });

export const db = new Database(DB_PATH);

// WAL improves concurrent read behaviour; foreign_keys is OFF by default in
// SQLite and has to be enabled per-connection for the REFERENCES clause to bite.
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

/**
 * Schema. `IF NOT EXISTS` keeps this idempotent, so it runs safely on every boot.
 *
 * Two deliberate choices:
 *  - amountCents is an INTEGER. Money as a float can't represent 0.10 + 0.20
 *    exactly, and the EFT trailer check is an equality test on a sum — so cents
 *    keep it exact. Same reasoning as decimal over double in C#.
 *  - payments.id IS the itemTraceNumber. One identity for a payment means the
 *    bank-return matching can never drift onto a different key.
 */
db.exec(`
  CREATE TABLE IF NOT EXISTS payments (
    id            TEXT PRIMARY KEY,
    customerName  TEXT    NOT NULL,
    amountCents   INTEGER NOT NULL CHECK(amountCents > 0),
    accountNumber TEXT    NOT NULL,
    status        TEXT    NOT NULL CHECK(status IN ('Pending','Sent','Success','Failed')),
    createdAt     TEXT    NOT NULL,
    processedAt   TEXT
  );

  CREATE TABLE IF NOT EXISTS payment_history (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    paymentId TEXT NOT NULL REFERENCES payments(id),
    oldStatus TEXT,
    newStatus TEXT NOT NULL,
    timestamp TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_history_payment ON payment_history(paymentId);
  CREATE INDEX IF NOT EXISTS idx_payments_status ON payments(status);

  -- Single-row counter backing the itemTraceNumber sequence.
  CREATE TABLE IF NOT EXISTS counters (
    name  TEXT PRIMARY KEY,
    value INTEGER NOT NULL
  );
`);

db.prepare(`INSERT OR IGNORE INTO counters (name, value) VALUES ('itemTraceNumber', 0)`).run();

/**
 * Allocates the next itemTraceNumber, e.g. ITM-000000042.
 *
 * UPDATE ... RETURNING makes the read-modify-write a single atomic statement,
 * so two callers can never be handed the same number.
 */
export function nextItemTraceNumber() {
  const { value } = db
    .prepare(`UPDATE counters SET value = value + 1 WHERE name = 'itemTraceNumber' RETURNING value`)
    .get();
  return `ITM-${String(value).padStart(9, '0')}`;
}

/** Mock account number — deterministic-looking filler, never used for matching. */
export function generateAccountNumber() {
  return String(Math.floor(1_000_000_000 + Math.random() * 8_999_999_999));
}

/** ISO-8601 UTC. Stored as TEXT since SQLite has no native date type. */
export function isoNow() {
  return new Date().toISOString();
}

function isoMinutesAgo(minutes) {
  return new Date(Date.now() - minutes * 60_000).toISOString();
}

/**
 * Seeds sample data on first run only, so the ledger is populated immediately.
 *
 * History rows are written to match each payment's status, so expanding a
 * seeded "Success" row shows a real Pending -> Sent -> Success chain rather
 * than an empty panel.
 */
export function seedIfEmpty() {
  const { count } = db.prepare('SELECT COUNT(*) AS count FROM payments').get();
  if (count > 0) return false;

  // [customerName, amount, finalStatus, minutesAgoCreated]
  const samples = [
    ['Northwind Traders', 1250.0, 'Pending', 12],
    ['Contoso Property Mgmt', 89.99, 'Pending', 34],
    ['Fabrikam Facilities', 4300.5, 'Pending', 58],
    ['Adventure Works Ltd', 275.25, 'Sent', 96],
    ['Tailspin Maintenance', 1899.0, 'Success', 260],
    ['Wide World Cleaning', 640.75, 'Success', 320],
    ['Litware Security Inc', 3120.4, 'Failed', 415],
  ];

  const insertPayment = db.prepare(`
    INSERT INTO payments (id, customerName, amountCents, accountNumber, status, createdAt, processedAt)
    VALUES (@id, @customerName, @amountCents, @accountNumber, @status, @createdAt, @processedAt)
  `);
  const insertHistory = db.prepare(`
    INSERT INTO payment_history (paymentId, oldStatus, newStatus, timestamp)
    VALUES (?, ?, ?, ?)
  `);

  // The whole seed is one transaction: a partially seeded database would be
  // worse than an empty one.
  const seed = db.transaction(() => {
    for (const [customerName, amount, status, createdMinsAgo] of samples) {
      const id = nextItemTraceNumber();
      const createdAt = isoMinutesAgo(createdMinsAgo);

      // Walk the real lifecycle so history mirrors how the row got here.
      const chain = ['Pending'];
      if (status !== 'Pending') chain.push('Sent');
      if (status === 'Success' || status === 'Failed') chain.push(status);

      const isFinal = status === 'Success' || status === 'Failed';
      const processedAt = isFinal ? isoMinutesAgo(createdMinsAgo - 8) : null;

      insertPayment.run({
        id,
        customerName,
        amountCents: Math.round(amount * 100),
        accountNumber: generateAccountNumber(),
        status,
        createdAt,
        processedAt,
      });

      let previous = null;
      chain.forEach((newStatus, i) => {
        // Space the history entries a few minutes apart for a realistic trail.
        const at = isoMinutesAgo(createdMinsAgo - i * 4);
        insertHistory.run(id, previous, newStatus, at);
        previous = newStatus;
      });
    }
  });

  seed();
  return true;
}

export { DB_PATH };

import { db, nextItemTraceNumber, generateAccountNumber, isoNow } from './db.js';

/**
 * All SQL for payments lives here. Routes never touch the database directly —
 * roughly the role a repository class plays in a C# project.
 *
 * The important design rule: every status change goes through changeStatus(),
 * which writes the payment_history row in the same transaction as the update.
 * That makes "log to history on every status change" a structural guarantee
 * rather than a convention each call site has to remember.
 */

const FINAL_STATUSES = new Set(['Success', 'Failed']);

// ---------------------------------------------------------------------------
// Prepared statements. Compiled once at import and reused — faster, and the
// parameter binding makes SQL injection impossible.
// ---------------------------------------------------------------------------

const stmts = {
  selectAll: db.prepare(`SELECT * FROM payments ORDER BY datetime(createdAt) DESC, id DESC`),
  selectById: db.prepare(`SELECT * FROM payments WHERE id = ?`),
  selectByStatus: db.prepare(
    `SELECT * FROM payments WHERE status = ? ORDER BY datetime(createdAt) ASC, id ASC`
  ),
  insertPayment: db.prepare(`
    INSERT INTO payments (id, customerName, amountCents, accountNumber, status, createdAt, processedAt)
    VALUES (@id, @customerName, @amountCents, @accountNumber, 'Pending', @createdAt, NULL)
  `),
  updateStatus: db.prepare(`UPDATE payments SET status = ?, processedAt = ? WHERE id = ?`),
  insertHistory: db.prepare(`
    INSERT INTO payment_history (paymentId, oldStatus, newStatus, timestamp)
    VALUES (?, ?, ?, ?)
  `),
  selectHistory: db.prepare(`
    SELECT id, paymentId, oldStatus, newStatus, timestamp
    FROM payment_history WHERE paymentId = ? ORDER BY id ASC
  `),
};

// ---------------------------------------------------------------------------
// Mapping
// ---------------------------------------------------------------------------

/**
 * Converts a database row into the shape the API exposes: cents back to a
 * decimal, and the id surfaced under its domain name as well.
 */
function toApiShape(row) {
  if (!row) return null;
  return {
    id: row.id,
    itemTraceNumber: row.id, // same value — the id IS the trace number
    customerName: row.customerName,
    amount: row.amountCents / 100,
    accountNumber: row.accountNumber,
    status: row.status,
    createdAt: row.createdAt,
    processedAt: row.processedAt,
  };
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export function listPayments() {
  return stmts.selectAll.all().map(toApiShape);
}

export function getPaymentById(id) {
  return toApiShape(stmts.selectById.get(id));
}

/** Raw rows (cents intact) — the batch builder needs exact integer amounts. */
export function getPendingPaymentRows() {
  return stmts.selectByStatus.all('Pending');
}

/** Trace numbers of payments still in flight, used for restart recovery. */
export function getSentPaymentIds() {
  return stmts.selectByStatus.all('Sent').map((row) => row.id);
}

export function getPaymentHistory(paymentId) {
  return stmts.selectHistory.all(paymentId);
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

/**
 * THE status-change choke point.
 *
 * db.transaction(fn) wraps fn in BEGIN/COMMIT and rolls back automatically if
 * fn throws. Nested calls are handled with SAVEPOINTs, so this composes safely
 * inside the wider batch transaction below.
 *
 * Returns false when the payment is missing or already in the target status,
 * which makes repeated calls harmless (idempotent).
 */
export const changeStatus = db.transaction((paymentId, newStatus, expectedCurrentStatus = null) => {
  const row = stmts.selectById.get(paymentId);
  if (!row) return false;
  if (row.status === newStatus) return false;

  // Optimistic guard: refuse the change if the row moved on since we looked.
  // Stops a late or duplicated bank return from resurrecting a finalised payment.
  if (expectedCurrentStatus !== null && row.status !== expectedCurrentStatus) return false;

  const timestamp = isoNow();
  const processedAt = FINAL_STATUSES.has(newStatus) ? timestamp : row.processedAt;

  stmts.updateStatus.run(newStatus, processedAt, paymentId);
  stmts.insertHistory.run(paymentId, row.status, newStatus, timestamp);
  return true;
});

/** Creates a Pending payment plus its opening history row, atomically. */
export const createPayment = db.transaction(({ customerName, amount }) => {
  const id = nextItemTraceNumber();
  const createdAt = isoNow();

  stmts.insertPayment.run({
    id,
    customerName,
    amountCents: Math.round(amount * 100),
    accountNumber: generateAccountNumber(),
    createdAt,
  });
  // oldStatus is NULL — the row came into existence as Pending.
  stmts.insertHistory.run(id, null, 'Pending', createdAt);

  return toApiShape(stmts.selectById.get(id));
});

/**
 * Event 1's all-or-nothing update.
 *
 * Every payment in the batch flips to Sent inside ONE transaction. If any single
 * update throws, SQLite rolls the whole thing back — so the batch can never be
 * half-sent, leaving no payment stranded in a state the bank never heard about.
 */
export const markBatchAsSent = db.transaction((paymentIds) => {
  let updated = 0;
  for (const id of paymentIds) {
    const ok = changeStatus(id, 'Sent', 'Pending');
    if (!ok) {
      // A payment that was Pending when the file was built is no longer Pending.
      // Throwing here rolls back every update in this transaction.
      throw new Error(`Payment ${id} was not in Pending status at batch time — batch rolled back`);
    }
    updated += 1;
  }
  return updated;
});

/** Applies a bank result. Only transitions payments currently in Sent. */
export function finalisePayment(paymentId, newStatus) {
  return changeStatus(paymentId, newStatus, 'Sent');
}

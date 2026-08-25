import { db, nextItemTraceNumber, generateAccountNumber, isoNow } from './db.js';
import { getSqlPool, sql } from './sqlDb.js';

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

export async function listPayments() {
  const pool = await getSqlPool();

  const result = await pool.request().query(`
    SELECT *
    FROM dbo.payments
    ORDER BY createdAt DESC, id DESC
  `);

  return result.recordset.map(toApiShape);
}

export async function getPaymentById(id) {
  const pool = await getSqlPool();

  const result = await pool.request()
    .input('id', sql.NVarChar(32), id)
    .query(`
      SELECT *
      FROM dbo.payments
      WHERE id = @id
    `);

  return toApiShape(result.recordset[0]);
}

export async function getPendingPaymentRows() {
  const pool = await getSqlPool();

  const result = await pool.request()
    .input('status', sql.NVarChar(20), 'Pending')
    .query(`
      SELECT *
      FROM dbo.payments
      WHERE status = @status
      ORDER BY createdAt ASC, id ASC
    `);

  return result.recordset.map((row) => ({
    ...row,
    amountCents: Number(row.amountCents),
  }));
}

export async function getSentPaymentIds() {
  const pool = await getSqlPool();

  const result = await pool.request()
    .input('status', sql.NVarChar(20), 'Sent')
    .query(`
      SELECT *
      FROM dbo.payments
      WHERE status = @status
      ORDER BY createdAt ASC, id ASC
    `);

  return result.recordset.map((row) => row.id);
}

export async function getPaymentHistory(paymentId) {
  const pool = await getSqlPool();

  const result = await pool.request()
    .input('paymentId', sql.NVarChar(32), paymentId)
    .query(`
      SELECT id, paymentId, oldStatus, newStatus, [timestamp]
      FROM dbo.payment_history
      WHERE paymentId = @paymentId
      ORDER BY id ASC
    `);

  return result.recordset;
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
async function changeStatusInTransaction(
  transaction,
  paymentId,
  newStatus,
  expectedCurrentStatus = null
) {
  const timestamp = new Date();
  const isFinal = FINAL_STATUSES.has(newStatus);

  const result = await new sql.Request(transaction)
    .input('paymentId', sql.NVarChar(32), paymentId)
    .input('newStatus', sql.NVarChar(20), newStatus)
    .input('expectedCurrentStatus', sql.NVarChar(20), expectedCurrentStatus)
    .input('timestamp', sql.DateTime2(3), timestamp)
    .input('isFinal', sql.Bit, isFinal)
    .query(`
      UPDATE dbo.payments
      SET
        status = @newStatus,
        processedAt =
          CASE
            WHEN @isFinal = 1 THEN @timestamp
            ELSE processedAt
          END
      OUTPUT DELETED.status AS oldStatus
      WHERE id = @paymentId
        AND status <> @newStatus
        AND (
          @expectedCurrentStatus IS NULL
          OR status = @expectedCurrentStatus
        )
    `);

  if (result.recordset.length === 0) {
    return false;
  }

  const oldStatus = result.recordset[0].oldStatus;

  await new sql.Request(transaction)
    .input('paymentId', sql.NVarChar(32), paymentId)
    .input('oldStatus', sql.NVarChar(20), oldStatus)
    .input('newStatus', sql.NVarChar(20), newStatus)
    .input('timestamp', sql.DateTime2(3), timestamp)
    .query(`
      INSERT INTO dbo.payment_history
        (paymentId, oldStatus, newStatus, [timestamp])
      VALUES
        (@paymentId, @oldStatus, @newStatus, @timestamp)
    `);

  return true;
}

export async function changeStatus(
  paymentId,
  newStatus,
  expectedCurrentStatus = null
) {
  const pool = await getSqlPool();
  const transaction = new sql.Transaction(pool);

  await transaction.begin();

  try {
    const changed = await changeStatusInTransaction(
      transaction,
      paymentId,
      newStatus,
      expectedCurrentStatus
    );

    await transaction.commit();
    return changed;
  } catch (error) {
    await transaction.rollback();
    throw error;
  }
}

/** Creates a Pending payment plus its opening history row, atomically. */
export async function createPayment({ customerName, amount }) {
  const pool = await getSqlPool();
  const transaction = new sql.Transaction(pool);

  await transaction.begin();

  try {
    const counterResult = await new sql.Request(transaction).query(`
      UPDATE dbo.counters
      SET value = value + 1
      OUTPUT INSERTED.value
      WHERE name = 'itemTraceNumber'
    `);

    const traceNumber = counterResult.recordset[0].value;
    const id = `ITM-${String(traceNumber).padStart(9, '0')}`;

    const createdAt = new Date();

    const paymentResult = await new sql.Request(transaction)
      .input('id', sql.NVarChar(32), id)
      .input('customerName', sql.NVarChar(200), customerName)
      .input('amountCents', sql.BigInt, Math.round(amount * 100))
      .input('accountNumber', sql.NVarChar(32), generateAccountNumber())
      .input('createdAt', sql.DateTime2(3), createdAt)
      .query(`
        INSERT INTO dbo.payments
          (id, customerName, amountCents, accountNumber, status, createdAt, processedAt)
        OUTPUT INSERTED.*
        VALUES
          (@id, @customerName, @amountCents, @accountNumber, 'Pending', @createdAt, NULL)
      `);

    await new sql.Request(transaction)
      .input('paymentId', sql.NVarChar(32), id)
      .input('timestamp', sql.DateTime2(3), createdAt)
      .query(`
        INSERT INTO dbo.payment_history
          (paymentId, oldStatus, newStatus, [timestamp])
        VALUES
          (@paymentId, NULL, 'Pending', @timestamp)
      `);

    await transaction.commit();

    return toApiShape(paymentResult.recordset[0]);
  } catch (error) {
    await transaction.rollback();
    throw error;
  }
}

/**
 * Event 1's all-or-nothing update.
 *
 * Every payment in the batch flips to Sent inside ONE transaction. If any single
 * update throws, SQLite rolls the whole thing back — so the batch can never be
 * half-sent, leaving no payment stranded in a state the bank never heard about.
 */
export async function markBatchAsSent(paymentIds) {
  const pool = await getSqlPool();
  const transaction = new sql.Transaction(pool);

  await transaction.begin();

  try {
    let updated = 0;

    for (const id of paymentIds) {
      const ok = await changeStatusInTransaction(
        transaction,
        id,
        'Sent',
        'Pending'
      );

      if (!ok) {
        throw new Error(
          `Payment ${id} was not in Pending status at batch time — batch rolled back`
        );
      }

      updated += 1;
    }

    await transaction.commit();
    return updated;
  } catch (error) {
    await transaction.rollback();
    throw error;
  }
}

/** Applies a bank result. Only transitions payments currently in Sent. */
export function finalisePayment(paymentId, newStatus) {
  return changeStatus(paymentId, newStatus, 'Sent');
}

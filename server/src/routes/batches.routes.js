import { Router } from 'express';

import { getPendingPaymentRows, markBatchAsSent } from '../payments.repo.js';
import { buildEftFile, EftValidationError } from '../eftFile.js';
import { scheduleBankReturn } from '../bankReturn.js';

export const batchesRouter = Router();

/**
 * EVENT 1 — Generate & Send Batch.  POST /api/batches/generate
 *
 * Sequence, and the order matters:
 *   1. Read every Pending payment.
 *   2. Bail out clearly if there are none — never emit an empty file.
 *   3. Build the EFT file text, which self-validates its trailer totals.
 *   4. ONLY THEN flip every payment to Sent, in a single transaction.
 *   5. Schedule the bank return and respond immediately.
 *
 * Validation sits before the database write on purpose: a file that fails its
 * own checks must leave every payment untouched and still Pending.
 */
batchesRouter.post('/generate', (req, res) => {
  const pendingRows = getPendingPaymentRows();

  if (pendingRows.length === 0) {
    // 409 Conflict: the request is well-formed, the system state just doesn't
    // permit it. The UI surfaces this message instead of opening the modal.
    return res.status(409).json({
      error: 'No pending payments to send. Add a payment first, then generate a batch.',
      batchCount: 0,
    });
  }

  let eft;
  try {
    eft = buildEftFile(pendingRows);
  } catch (err) {
    if (err instanceof EftValidationError) {
      console.error(`  EFT validation FAILED — nothing marked as Sent: ${err.message}`);
      return res.status(500).json({ error: `EFT file validation failed: ${err.message}` });
    }
    throw err;
  }

  // All-or-nothing. Throws (and rolls back every row) if any payment is no
  // longer Pending — e.g. two batch requests racing each other.
  try {
    markBatchAsSent(eft.itemTraceNumbers);
  } catch (err) {
    console.error(`  Batch transaction ROLLED BACK: ${err.message}`);
    return res.status(409).json({
      error: `Batch could not be committed and was rolled back: ${err.message}`,
    });
  }

  console.log(
    `  [EVENT 1] Batch ${eft.fileId} generated — ${eft.batchCount} payment(s), ` +
      `$${eft.totalAmount.toFixed(2)} total, all marked Sent`
  );

  // Fire-and-forget. Returns instantly; the bank return happens 20-30s later,
  // long after this HTTP response has reached the browser.
  scheduleBankReturn(eft.fileId, eft.itemTraceNumbers);

  res.status(201).json({
    fileId: eft.fileId,
    fileName: eft.fileName,
    content: eft.content,
    creationDate: eft.creationDate,
    batchCount: eft.batchCount,
    totalAmount: eft.totalAmount,
    itemTraceNumbers: eft.itemTraceNumbers,
  });
});

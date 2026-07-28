import { Router } from 'express';
import { BANK_SUCCESS_RATE } from '../config.js';

/**
 * THE MOCK BANK — a stand-in for an external system, reachable over real HTTP.
 *
 * It deliberately knows nothing about our database, our payments, or banking
 * logic. It receives a list of itemTraceNumbers, flips a weighted coin for each
 * one, and echoes the SAME trace number back beside the result.
 *
 * Note what it is NOT given: no amount, no customer name, no date. That is the
 * point — it makes matching the returns by anything other than the trace number
 * literally impossible, which is how real EFT return files work.
 */
export const mockBankRouter = Router();

/** Return codes on failure. NSF dominates in reality, so it dominates here. */
const FAILURE_CODES = [
  { code: 'NSF', description: 'Insufficient funds', weight: 70 },
  { code: 'ACCT_CLOSED', description: 'Account closed', weight: 20 },
  { code: 'INVALID_ACCT', description: 'Invalid account number', weight: 10 },
];

function pickFailureCode() {
  const total = FAILURE_CODES.reduce((sum, f) => sum + f.weight, 0);
  let roll = Math.random() * total;
  for (const failure of FAILURE_CODES) {
    roll -= failure.weight;
    if (roll <= 0) return failure;
  }
  return FAILURE_CODES[0];
}

/**
 * POST /api/mock-bank/process
 *
 * Request:  { fileId, items: [{ itemTraceNumber }, ...] }
 * Response: { fileId, processedAt, results: [{ itemTraceNumber, status, returnCode, description }] }
 */
mockBankRouter.post('/process', (req, res) => {
  const { fileId, items } = req.body ?? {};

  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'items must be a non-empty array' });
  }

  const results = [];
  for (const item of items) {
    const itemTraceNumber = item?.itemTraceNumber;
    if (typeof itemTraceNumber !== 'string' || !itemTraceNumber) {
      return res.status(400).json({ error: 'every item requires an itemTraceNumber' });
    }

    const succeeded = Math.random() < BANK_SUCCESS_RATE;
    if (succeeded) {
      results.push({
        itemTraceNumber, // echoed back verbatim — this is the matching key
        status: 'Success',
        returnCode: '00',
        description: 'Accepted',
      });
    } else {
      const failure = pickFailureCode();
      results.push({
        itemTraceNumber,
        status: 'Failed',
        returnCode: failure.code,
        description: failure.description,
      });
    }
  }

  const failedCount = results.filter((r) => r.status === 'Failed').length;
  console.log(
    `  [MOCK BANK] Processed ${results.length} item(s) for ${fileId ?? '(no fileId)'} — ` +
      `${results.length - failedCount} accepted, ${failedCount} returned`
  );

  res.json({
    fileId: fileId ?? null,
    processedAt: new Date().toISOString(),
    results,
  });
});

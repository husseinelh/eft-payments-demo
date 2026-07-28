import {
  SELF_BASE_URL,
  BANK_RETURN_MIN_MS,
  BANK_RETURN_MAX_MS,
  RECOVERY_DELAY_MS,
} from './config.js';
import { finalisePayment, getSentPaymentIds } from './payments.repo.js';

/**
 * EVENT 2 — the bank return.
 *
 * This is what makes the two events genuinely decoupled. Event 1's HTTP response
 * is already flushed to the browser when scheduleBankReturn() returns; the actual
 * bank call fires from a timer 20-30 seconds later, on its own, with no client
 * involvement. The UI only discovers the outcome because it polls.
 *
 * setTimeout schedules a callback on Node's event loop and returns immediately —
 * it does not block. (Closest C# analogue: fire-and-forget Task.Delay + continuation,
 * not Thread.Sleep.)
 */

function randomDelayMs() {
  return BANK_RETURN_MIN_MS + Math.random() * (BANK_RETURN_MAX_MS - BANK_RETURN_MIN_MS);
}

/**
 * Schedules a delayed bank return for a batch. Returns instantly.
 *
 * @param {string} fileId
 * @param {string[]} itemTraceNumbers
 * @param {number} [delayMs] override, used by restart recovery
 */
export function scheduleBankReturn(fileId, itemTraceNumbers, delayMs = randomDelayMs()) {
  const seconds = (delayMs / 1000).toFixed(1);
  console.log(
    `  [EVENT 2] Bank return for ${fileId} scheduled in ${seconds}s ` +
      `(${itemTraceNumbers.length} item(s)) — Event 1 response already sent`
  );

  const timer = setTimeout(() => {
    // The callback is async, but setTimeout does not await it, so any rejection
    // would be unhandled. Catching here keeps a bank failure from crashing the
    // process — the payments simply stay Sent and get picked up on next restart.
    processBankReturn(fileId, itemTraceNumbers).catch((err) => {
      console.error(`  [EVENT 2] Bank return for ${fileId} failed: ${err.message}`);
      console.error('           Payments remain in Sent and will be retried on restart.');
    });
  }, delayMs);

  // Don't hold the process open purely for a pending timer.
  timer.unref?.();
}

/**
 * Calls the mock bank over HTTP, then matches each result back to its payment
 * strictly by itemTraceNumber.
 */
export async function processBankReturn(fileId, itemTraceNumbers) {
  const url = `${SELF_BASE_URL}/api/mock-bank/process`;

  console.log(`  [EVENT 2] Calling mock bank at ${url} for ${fileId}`);

  // Node has a built-in global fetch — no axios needed.
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    // Only trace numbers cross the boundary. No amounts, no names, no dates.
    body: JSON.stringify({
      fileId,
      items: itemTraceNumbers.map((itemTraceNumber) => ({ itemTraceNumber })),
    }),
  });

  if (!response.ok) {
    throw new Error(`Mock bank responded ${response.status} ${response.statusText}`);
  }

  const { results } = await response.json();
  if (!Array.isArray(results)) {
    throw new Error('Mock bank response contained no results array');
  }

  applyBankResults(fileId, itemTraceNumbers, results);
}

/**
 * Matches bank results to payments and finalises them.
 *
 * Matching is by itemTraceNumber ONLY — never by amount, date, or array
 * position. Results are indexed into a Map and each payment is resolved by key
 * lookup, so ordering differences or a partial return can't misalign anything.
 */
export function applyBankResults(fileId, expectedTraceNumbers, results) {
  const byTraceNumber = new Map();
  for (const result of results) {
    if (!result?.itemTraceNumber) {
      console.warn('  [EVENT 2] Skipping bank result with no itemTraceNumber');
      continue;
    }
    byTraceNumber.set(result.itemTraceNumber, result);
  }

  const expected = new Set(expectedTraceNumbers);
  let succeeded = 0;
  let failed = 0;
  let skipped = 0;

  // A trace number the bank returned that we never sent: log it, never guess.
  for (const traceNumber of byTraceNumber.keys()) {
    if (!expected.has(traceNumber)) {
      console.warn(`  [EVENT 2] Bank returned unknown trace number ${traceNumber} — ignored`);
    }
  }

  for (const traceNumber of expectedTraceNumbers) {
    const result = byTraceNumber.get(traceNumber);

    if (!result) {
      // No result came back for this payment. Leave it Sent so restart recovery
      // can retry it — silently failing it would be a data-integrity bug.
      console.warn(`  [EVENT 2] No bank result for ${traceNumber} — left in Sent for retry`);
      skipped += 1;
      continue;
    }

    const newStatus = result.status === 'Success' ? 'Success' : 'Failed';

    // finalisePayment only transitions rows currently in Sent, so a duplicate or
    // late return cannot overwrite an already-finalised payment.
    const applied = finalisePayment(traceNumber, newStatus);

    if (!applied) {
      console.warn(
        `  [EVENT 2] ${traceNumber} was not in Sent status — result ignored (idempotent)`
      );
      skipped += 1;
      continue;
    }

    if (newStatus === 'Success') succeeded += 1;
    else failed += 1;

    const codeSuffix = newStatus === 'Failed' ? ` [${result.returnCode}: ${result.description}]` : '';
    console.log(`             matched ${traceNumber} -> ${newStatus}${codeSuffix}`);
  }

  console.log(
    `  [EVENT 2] Batch ${fileId} settled — ${succeeded} Success, ${failed} Failed` +
      (skipped > 0 ? `, ${skipped} skipped` : '')
  );

  return { succeeded, failed, skipped };
}

/**
 * RESTART RECOVERY.
 *
 * A setTimeout lives only in process memory, so a restart during the 20-30s
 * window would strand those payments in Sent forever. On boot, sweep up anything
 * still Sent and schedule a return for it.
 */
export function recoverInFlightPayments() {
  const stranded = getSentPaymentIds();
  if (stranded.length === 0) return 0;

  console.log(
    `  [RECOVERY] Found ${stranded.length} payment(s) still in Sent from a previous run — ` +
      `re-scheduling their bank return`
  );
  scheduleBankReturn('EFT-RECOVERY', stranded, RECOVERY_DELAY_MS);
  return stranded.length;
}

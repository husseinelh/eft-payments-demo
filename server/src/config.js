/**
 * Central config. Everything tunable lives here so there is exactly one place
 * to look when something needs changing (ports, timings, the bank's success rate).
 */

export const PORT = Number(process.env.PORT) || 4000;

/** The Vite dev server origin. Pinned for CORS rather than using a wildcard. */
export const CLIENT_ORIGIN = process.env.CLIENT_ORIGIN || 'http://localhost:5173';

/** Base URL the backend uses to call the mock bank over real HTTP. */
export const SELF_BASE_URL = process.env.SELF_BASE_URL || `http://localhost:${PORT}`;

/** Name written into the EFT file HEADER record. */
export const ORIGINATOR_NAME = 'KINGSETT CAPITAL';

/**
 * Event 2 delay window. The bank "returns" a batch somewhere in this range,
 * long after Event 1's HTTP response has already been sent to the browser.
 */
export const BANK_RETURN_MIN_MS = 20_000;
export const BANK_RETURN_MAX_MS = 30_000;

/** Delay before re-processing batches stranded by a server restart. */
export const RECOVERY_DELAY_MS = 5_000;

/**
 * Mock bank success rate. ~87% mirrors realistic EFT return rates, where the
 * bulk of failures are NSF (insufficient funds).
 */
export const BANK_SUCCESS_RATE = 0.87;

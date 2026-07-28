import { ORIGINATOR_NAME } from './config.js';

/**
 * EFT file construction and validation.
 *
 * Format is pipe-delimited with a fixed field order, mirroring the shape of a
 * real EFT/NACHA-style file without the fixed-width ceremony:
 *
 *   HEADER|fileId|originatorName|creationDate|batchCount
 *   DETAIL|itemTraceNumber|customerName|accountNumber|amount|transactionType
 *   TRAILER|totalCount|totalAmount
 *
 * Amounts are written as zero-padded integer cents (000000012500 = $125.00),
 * which is how real EFT formats carry money — no decimal point, no ambiguity.
 */

const FIELD_SEP = '|';
const LINE_SEP = '\n';
const AMOUNT_WIDTH = 12;
const TRANSACTION_TYPE = 'CREDIT';

export class EftValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'EftValidationError';
  }
}

function formatAmount(cents) {
  return String(cents).padStart(AMOUNT_WIDTH, '0');
}

/**
 * Field values must never contain the delimiter or a newline, or the file
 * becomes unparseable and the trailer self-check below would be meaningless.
 */
function sanitiseField(value) {
  return String(value).replace(/[|\r\n]/g, ' ').trim();
}

/** File id like EFT-20260727-143502. Human-readable and sortable. */
function buildFileId(createdAt) {
  const stamp = createdAt.replace(/[-:T]/g, '').slice(0, 15); // YYYYMMDDTHHMMSS -> YYYYMMDDHHMMSS
  return `EFT-${stamp.slice(0, 8)}-${stamp.slice(8, 14)}`;
}

/**
 * Builds the EFT file text from Pending payment rows (amounts in cents).
 *
 * Returns the rendered content plus the metadata the caller needs. Does NOT
 * touch the database — building the file and committing the status change are
 * deliberately separate, so validation can gate the commit.
 */
export function buildEftFile(paymentRows) {
  if (!Array.isArray(paymentRows) || paymentRows.length === 0) {
    throw new EftValidationError('Cannot build an EFT file with zero payments');
  }

  const creationDate = new Date().toISOString();
  const fileId = buildFileId(creationDate);

  const detailLines = paymentRows.map((row) =>
    [
      'DETAIL',
      sanitiseField(row.id), // the itemTraceNumber
      sanitiseField(row.customerName),
      sanitiseField(row.accountNumber),
      formatAmount(row.amountCents),
      TRANSACTION_TYPE,
    ].join(FIELD_SEP)
  );

  const totalCount = paymentRows.length;
  const totalAmountCents = paymentRows.reduce((sum, row) => sum + row.amountCents, 0);

  const headerLine = [
    'HEADER',
    fileId,
    sanitiseField(ORIGINATOR_NAME),
    creationDate,
    String(totalCount),
  ].join(FIELD_SEP);

  const trailerLine = ['TRAILER', String(totalCount), formatAmount(totalAmountCents)].join(FIELD_SEP);

  const content = [headerLine, ...detailLines, trailerLine].join(LINE_SEP) + LINE_SEP;

  // Gate: the file must prove itself internally consistent before anything is
  // marked as Sent. Throws on mismatch.
  validateEftFile(content);

  return {
    fileId,
    fileName: `${fileId}.txt`,
    content,
    creationDate,
    batchCount: totalCount,
    totalAmountCents,
    totalAmount: totalAmountCents / 100,
    itemTraceNumbers: paymentRows.map((row) => row.id),
  };
}

/**
 * Verifies the TRAILER totals against the DETAIL records.
 *
 * This deliberately re-PARSES the rendered text rather than re-summing the
 * source array. Comparing an in-memory total against itself would always pass
 * and prove nothing; parsing back what was actually written catches real
 * serialisation faults — a truncated amount, a dropped or malformed row.
 *
 * Exported so it can be run against a downloaded file too.
 */
export function validateEftFile(content) {
  const lines = content.split(/\r?\n/).filter((line) => line.length > 0);

  const headers = lines.filter((l) => l.startsWith('HEADER' + FIELD_SEP));
  const details = lines.filter((l) => l.startsWith('DETAIL' + FIELD_SEP));
  const trailers = lines.filter((l) => l.startsWith('TRAILER' + FIELD_SEP));

  if (headers.length !== 1) {
    throw new EftValidationError(`Expected exactly 1 HEADER record, found ${headers.length}`);
  }
  if (trailers.length !== 1) {
    throw new EftValidationError(`Expected exactly 1 TRAILER record, found ${trailers.length}`);
  }
  if (details.length === 0) {
    throw new EftValidationError('File contains no DETAIL records');
  }
  if (lines.length !== headers.length + details.length + trailers.length) {
    throw new EftValidationError('File contains unrecognised record types');
  }

  // --- Re-derive the totals from the DETAIL lines as written -----------------
  let parsedCount = 0;
  let parsedAmountCents = 0;

  for (const [index, line] of details.entries()) {
    const fields = line.split(FIELD_SEP);
    if (fields.length !== 6) {
      throw new EftValidationError(
        `DETAIL record ${index + 1} has ${fields.length} fields, expected 6`
      );
    }
    const [, itemTraceNumber, , , amountField] = fields;

    if (!itemTraceNumber) {
      throw new EftValidationError(`DETAIL record ${index + 1} is missing its itemTraceNumber`);
    }
    if (!/^\d+$/.test(amountField)) {
      throw new EftValidationError(
        `DETAIL record ${index + 1} has a non-numeric amount "${amountField}"`
      );
    }

    parsedCount += 1;
    parsedAmountCents += Number(amountField);
  }

  // --- Compare against what the TRAILER claims ------------------------------
  const trailerFields = trailers[0].split(FIELD_SEP);
  if (trailerFields.length !== 3) {
    throw new EftValidationError(
      `TRAILER record has ${trailerFields.length} fields, expected 3`
    );
  }
  const trailerCount = Number(trailerFields[1]);
  const trailerAmountCents = Number(trailerFields[2]);

  if (trailerCount !== parsedCount) {
    throw new EftValidationError(
      `Trailer count mismatch: TRAILER says ${trailerCount}, found ${parsedCount} DETAIL records`
    );
  }
  if (trailerAmountCents !== parsedAmountCents) {
    throw new EftValidationError(
      `Trailer amount mismatch: TRAILER says ${trailerAmountCents} cents, ` +
        `DETAIL records total ${parsedAmountCents} cents`
    );
  }

  // The HEADER also carries the batch count — it must agree too.
  const headerCount = Number(headers[0].split(FIELD_SEP)[4]);
  if (headerCount !== parsedCount) {
    throw new EftValidationError(
      `Header count mismatch: HEADER says ${headerCount}, found ${parsedCount} DETAIL records`
    );
  }

  return { count: parsedCount, totalAmountCents: parsedAmountCents };
}

import { Router } from 'express';
import {
  listPayments,
  getPaymentById,
  getPaymentHistory,
  createPayment,
} from '../payments.repo.js';

/**
 * An express Router is a mountable group of routes — comparable to a Controller
 * in ASP.NET. index.js mounts this at /api/payments, so the paths below are
 * relative to that prefix.
 *
 * Each handler takes (req, res): req.body is the parsed JSON, res.json() sends
 * a response. `next` is only needed to hand an error to the error middleware,
 * and in Express 5 a thrown error is forwarded automatically.
 */
export const paymentsRouter = Router();

/** GET /api/payments — the full ledger, newest first. */
paymentsRouter.get('/', (req, res) => {
  res.json(listPayments());
});

/** GET /api/payments/:id/history — audit trail for one payment. */
paymentsRouter.get('/:id/history', (req, res) => {
  const payment = getPaymentById(req.params.id);
  if (!payment) {
    return res.status(404).json({ error: `No payment found with trace number ${req.params.id}` });
  }
  res.json(getPaymentHistory(req.params.id));
});

/** GET /api/payments/:id — single payment. */
paymentsRouter.get('/:id', (req, res) => {
  const payment = getPaymentById(req.params.id);
  if (!payment) {
    return res.status(404).json({ error: `No payment found with trace number ${req.params.id}` });
  }
  res.json(payment);
});

/** POST /api/payments — create a new Pending payment. */
paymentsRouter.post('/', (req, res) => {
  const { customerName, amount } = req.body ?? {};

  const name = typeof customerName === 'string' ? customerName.trim() : '';
  if (!name) {
    return res.status(400).json({ error: 'customerName is required' });
  }
  if (name.length > 100) {
    return res.status(400).json({ error: 'customerName must be 100 characters or fewer' });
  }

  // Accept a JSON number or a numeric string from the form.
  if (typeof amount !== 'number' && typeof amount !== 'string') {
  return res.status(400).json({ error: 'amount must be a number or numeric string' });
}

  const parsedAmount = typeof amount === 'number' ? amount : Number(amount);
  if (!Number.isFinite(parsedAmount) || parsedAmount <= 0) {
    return res.status(400).json({ error: 'amount must be a number greater than zero' });
  }
  if (parsedAmount > 1_000_000) {
    return res.status(400).json({ error: 'amount must be 1,000,000 or less' });
  }
  // Guard against sub-cent precision. The epsilon is needed because 12.34 * 100
  // is 1233.9999999999998 in floating point, not 1234.
  const cents = parsedAmount * 100;
  if (Math.abs(cents - Math.round(cents)) > 1e-6) {
    return res.status(400).json({ error: 'amount cannot have more than 2 decimal places' });
  }

  const payment = createPayment({ customerName: name, amount: parsedAmount });
  res.status(201).json(payment);
});

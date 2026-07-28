import express from 'express';
import cors from 'cors';

import { PORT, CLIENT_ORIGIN } from './config.js';
import { seedIfEmpty, DB_PATH } from './db.js';
import { paymentsRouter } from './routes/payments.routes.js';
import { batchesRouter } from './routes/batches.routes.js';
import { mockBankRouter } from './routes/mockBank.routes.js';
import { recoverInFlightPayments } from './bankReturn.js';

const app = express();

/**
 * CORS. A browser will refuse to let JavaScript on http://localhost:5173 read a
 * response from http://localhost:4000 unless the server explicitly opts in with
 * an Access-Control-Allow-Origin header. This middleware adds that header and
 * answers the preflight OPTIONS request browsers send first.
 *
 * The origin is pinned to the Vite dev server rather than '*' — same-shape
 * configuration you would actually ship.
 */
app.use(cors({ origin: CLIENT_ORIGIN }));

/** Parses incoming JSON bodies into req.body. Without it, req.body is undefined. */
app.use(express.json());

/** One-line request log so the decoupled Event 2 traffic is visible in the console. */
app.use((req, res, next) => {
  const startedAt = Date.now();
  res.on('finish', () => {
    console.log(`  ${req.method} ${req.originalUrl} -> ${res.statusCode} (${Date.now() - startedAt}ms)`);
  });
  next();
});

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
});

app.use('/api/payments', paymentsRouter);
app.use('/api/batches', batchesRouter);
// Mounted on the same server for demo convenience, but treated as an external
// system: the backend reaches it over HTTP, not by importing its function.
app.use('/api/mock-bank', mockBankRouter);

/** Unmatched /api/* paths should be JSON 404s, not Express's HTML error page. */
app.use('/api', (req, res) => {
  res.status(404).json({ error: `No route for ${req.method} ${req.originalUrl}` });
});

/**
 * Error middleware. Identified by its four arguments — Express calls it when a
 * handler throws or passes an error to next(). Roughly an exception filter.
 */
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: err.message || 'Internal server error' });
});

const wasSeeded = seedIfEmpty();

app.listen(PORT, () => {
  console.log('');
  console.log(`  EFT demo API listening on http://localhost:${PORT}`);
  console.log(`  Database: ${DB_PATH}`);
  console.log(`  CORS origin allowed: ${CLIENT_ORIGIN}`);
  if (wasSeeded) console.log('  Seeded sample payments (first run)');
  console.log('');

  // Sweep up any batch stranded mid-flight by a restart. Runs after listen()
  // because the recovery path calls the mock bank over HTTP on this same server.
  recoverInFlightPayments();
});

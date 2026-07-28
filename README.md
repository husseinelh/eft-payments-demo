# EFT Payment Batch System — Demo

A small full-stack demo simulating an **EFT (Electronic Funds Transfer)** payment batch lifecycle.

Payments accumulate as `Pending`, get swept into a generated EFT batch file and marked `Sent`, and are then settled to `Success` / `Failed` by a **separate, delayed, decoupled** bank return that matches results back by `itemTraceNumber`.

**Stack:** React 19 + Vite (frontend) · Node.js + Express 5 (backend) · SQLite via better-sqlite3 · plain JavaScript (ESM)

---

## Quick start

**Prerequisites:** Node.js 22+ (developed on 24.14) and npm. Nothing else — no database server, no build tools.

```bash
# 1. Install all dependencies (root + server + client)
npm run setup

# 2. Start both the API and the UI together
npm run dev

# 3. Open the app
#    http://localhost:5173
```

That's it. The SQLite database is created and seeded with 7 sample payments on first run.

| | URL |
|---|---|
| Frontend (Vite) | http://localhost:5173 |
| Backend API | http://localhost:4000 |
| Health check | http://localhost:4000/api/health |

<details>
<summary>Running the two halves in separate terminals instead</summary>

```bash
npm run dev:server   # terminal 1 — API on :4000
npm run dev:client   # terminal 2 — UI on :5173
```
</details>

### Environment setup

None required — the defaults work out of the box. Everything is overridable if a port is taken:

| Variable | Default | Where |
|---|---|---|
| `PORT` | `4000` | server |
| `CLIENT_ORIGIN` | `http://localhost:5173` | server — the origin allowed through CORS |
| `SELF_BASE_URL` | `http://localhost:4000` | server — base URL used to call the mock bank |
| `VITE_API_URL` | `http://localhost:4000` | client — API base URL |

If you change the server port, set `VITE_API_URL` to match. If you change the client port, set `CLIENT_ORIGIN` to match, or the browser will block the API calls.

**Resetting the demo:** delete `server/data/` and restart. The schema and the seed data rebuild automatically.

---

## The core flow

The two events are genuinely decoupled — **not** one request/response round-trip.

```
  BROWSER (:5173)                        EXPRESS API (:4000)                  SQLite
  ───────────────                        ───────────────────                  ──────
  add payment ──────── POST /api/payments ──────────────────────────────────► payments
  poll every 5s ────── GET  /api/payments ◄──────────────────────────────────
  expand a row ─────── GET  /api/payments/:id/history ◄─────────────────────── payment_history

  [Generate & Send] ── POST /api/batches/generate
                             │  1. read all Pending payments
                             │  2. build the EFT file (HEADER / DETAIL / TRAILER)
                             │  3. validate trailer totals against the details
                             │  4. TRANSACTION: mark every payment Sent (all-or-nothing)
                             │  5. schedule the return, respond immediately  ◄── ~2ms
                             ▼
                      setTimeout(20–30s)        ← the HTTP response is already sent
                             │
                             └─ fetch ──► POST /api/mock-bank/process    ← REAL HTTP HOP
                                            { fileId, items: [{ itemTraceNumber }] }
                                          ◄─ { results: [{ itemTraceNumber, status, returnCode }] }
                             │
                             └─ match each result by itemTraceNumber
                                → update status + write PaymentHistory
```

### Event 1 — Generate & Send Batch

Triggered by the button. Reads every `Pending` payment, builds the EFT file, validates it, then marks the batch `Sent` in a single transaction and returns the file content to the browser. Responds in a couple of milliseconds.

### Event 2 — Bank Return (automatic)

Fires **20–30 seconds later**, on the backend's own timer, with no client involvement. The backend calls the mock bank over real HTTP, then matches each returned result to its payment by `itemTraceNumber` and writes the final status.

The UI has no idea this is coming — it discovers the outcome purely because it polls every 5 seconds.

---

## Seeing the decoupling for yourself

1. Open http://localhost:5173. Three payments are sitting in `Pending`.
2. Click **Generate & Send Batch** — the modal shows the raw EFT file, and the rows turn amber `Sent`.
3. Close the modal and **do nothing at all**.
4. Watch the server terminal — it logs the scheduled return, then fires it ~25 seconds later.
5. The badges flip to green `Success` / red `Failed` on their own, and `Processed` timestamps fill in.
6. Click any row to see its full `Pending → Sent → Success` audit trail.

You can also drive the whole thing without the browser:

```bash
curl http://localhost:4000/api/payments

curl -X POST http://localhost:4000/api/payments \
  -H "Content-Type: application/json" \
  -d '{"customerName":"Test Co","amount":125.50}'

curl -X POST http://localhost:4000/api/batches/generate   # returns the file text instantly
curl -X POST http://localhost:4000/api/batches/generate   # 409 — nothing left to send

# wait ~30 seconds, then:
curl http://localhost:4000/api/payments                   # now Success / Failed
curl http://localhost:4000/api/payments/ITM-000000001/history
```

---

## The EFT file

Pipe-delimited with a fixed field order. Amounts are zero-padded integer **cents** (`000000012500` = $125.00), which is how real EFT formats carry money — no decimal point, no ambiguity.

```
HEADER|EFT-20260728-022833|KINGSETT CAPITAL|2026-07-28T02:28:33.462Z|3
DETAIL|ITM-000000003|Fabrikam Facilities|7472057357|000000430050|CREDIT
DETAIL|ITM-000000002|Contoso Property Mgmt|4514209273|000000008999|CREDIT
DETAIL|ITM-000000001|Northwind Traders|5137688322|000000125000|CREDIT
TRAILER|3|000000564049
```

| Record | Fields |
|---|---|
| `HEADER` | fileId, originatorName, creationDate, batchCount |
| `DETAIL` | itemTraceNumber, customerName, accountNumber, amount, transactionType |
| `TRAILER` | totalCount, totalAmount |

---

## Design notes

Four decisions worth calling out.

**1. Trailer validation re-parses the file, rather than re-summing the source array.**
`validateEftFile()` splits the rendered text back apart, re-derives the count and total from the `DETAIL` lines *as written*, and compares those against the `TRAILER`. Comparing an in-memory total against itself would always pass and prove nothing. This version catches real serialisation faults — a truncated amount, a dropped row, a malformed field. It runs **before** the database write, so a file that fails its own check leaves every payment `Pending`.

**2. Money is stored as integer cents.**
Floating point can't represent `0.10 + 0.20` exactly, and the trailer check is an equality test on a sum. Cents keep it exact — the same reasoning behind `decimal` over `double`.

**3. One choke point for status changes.**
Every transition goes through `changeStatus()` in [`payments.repo.js`](server/src/payments.repo.js), which writes the `payment_history` row inside the same transaction as the update. "Log to history on every status change" is a structural guarantee, not a convention each call site has to remember.

**4. The mock bank only ever receives trace numbers.**
No amounts, no names, no dates cross that boundary. Matching by anything other than `itemTraceNumber` isn't merely discouraged — it's impossible with the data the bank returns. That's how real EFT return matching works.

### Safety properties

- **Atomic batch send.** Every payment flips to `Sent` inside one transaction. If any single update fails, SQLite rolls back the whole batch — no payment is ever stranded in a state the bank never heard about.
- **Idempotent returns.** `finalisePayment()` only transitions rows currently in `Sent`, so a duplicated or late bank return can't overwrite an already-settled payment.
- **Unknown trace numbers are logged and skipped**, never guessed at. A payment with no matching result stays `Sent` for retry rather than being silently failed.
- **Restart recovery.** A `setTimeout` lives only in process memory, so a restart mid-window would strand payments in `Sent` forever. On boot the server sweeps up anything still `Sent` and re-schedules its return.

---

## Project structure

```
.
├─ package.json               root scripts: setup, dev (runs both via concurrently)
├─ server/
│  └─ src/
│     ├─ index.js             app wiring, CORS, route mounting, startup recovery
│     ├─ config.js            ports, timings, bank success rate
│     ├─ db.js                schema, connection, first-run seed
│     ├─ payments.repo.js     all SQL + the transactional status-change choke point
│     ├─ eftFile.js           EFT file construction + trailer self-validation
│     ├─ bankReturn.js        Event 2: scheduling, the HTTP call, trace matching
│     └─ routes/
│        ├─ payments.routes.js
│        ├─ batches.routes.js     Event 1
│        └─ mockBank.routes.js    the "external" bank
└─ client/
   └─ src/
      ├─ App.jsx              state + the 5-second polling loop
      ├─ api.js               fetch wrappers
      ├─ format.js            currency / date formatting
      └─ components/
         ├─ PaymentForm.jsx   PaymentTable.jsx   PaymentHistory.jsx
         ├─ StatusBadge.jsx   EftFileModal.jsx
```

### API reference

| Method | Route | Purpose |
|---|---|---|
| `GET` | `/api/health` | Liveness check |
| `GET` | `/api/payments` | Full ledger, newest first |
| `POST` | `/api/payments` | Create a `Pending` payment |
| `GET` | `/api/payments/:id` | One payment |
| `GET` | `/api/payments/:id/history` | Status-change audit trail |
| `POST` | `/api/batches/generate` | **Event 1** — `409` when nothing is pending |
| `POST` | `/api/mock-bank/process` | The mock bank (called by the backend, not the UI) |

### Data model

**`payments`** — `id` (the `itemTraceNumber`, e.g. `ITM-000000042`), `customerName`, `amountCents`, `accountNumber`, `status` (`Pending` \| `Sent` \| `Success` \| `Failed`), `createdAt`, `processedAt` (nullable)

**`payment_history`** — `id`, `paymentId`, `oldStatus` (null on creation), `newStatus`, `timestamp`

---

## Troubleshooting

**`better-sqlite3` tries to compile / asks for Visual Studio.**
Pinned to `^12.11.1` deliberately. Version 13 dropped prebuilt binaries and always builds from source, which needs Visual Studio Build Tools on Windows. Stay on 12.x and installs stay instant.

**Browser console shows a CORS error.**
The API allows exactly one origin, `http://localhost:5173`. If Vite started on a different port, set `CLIENT_ORIGIN` on the server to match. (`strictPort` is enabled to make this fail loudly rather than silently.)

**Payments stuck on `Sent`.**
They settle 20–30 seconds after the batch. If the server was restarted in that window, recovery re-schedules them ~5 seconds after boot — check the terminal for a `[RECOVERY]` line.

**Port already in use.** Set `PORT` (server) or edit `server.port` in `client/vite.config.js`, and update the matching variable above.

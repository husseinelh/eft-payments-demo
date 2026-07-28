import { useCallback, useEffect, useRef, useState } from 'react';

import { getPayments, getPaymentHistory, generateBatch, ApiError } from './api';
import { PaymentForm } from './components/PaymentForm';
import { PaymentTable } from './components/PaymentTable';
import { EftFileModal } from './components/EftFileModal';
import { formatTime } from './format';

const POLL_INTERVAL_MS = 5000;

export default function App() {
  const [payments, setPayments] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [lastUpdated, setLastUpdated] = useState(null);

  const [eftFile, setEftFile] = useState(null);
  const [generating, setGenerating] = useState(false);

  const [expandedId, setExpandedId] = useState(null);
  const [historyEntries, setHistoryEntries] = useState([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState(null);

  // Avoids a state update on an unmounted component if a fetch is still in flight.
  const isMounted = useRef(true);
  useEffect(() => {
    isMounted.current = true;
    return () => {
      isMounted.current = false;
    };
  }, []);

  /**
   * Fetches the ledger. Deliberately does NOT touch expandedId, so a row the
   * user has open stays open across every poll.
   */
  const refreshPayments = useCallback(async () => {
    try {
      const data = await getPayments();
      if (!isMounted.current) return;
      setPayments(data);
      setLastUpdated(new Date());
      setError(null);
    } catch (err) {
      if (isMounted.current) setError(err.message);
    } finally {
      if (isMounted.current) setLoading(false);
    }
  }, []);

  /**
   * POLLING — this is how Event 2 becomes visible.
   *
   * The backend finalises payments on its own timer with no client involvement,
   * so the UI has no way to know unless it asks periodically. useEffect with an
   * empty dependency array runs once on mount; the returned function clears the
   * interval on unmount so it doesn't keep firing.
   */
  useEffect(() => {
    refreshPayments();
    const intervalId = setInterval(refreshPayments, POLL_INTERVAL_MS);
    return () => clearInterval(intervalId);
  }, [refreshPayments]);

  // Status of the expanded payment. Used as an effect dependency below so the
  // history panel refetches when that payment's status changes mid-poll.
  const expandedStatus = payments.find((p) => p.id === expandedId)?.status ?? null;

  useEffect(() => {
    if (!expandedId) {
      setHistoryEntries([]);
      setHistoryError(null);
      return;
    }

    let cancelled = false;
    setHistoryLoading(true);
    setHistoryError(null);

    getPaymentHistory(expandedId)
      .then((entries) => {
        if (!cancelled) setHistoryEntries(entries);
      })
      .catch((err) => {
        if (!cancelled) setHistoryError(err.message);
      })
      .finally(() => {
        if (!cancelled) setHistoryLoading(false);
      });

    // Guards against a slow earlier request landing after a newer one.
    return () => {
      cancelled = true;
    };
  }, [expandedId, expandedStatus]);

  const handleToggleRow = (id) => setExpandedId((current) => (current === id ? null : id));

  /** EVENT 1 trigger. */
  async function handleGenerateBatch() {
    setGenerating(true);
    setNotice(null);
    setError(null);

    try {
      const file = await generateBatch();
      setEftFile(file); // opens the modal
      await refreshPayments(); // rows are now Sent
    } catch (err) {
      // 409 is the expected "nothing to send" case, not a system failure — so
      // it gets a neutral notice rather than a red error.
      if (err instanceof ApiError && err.status === 409) {
        setNotice(err.message);
      } else {
        setError(err.message);
      }
    } finally {
      setGenerating(false);
    }
  }

  const pendingCount = payments.filter((p) => p.status === 'Pending').length;

  return (
    <div className="app">
      <header className="app-header">
        <div>
          <h1>EFT Payment Batch System</h1>
          <p className="tagline">
            Generate an EFT batch file, then watch the bank return settle each payment
            automatically.
          </p>
        </div>
        <button
          className="btn btn-primary btn-large"
          onClick={handleGenerateBatch}
          disabled={generating}
        >
          {generating ? 'Generating…' : 'Generate & Send Batch'}
          {pendingCount > 0 && <span className="pill">{pendingCount} pending</span>}
        </button>
      </header>

      <PaymentForm onCreated={refreshPayments} />

      {error && (
        <div className="banner banner-error" role="alert">
          {error}
        </div>
      )}
      {notice && (
        <div className="banner banner-notice" role="status">
          {notice}
        </div>
      )}

      <section className="card">
        <div className="card-header">
          <h2>Payment Ledger</h2>
          <span className="poll-status">
            {lastUpdated
              ? `Auto-refreshing every ${POLL_INTERVAL_MS / 1000}s · last updated ${formatTime(lastUpdated)}`
              : 'Loading…'}
          </span>
        </div>

        {loading ? (
          <p className="empty-state">Loading payments…</p>
        ) : (
          <PaymentTable
            payments={payments}
            expandedId={expandedId}
            onToggleRow={handleToggleRow}
            historyEntries={historyEntries}
            historyLoading={historyLoading}
            historyError={historyError}
          />
        )}
      </section>

      {eftFile && <EftFileModal file={eftFile} onClose={() => setEftFile(null)} />}
    </div>
  );
}

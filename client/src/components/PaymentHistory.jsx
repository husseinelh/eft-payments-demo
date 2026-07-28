import { formatDateTime } from '../format';

/**
 * The audit trail shown when a payment row is expanded — one entry per status
 * change, straight from the PaymentHistory table.
 */
export function PaymentHistory({ entries, loading, error }) {
  if (loading) return <p className="history-note">Loading history…</p>;
  if (error) return <p className="history-note history-error">{error}</p>;
  if (!entries || entries.length === 0) return <p className="history-note">No history recorded.</p>;

  return (
    <div className="history">
      <h4>Status History</h4>
      <ol className="history-list">
        {entries.map((entry) => (
          <li key={entry.id}>
            <span className="history-transition">
              {entry.oldStatus ? (
                <>
                  <code>{entry.oldStatus}</code> → <code>{entry.newStatus}</code>
                </>
              ) : (
                <>
                  <em>created as</em> <code>{entry.newStatus}</code>
                </>
              )}
            </span>
            <span className="history-time">{formatDateTime(entry.timestamp)}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}

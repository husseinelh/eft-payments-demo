import { Fragment } from 'react';
import { StatusBadge } from './StatusBadge';
import { PaymentHistory } from './PaymentHistory';
import { formatCurrency, formatDateTime } from '../format';

/**
 * The ledger. Clicking a row expands it to reveal that payment's history.
 *
 * Rows are keyed by itemTraceNumber, so React preserves each row's DOM identity
 * across the 5-second poll — an expanded row stays open and doesn't flicker
 * when the data refreshes underneath it.
 */
export function PaymentTable({
  payments,
  expandedId,
  onToggleRow,
  historyEntries,
  historyLoading,
  historyError,
}) {
  if (payments.length === 0) {
    return <p className="empty-state">No payments yet. Add one above to get started.</p>;
  }

  return (
    <div className="table-scroll">
      <table className="ledger">
        <thead>
          <tr>
            <th className="col-expand" aria-label="Expand" />
            <th>Customer</th>
            <th className="col-amount">Amount</th>
            <th>Status</th>
            <th>Created</th>
            <th>Processed</th>
          </tr>
        </thead>
        <tbody>
          {payments.map((payment) => {
            const isExpanded = expandedId === payment.id;
            return (
              <Fragment key={payment.id}>
                <tr
                  className={`ledger-row${isExpanded ? ' is-expanded' : ''}`}
                  onClick={() => onToggleRow(payment.id)}
                  // Keyboard access: rows are interactive, so they must be reachable
                  // and operable without a mouse.
                  tabIndex={0}
                  role="button"
                  aria-expanded={isExpanded}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      onToggleRow(payment.id);
                    }
                  }}
                >
                  <td className="col-expand">
                    <span className={`chevron${isExpanded ? ' is-open' : ''}`} aria-hidden="true">
                      ▶
                    </span>
                  </td>
                  <td>
                    <div className="customer-name">{payment.customerName}</div>
                    <div className="trace-number">{payment.itemTraceNumber}</div>
                  </td>
                  <td className="col-amount">{formatCurrency(payment.amount)}</td>
                  <td>
                    <StatusBadge status={payment.status} />
                  </td>
                  <td className="col-date">{formatDateTime(payment.createdAt)}</td>
                  <td className="col-date">{formatDateTime(payment.processedAt)}</td>
                </tr>

                {isExpanded && (
                  <tr className="history-row">
                    <td colSpan={6}>
                      <PaymentHistory
                        entries={historyEntries}
                        loading={historyLoading}
                        error={historyError}
                      />
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

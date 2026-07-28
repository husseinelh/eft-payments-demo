import { useState } from 'react';
import { createPayment } from '../api';

/**
 * Form for adding a mock payment. New payments always start as Pending, so
 * they're picked up by the next batch.
 *
 * useState is React's local state hook: [value, setValue]. Re-rendering happens
 * automatically when the setter is called.
 */
export function PaymentForm({ onCreated }) {
  const [customerName, setCustomerName] = useState('');
  const [amount, setAmount] = useState('');
  const [error, setError] = useState(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event) {
    event.preventDefault(); // stop the browser's default full-page form post
    setError(null);

    const name = customerName.trim();
    const parsedAmount = Number(amount);

    if (!name) return setError('Customer name is required.');
    if (!Number.isFinite(parsedAmount) || parsedAmount <= 0) {
      return setError('Amount must be greater than zero.');
    }

    setSubmitting(true);
    try {
      await createPayment(name, parsedAmount);
      setCustomerName('');
      setAmount('');
      await onCreated(); // refresh the ledger so the new row shows immediately
    } catch (err) {
      setError(err.message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form className="card payment-form" onSubmit={handleSubmit}>
      <h2>Add Payment</h2>

      <div className="form-row">
        <label className="field">
          <span>Customer Name</span>
          <input
            type="text"
            value={customerName}
            onChange={(e) => setCustomerName(e.target.value)}
            placeholder="e.g. Northwind Traders"
            maxLength={100}
            disabled={submitting}
          />
        </label>

        <label className="field field-amount">
          <span>Amount (CAD)</span>
          <input
            type="number"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="0.00"
            step="0.01"
            min="0.01"
            disabled={submitting}
          />
        </label>

        <button type="submit" className="btn btn-primary" disabled={submitting}>
          {submitting ? 'Adding…' : 'Add Payment'}
        </button>
      </div>

      {error && <p className="form-error" role="alert">{error}</p>}
    </form>
  );
}

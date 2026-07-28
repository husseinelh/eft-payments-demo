/** Shared display formatting. */

const currency = new Intl.NumberFormat('en-CA', {
  style: 'currency',
  currency: 'CAD',
});

export const formatCurrency = (value) => currency.format(value);

/** Compact local date+time. Returns an em dash for null (e.g. unprocessed). */
export function formatDateTime(iso) {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString('en-CA', {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
}

export const formatTime = (date) =>
  date.toLocaleTimeString('en-CA', { hour12: false });

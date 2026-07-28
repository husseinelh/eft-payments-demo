/**
 * Colour-coded status pill.
 *
 * The text label is always present — colour is a reinforcement, never the only
 * signal, so the table still reads correctly for colour-blind users.
 */
export function StatusBadge({ status }) {
  const className = `badge badge-${String(status).toLowerCase()}`;
  return (
    <span className={className}>
      <span className="badge-dot" aria-hidden="true" />
      {status}
    </span>
  );
}

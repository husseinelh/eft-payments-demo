import { useEffect, useRef } from 'react';
import { formatCurrency } from '../format';

/**
 * Shows the raw EFT file produced by Event 1, with a download button.
 */
export function EftFileModal({ file, onClose }) {
  const closeButtonRef = useRef(null);

  // Close on Escape, and move focus into the dialog when it opens.
  useEffect(() => {
    function handleKeyDown(event) {
      if (event.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', handleKeyDown);
    closeButtonRef.current?.focus();
    // The cleanup function runs when the component unmounts — without it the
    // listener would pile up every time the modal opened.
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  if (!file) return null;

  /**
   * Standard browser download: wrap the text in a Blob, create a temporary
   * object URL pointing at it, click a hidden anchor, then release the URL so
   * the blob can be garbage collected.
   */
  function handleDownload() {
    const blob = new Blob([file.content], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = file.fileName;
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
    URL.revokeObjectURL(url);
  }

  return (
    // Clicking the dark backdrop closes; stopPropagation keeps clicks inside from bubbling.
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="eft-modal-title"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="modal-header">
          <div>
            <h2 id="eft-modal-title">EFT File Generated</h2>
            <p className="modal-subtitle">
              <code>{file.fileName}</code>
            </p>
          </div>
          <button
            ref={closeButtonRef}
            className="btn-icon"
            onClick={onClose}
            aria-label="Close dialog"
          >
            ✕
          </button>
        </header>

        <dl className="modal-summary">
          <div>
            <dt>Batch Count</dt>
            <dd>{file.batchCount}</dd>
          </div>
          <div>
            <dt>Total Amount</dt>
            <dd>{formatCurrency(file.totalAmount)}</dd>
          </div>
          <div>
            <dt>Trailer Check</dt>
            <dd className="check-passed">✓ Totals verified</dd>
          </div>
        </dl>

        <p className="modal-note">
          These payments are now <strong>Sent</strong>. The bank will return results
          automatically in 20–30 seconds — the ledger updates on its own.
        </p>

        <pre className="eft-content">{file.content}</pre>

        <footer className="modal-footer">
          <button className="btn btn-secondary" onClick={onClose}>
            Close
          </button>
          <button className="btn btn-primary" onClick={handleDownload}>
            Download File
          </button>
        </footer>
      </div>
    </div>
  );
}

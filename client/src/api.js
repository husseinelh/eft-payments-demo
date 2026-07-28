/**
 * Thin wrapper around the backend API.
 *
 * Keeping every fetch in one file means the components never deal with URLs,
 * status codes, or error-shape parsing.
 */

const BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:4000';

/** Error carrying the HTTP status, so callers can treat 409 differently. */
export class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

async function request(path, options = {}) {
  let response;
  try {
    response = await fetch(`${BASE_URL}${path}`, {
      headers: { 'Content-Type': 'application/json' },
      ...options,
    });
  } catch {
    // fetch only rejects on network-level failure — usually the API being down.
    throw new ApiError(`Cannot reach the API at ${BASE_URL}. Is the backend running?`, 0);
  }

  // 204 has no body to parse.
  if (response.status === 204) return null;

  const text = await response.text();
  let payload = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      throw new ApiError(`Unexpected non-JSON response from ${path}`, response.status);
    }
  }

  if (!response.ok) {
    throw new ApiError(payload?.error || `Request failed with status ${response.status}`, response.status);
  }

  return payload;
}

export const getPayments = () => request('/api/payments');

export const getPaymentHistory = (id) => request(`/api/payments/${encodeURIComponent(id)}/history`);

export const createPayment = (customerName, amount) =>
  request('/api/payments', {
    method: 'POST',
    body: JSON.stringify({ customerName, amount }),
  });

export const generateBatch = () => request('/api/batches/generate', { method: 'POST' });

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import App from './App.jsx';
import './styles.css';

// Mounts the React tree into the #root div from index.html.
// StrictMode is a development-only wrapper that surfaces unsafe patterns —
// notably by double-invoking effects, which is why effect cleanup matters.
createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>
);

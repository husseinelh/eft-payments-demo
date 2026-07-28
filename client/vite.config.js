import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // Fail loudly instead of silently hopping to :5174 — the server's CORS
    // allow-list is pinned to this exact origin, so a surprise port would
    // turn into a confusing "blocked by CORS" error in the browser console.
    strictPort: true,
  },
});

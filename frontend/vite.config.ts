import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// ==============================================================
// ATLAS IELTS Academy — Vite config
// Dev server proxies /api → FastAPI on :8000 so the frontend is
// same-origin in development (no CORS friction, no env juggling).
// ==============================================================

export default defineConfig({
  plugins: [react()],

  server: {
    host: true,          // reachable from phones on the LAN (mobile testing)
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': {
        target: 'https://ielts-8-eight.vercel.app/',
        changeOrigin: true,
      },
    },
  },

  build: {
    outDir: 'dist',
    sourcemap: true,
  },
});

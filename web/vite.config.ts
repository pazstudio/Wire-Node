import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// In development the API runs on :8080 and Vite proxies to it.
export default defineConfig({
  plugins: [react()],
  server: {
    host: true,
    proxy: {
      '/api': 'http://localhost:8080',
      '/uploads': 'http://localhost:8080',
    },
  },
});

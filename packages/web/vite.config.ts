import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  resolve: { conditions: ['source'] },
  server: {
    host: '127.0.0.1',
    port: 5173,
    // `pnpm dev` talks to a locally running server (default 127.0.0.1:8090).
    proxy: { '/api': process.env.API_URL ?? 'http://127.0.0.1:8090' },
  },
  build: { outDir: 'dist', emptyOutDir: true },
});

import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';
import { PRODUCT_NAME } from '../shared/src/product.js';

/** Fills `%PRODUCT_NAME%` in index.html from the one shared definition. */
function productName(): Plugin {
  return {
    name: 'product-name',
    transformIndexHtml: (html) => html.replaceAll('%PRODUCT_NAME%', PRODUCT_NAME),
  };
}

export default defineConfig({
  plugins: [react(), productName()],
  resolve: { conditions: ['source'] },
  server: {
    host: '127.0.0.1',
    port: 5173,
    // `pnpm dev` talks to a locally running server (default 127.0.0.1:8090).
    proxy: { '/api': process.env.API_URL ?? 'http://127.0.0.1:8090' },
  },
  build: { outDir: 'dist', emptyOutDir: true },
});

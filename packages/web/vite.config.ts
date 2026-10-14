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

/**
 * Web app manifest (spec 用户故事 109: 添加到主屏幕). Built from the shared
 * product name; icons come from `public/icons/` (scripts/generate-pwa-icons.mjs).
 * No service worker: no offline cache and no Web Push (out of scope).
 */
const MANIFEST = {
  id: '/',
  name: PRODUCT_NAME,
  short_name: PRODUCT_NAME,
  lang: 'zh-CN',
  start_url: '/',
  scope: '/',
  display: 'standalone',
  orientation: 'any',
  background_color: '#ffffff',
  theme_color: '#4772fa',
  icons: [
    { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
    { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
    { src: '/icons/maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
  ],
};

function webManifest(): Plugin {
  const body = JSON.stringify(MANIFEST, null, 2);
  return {
    name: 'web-manifest',
    configureServer(server) {
      server.middlewares.use('/manifest.webmanifest', (_req, res) => {
        res.setHeader('Content-Type', 'application/manifest+json');
        res.end(body);
      });
    },
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'manifest.webmanifest', source: body });
    },
  };
}

export default defineConfig({
  plugins: [react(), productName(), webManifest()],
  resolve: { conditions: ['source'] },
  server: {
    host: '127.0.0.1',
    port: 5173,
    // `pnpm dev` talks to a locally running server (default 127.0.0.1:8090).
    proxy: { '/api': process.env.API_URL ?? 'http://127.0.0.1:8090' },
  },
  build: { outDir: 'dist', emptyOutDir: true },
});

// Renders the PWA icons in packages/web/public/icons/ from the Logo (the
// same artwork as packages/web/src/ui/Brand.tsx, ADR-0001: our own logo).
// Run after changing the logo: `node scripts/generate-pwa-icons.mjs`.
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(repoRoot, 'packages/web/public/icons');
const BRAND = '#4772fa';
const CHECK = 'm9.5 16.5 4.5 4.5 9-10';

/** The Logo: rounded square with a check mark, on a transparent background. */
const logo = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">
  <rect x="2" y="2" width="28" height="28" rx="9" fill="${BRAND}"/>
  <path d="${CHECK}" fill="none" stroke="#fff" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`;

/**
 * Full-bleed variant for maskable icons and iOS (the platform crops the
 * shape): brand background, the check mark inside the 80% safe zone.
 */
const fullBleed = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">
  <rect width="32" height="32" fill="${BRAND}"/>
  <g transform="translate(16 16) scale(0.72) translate(-16 -16)">
    <path d="${CHECK}" fill="none" stroke="#fff" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"/>
  </g>
</svg>`;

const icons = [
  { file: 'icon-192.png', size: 192, svg: logo },
  { file: 'icon-512.png', size: 512, svg: logo },
  { file: 'maskable-512.png', size: 512, svg: fullBleed },
  { file: 'apple-touch-icon.png', size: 180, svg: fullBleed },
];

mkdirSync(outDir, { recursive: true });
const browser = await chromium.launch();
try {
  for (const { file, size, svg } of icons) {
    const page = await browser.newPage({ viewport: { width: size, height: size }, deviceScaleFactor: 1 });
    await page.setContent(
      `<html><body style="margin:0;background:transparent">${svg.replace('<svg ', `<svg width="${size}" height="${size}" `)}</body></html>`,
    );
    await page.screenshot({ path: path.join(outDir, file), omitBackground: true });
    await page.close();
    console.log(`${file} ${size}x${size}`);
  }
} finally {
  await browser.close();
}

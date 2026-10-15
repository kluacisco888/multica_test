// Starts the built server for Playwright: fresh `dida_e2e` database on the
// test PostgreSQL, migrations on startup, web app served from packages/web/dist.
// Run `pnpm build` first (the `test:e2e` script does).
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { startHolidayStandIn } from './holiday-stand-in.mjs';
import { databaseUrl, E2E_DATABASE, ensureTestPostgres } from './test-postgres.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const adminUrl = ensureTestPostgres();
const database = E2E_DATABASE;

const admin = new pg.Client({ connectionString: adminUrl });
await admin.connect();
await admin.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
await admin.query(`CREATE DATABASE ${database}`);
await admin.end();

// Stand-in for holiday-cn on jsDelivr, so e2e runs never reach the internet.
const { port: holidayPort } = await startHolidayStandIn();

const child = spawn(process.execPath, [path.join(repoRoot, 'packages/server/dist/main.js')], {
  stdio: 'inherit',
  env: {
    ...process.env,
    HOST: '127.0.0.1',
    PORT: process.env.E2E_PORT ?? '18090',
    PUBLIC_URL: `http://127.0.0.1:${process.env.E2E_PORT ?? '18090'}`,
    DATABASE_URL: databaseUrl(adminUrl, database),
    DATA_DIR: path.join(repoRoot, 'test-results', 'e2e-data'),
    WEB_DIST_DIR: path.join(repoRoot, 'packages/web/dist'),
    LOG_LEVEL: 'warn',
    HOLIDAY_DATA_URL: `http://127.0.0.1:${holidayPort}`,
    // Fixed test key so 通知渠道 can be saved (e2e/notification-channels.spec.ts).
    APP_ENCRYPTION_KEY: Buffer.alloc(32, 'e2e-key').toString('base64'),
    // First start creates this 管理员 (e2e/auth.spec.ts logs in with it).
    INITIAL_ADMIN_USERNAME: 'admin',
    INITIAL_ADMIN_PASSWORD: 'e2e-admin-password',
  },
});
for (const signal of /** @type {const} */ (['SIGINT', 'SIGTERM'])) {
  process.on(signal, () => child.kill(signal));
}
child.on('exit', (code) => process.exit(code ?? 0));

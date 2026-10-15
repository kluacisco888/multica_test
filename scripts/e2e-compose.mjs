// End-to-end run against a real `docker compose` deployment (EURO-33, README「测试」).
//
//   node scripts/e2e-compose.mjs [--project-name dd-e2e] [--port 18190] [--pg-port 18191] [--keep] [--] [<playwright args>]
//
// 1. Checks the ports are free and the compose project does not exist yet.
// 2. `cp .env.example <run>/.env` (run dir: test-results/compose-e2e/<name>)
//    and fills in the port, secrets, the e2e admin password and a local
//    holiday-cn stand-in. The repo's own `.env` is not used or touched.
// 3. `docker compose -p <name> -f docker-compose.yml -f docker-compose.e2e.yml up -d --build --wait`.
// 4. Runs Playwright against http://127.0.0.1:<port> (no scripts/e2e-server.mjs).
//    Fake SMTP / 飞书 receivers and the holiday stand-in listen on the Docker
//    bridge gateway; the app container reaches them as host.docker.internal.
// 5. Unless --keep: `docker compose -p <name> down -v`, then checks that no
//    container, volume or network of the project is left.
// Exit code: Playwright's (or 1 when setup or cleanup fails).
import { execFileSync, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startHolidayStandIn } from './holiday-stand-in.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** @param {string[]} argv */
function parseArgs(argv) {
  /** @type {{ name: string, port: number, pgPort: number, keep: boolean, playwright: string[] }} */
  const opts = { name: 'dd-e2e', port: 18190, pgPort: 18191, keep: false, playwright: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--') {
      opts.playwright = argv.slice(i + 1);
      break;
    } else if (arg === '--project-name') opts.name = String(argv[++i]);
    else if (arg === '--port') opts.port = Number(argv[++i]);
    else if (arg === '--pg-port') opts.pgPort = Number(argv[++i]);
    else if (arg === '--keep') opts.keep = true;
    else {
      // Anything else (e.g. `pnpm test:e2e:compose --project=mobile`, where pnpm drops the `--`) is for Playwright.
      opts.playwright = argv.slice(i);
      break;
    }
  }
  // Never the production project name, never Multica's.
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(opts.name) || /^(dida-clone|multica)$/.test(opts.name)) {
    throw new Error(`refusing compose project name ${JSON.stringify(opts.name)}`);
  }
  for (const p of [opts.port, opts.pgPort]) if (!Number.isInteger(p) || p < 1024 || p > 65535) throw new Error(`bad port ${p}`);
  return opts;
}

/**
 * Resolve when nothing listens on 127.0.0.1:port (we can bind it ourselves).
 * @param {number} port
 * @returns {Promise<void>}
 */
function assertPortFree(port) {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', () => reject(new Error(`port 127.0.0.1:${port} is in use; pick another with --port / --pg-port`)));
    probe.listen(port, '127.0.0.1', () => probe.close(() => resolve(undefined)));
  });
}

/** @param {string[]} args */
const docker = (args) => execFileSync('docker', args, { encoding: 'utf8' }).trim();

/** Gateway of Docker's default bridge: what `host-gateway` resolves to inside containers. */
function bridgeGateway() {
  return docker(['network', 'inspect', 'bridge', '--format', '{{(index .IPAM.Config 0).Gateway}}']);
}

/**
 * Leftovers of the compose project: containers, volumes, networks (all labelled by compose).
 * @param {string} name
 */
function leftovers(name) {
  const label = `label=com.docker.compose.project=${name}`;
  return {
    containers: docker(['ps', '-a', '--filter', label, '--format', '{{.Names}}']).split('\n').filter(Boolean),
    volumes: docker(['volume', 'ls', '--filter', label, '--format', '{{.Name}}']).split('\n').filter(Boolean),
    networks: docker(['network', 'ls', '--filter', label, '--format', '{{.Name}}']).split('\n').filter(Boolean),
  };
}

/**
 * `.env.example` with these keys set (commented-out keys are uncommented).
 * @param {string} file
 * @param {Record<string, string | number>} values
 */
function writeEnv(file, values) {
  copyFileSync(path.join(repoRoot, '.env.example'), file);
  let text = readFileSync(file, 'utf8');
  for (const [key, value] of Object.entries(values)) {
    const line = new RegExp(`^#? ?${key}=.*$`, 'm');
    text = line.test(text) ? text.replace(line, `${key}=${value}`) : `${text}\n${key}=${value}\n`;
  }
  writeFileSync(file, text, { mode: 0o600 });
}

const opts = parseArgs(process.argv.slice(2));
const existing = leftovers(opts.name);
if (existing.containers.length || existing.volumes.length) {
  throw new Error(`compose project ${opts.name} already exists (${[...existing.containers, ...existing.volumes].join(', ')}); clean it up first`);
}
await assertPortFree(opts.port);
await assertPortFree(opts.pgPort);

const gateway = bridgeGateway();
const holiday = await startHolidayStandIn(gateway);

const runDir = path.join(repoRoot, 'test-results', 'compose-e2e', opts.name);
mkdirSync(runDir, { recursive: true });
const envFile = path.join(runDir, '.env');
const postgresPassword = randomBytes(12).toString('hex');
writeEnv(envFile, {
  APP_PORT: opts.port,
  PUBLIC_URL: `http://127.0.0.1:${opts.port}`,
  POSTGRES_PASSWORD: postgresPassword,
  APP_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
  // e2e/auth.spec.ts logs in as this 管理员.
  INITIAL_ADMIN_PASSWORD: 'e2e-admin-password',
  HOLIDAY_DATA_URL: `http://host.docker.internal:${holiday.port}`,
  LOG_LEVEL: 'warn',
});

const composeEnv = { ...process.env, E2E_ENV_FILE: envFile, E2E_PG_PORT: String(opts.pgPort) };
/**
 * Run a child process to the end without blocking this process's event loop:
 * the holiday stand-in above must keep answering the app meanwhile.
 * @param {string} command
 * @param {string[]} args
 * @param {import('node:child_process').SpawnOptions} options
 * @returns {Promise<number>}
 */
function run(command, args, options) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: 'inherit', ...options });
    child.on('error', (error) => {
      console.error(`[e2e-compose] cannot run ${command}: ${error.message}`);
      resolve(1);
    });
    child.on('exit', (code) => resolve(code ?? 1));
  });
}
/** @param {string[]} args */
const compose = (args) =>
  run(
    'docker',
    ['compose', '-p', opts.name, '-f', 'docker-compose.yml', '-f', 'docker-compose.e2e.yml', '--env-file', envFile, ...args],
    { cwd: repoRoot, env: composeEnv },
  );

// Ctrl+C reaches Playwright too; let it stop and still clean up below.
process.on('SIGINT', () => {});

let exitCode = 1;
try {
  console.log(`[e2e-compose] project ${opts.name}, app 127.0.0.1:${opts.port}, fakes on ${gateway}`);
  if ((await compose(['up', '-d', '--build', '--wait'])) !== 0) throw new Error('docker compose up failed');
  const health = await fetch(`http://127.0.0.1:${opts.port}/api/health`);
  console.log(`[e2e-compose] GET /api/health → ${health.status} ${await health.text()}`);
  if (!health.ok) throw new Error('health check failed');

  exitCode = await run(process.execPath, [path.join(repoRoot, 'node_modules/@playwright/test/cli.js'), 'test', ...opts.playwright], {
    cwd: repoRoot,
    stdio: 'inherit',
    env: {
      ...process.env,
      E2E_BASE_URL: `http://127.0.0.1:${opts.port}`,
      E2E_COMPOSE_APP: `${opts.name}-app-1`,
      E2E_DATABASE_URL: `postgres://dida:${postgresPassword}@127.0.0.1:${opts.pgPort}/dida`,
      E2E_FAKE_BIND: gateway,
      E2E_FAKE_HOST: 'host.docker.internal',
    },
  });
} catch (error) {
  console.error(`[e2e-compose] ${error instanceof Error ? error.message : error}`);
  await compose(['logs', '--tail', '100', 'app']);
} finally {
  holiday.server.close();
  if (opts.keep) {
    console.log(
      `[e2e-compose] --keep: left running. Clean up with:\n  E2E_ENV_FILE=${envFile} E2E_PG_PORT=${opts.pgPort} ` +
        `docker compose -p ${opts.name} -f docker-compose.yml -f docker-compose.e2e.yml --env-file ${envFile} down -v`,
    );
  } else {
    const down = await compose(['down', '-v']);
    const left = leftovers(opts.name);
    console.log(`[e2e-compose] docker compose -p ${opts.name} down -v → exit ${down}; left: ${JSON.stringify(left)}`);
    if (down !== 0 || left.containers.length || left.volumes.length || left.networks.length) exitCode = 1;
  }
}
process.exit(exitCode);

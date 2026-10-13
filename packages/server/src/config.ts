import { z } from 'zod';

export type TrustProxy = boolean | number | string[];

export interface AppConfig {
  host: string;
  port: number;
  /** External base URL without trailing slash, e.g. https://todo.example.com */
  publicUrl: string;
  databaseUrl: string;
  /** Which hops may set X-Forwarded-* headers; passed to Fastify `trustProxy`. */
  trustProxy: TrustProxy;
  /** Persistent data volume; attachments live in `<dataDir>/attachments`. */
  dataDir: string;
  /** Built web app to serve as static files; omitted in API-only test runs. */
  webDistDir: string | undefined;
  defaultTimezone: string;
  /** Base URL of the NateScarlet/holiday-cn year files (`<url>/<year>.json`), ADR-0006. */
  holidayDataUrl: string;
  logLevel: string;
  /** First 管理员, created on start when the database has no user (see accounts.bootstrapAdmin). */
  initialAdmin: { username: string | undefined; password: string | undefined };
}

function parseTrustProxy(value: string): TrustProxy {
  const trimmed = value.trim();
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;
  if (/^\d+$/.test(trimmed)) return Number(trimmed);
  return trimmed
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
}

const envSchema = z.object({
  HOST: z.string().min(1).default('0.0.0.0'),
  PORT: z.coerce.number().int().min(1).max(65535).default(8090),
  PUBLIC_URL: z.url().default('http://127.0.0.1:8090'),
  DATABASE_URL: z.string().min(1),
  TRUST_PROXY: z.string().default('loopback,linklocal,uniquelocal'),
  DATA_DIR: z.string().min(1).default('/data'),
  WEB_DIST_DIR: z.string().min(1).optional(),
  DEFAULT_TIMEZONE: z.string().min(1).default('Asia/Shanghai'),
  HOLIDAY_DATA_URL: z.url().default('https://cdn.jsdelivr.net/gh/NateScarlet/holiday-cn@master'),
  INITIAL_ADMIN_USERNAME: z.string().trim().min(1).optional(),
  INITIAL_ADMIN_PASSWORD: z.string().min(1).optional(),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
});

/** Parse process environment into typed config; throws listing every invalid variable. */
export function loadConfig(env: Record<string, string | undefined>): AppConfig {
  // Treat empty strings (e.g. `PUBLIC_URL=` in .env) as "not set" so defaults apply.
  const cleaned = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined && v !== ''));
  const result = envSchema.safeParse(cleaned);
  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
      .join('; ');
    throw new Error(`Invalid configuration: ${details}`);
  }
  const parsed = result.data;
  return {
    host: parsed.HOST,
    port: parsed.PORT,
    publicUrl: parsed.PUBLIC_URL.replace(/\/+$/, ''),
    databaseUrl: parsed.DATABASE_URL,
    trustProxy: parseTrustProxy(parsed.TRUST_PROXY),
    dataDir: parsed.DATA_DIR,
    webDistDir: parsed.WEB_DIST_DIR,
    defaultTimezone: parsed.DEFAULT_TIMEZONE,
    holidayDataUrl: parsed.HOLIDAY_DATA_URL.replace(/\/+$/, ''),
    logLevel: parsed.LOG_LEVEL,
    initialAdmin: { username: parsed.INITIAL_ADMIN_USERNAME, password: parsed.INITIAL_ADMIN_PASSWORD },
  };
}

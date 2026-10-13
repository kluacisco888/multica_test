import { createAccounts } from './accounts.js';
import { CLI_USAGE, runCli, type CliIo } from './admin-cli.js';
import { systemClock } from './clock.js';
import { loadConfig } from './config.js';
import { createDatabase } from './db/client.js';
import { runMigrations } from './db/migrations.js';
import { createSessionStore } from './sessions.js';

// Admin CLI. In the container: `dida <command>` (wrapper for `node /app/dist/cli.js`).

/** Read one line from a TTY without echoing it. */
function promptHidden(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    process.stderr.write(prompt);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    let value = '';
    const done = (error?: Error) => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.off('data', onData);
      process.stderr.write('\n');
      if (error) reject(error);
      else resolve(value);
    };
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') return done();
        if (ch === '\u0003' || ch === '\u0004') return done(new Error('已取消'));
        if (ch === '\u007f' || ch === '\b') value = value.slice(0, -1);
        else value += ch;
      }
    };
    stdin.on('data', onData);
  });
}

let pipedLines: Promise<string[]> | undefined;
async function readPipedLine(): Promise<string> {
  pipedLines ??= (async () => {
    let data = '';
    for await (const chunk of process.stdin) data += chunk;
    return data.split(/\r?\n/);
  })();
  const lines = await pipedLines;
  return lines.shift() ?? '';
}

const io: CliIo = {
  async readPassword(prompt) {
    if (!process.stdin.isTTY) return readPipedLine();
    const first = await promptHidden(prompt);
    const second = await promptHidden('再输入一次: ');
    if (first !== second) throw new Error('两次输入的密码不一致');
    return first;
  },
  out: (line) => console.log(line),
  err: (line) => console.error(line),
};

const argv = process.argv.slice(2);
if (argv.length === 0 || ['help', '--help', '-h'].includes(argv[0] ?? '')) {
  console.log(CLI_USAGE);
  process.exit(argv.length === 0 ? 2 : 0);
}

const config = loadConfig(process.env);
const database = createDatabase(config.databaseUrl);
let code = 1;
try {
  // Lets `create-user` run before the app has ever started.
  await runMigrations(database.db);
  const sessions = createSessionStore(database.db, systemClock);
  code = await runCli(argv, createAccounts(database.db, sessions, systemClock), io);
} catch (error) {
  console.error(`错误：${error instanceof Error ? error.message : String(error)}`);
} finally {
  await database.close();
}
process.exit(code);

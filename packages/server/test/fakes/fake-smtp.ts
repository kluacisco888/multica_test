import { once } from 'node:events';
import net from 'node:net';

/** One message accepted by the fake SMTP server. */
export interface ReceivedMail {
  from: string;
  to: string[];
  /** Raw RFC 5322 message (headers + body), dot-unstuffed, CRLF line endings. */
  raw: string;
  /** Credentials from AUTH PLAIN / AUTH LOGIN, if the client authenticated. */
  auth: { username: string; password: string } | null;
  /** Convenience: the Subject header, if present. */
  subject: string | undefined;
}

export interface FakeSmtpOptions {
  /** When set, AUTH is required and must match these credentials. */
  credentials?: { username: string; password: string };
  /**
   * Reply code for the next N messages' final DATA (e.g. [451, 451] makes the
   * first two deliveries fail temporarily). Defaults to 250.
   */
  dataReplies?: number[];
}

export interface FakeSmtpServer {
  host: string;
  port: number;
  messages: ReceivedMail[];
  /** Queue reply codes for upcoming DATA commands (see FakeSmtpOptions.dataReplies). */
  failNext(...codes: number[]): void;
  /** Resolve once `count` messages have been accepted. */
  waitForMessages(count: number, timeoutMs?: number): Promise<ReceivedMail[]>;
  close(): Promise<void>;
}

const decode = (b64: string) => Buffer.from(b64, 'base64').toString('utf8');

/**
 * Minimal in-process SMTP server for tests: plain TCP on 127.0.0.1, no TLS.
 * Point the mailer at it with `secure: false, ignoreTLS: true`.
 */
export async function startFakeSmtp(options: FakeSmtpOptions = {}): Promise<FakeSmtpServer> {
  const messages: ReceivedMail[] = [];
  const replies = [...(options.dataReplies ?? [])];
  const waiters: (() => void)[] = [];
  const sockets = new Set<net.Socket>();

  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.setEncoding('utf8');
    const send = (line: string) => socket.write(`${line}\r\n`);

    let buffer = '';
    let mode: 'command' | 'data' | 'auth-login-user' | 'auth-login-pass' = 'command';
    let from = '';
    let to: string[] = [];
    let data: string[] = [];
    let auth: ReceivedMail['auth'] = null;
    let loginUser = '';

    const authenticate = (username: string, password: string) => {
      const expected = options.credentials;
      if (expected && (expected.username !== username || expected.password !== password)) {
        send('535 5.7.8 Authentication credentials invalid');
        return;
      }
      auth = { username, password };
      send('235 2.7.0 Authentication successful');
    };

    const handleLine = (line: string) => {
      if (mode === 'data') {
        if (line === '.') {
          mode = 'command';
          const code = replies.shift() ?? 250;
          if (code === 250) {
            const raw = data.join('\r\n');
            const subject = /^Subject: (.*)$/im.exec(raw)?.[1];
            messages.push({ from, to, raw, auth, subject });
            waiters.splice(0).forEach((wake) => wake());
            send('250 2.0.0 OK queued');
          } else {
            send(`${code} fake failure`);
          }
          from = '';
          to = [];
          data = [];
          return;
        }
        data.push(line.startsWith('..') ? line.slice(1) : line);
        return;
      }
      if (mode === 'auth-login-user') {
        loginUser = decode(line);
        mode = 'auth-login-pass';
        send('334 UGFzc3dvcmQ6');
        return;
      }
      if (mode === 'auth-login-pass') {
        mode = 'command';
        authenticate(loginUser, decode(line));
        return;
      }

      const [verb = '', ...rest] = line.split(' ');
      const arg = rest.join(' ');
      switch (verb.toUpperCase()) {
        case 'EHLO':
          send('250-fake-smtp');
          send('250-AUTH PLAIN LOGIN');
          send('250 8BITMIME');
          break;
        case 'HELO':
          send('250 fake-smtp');
          break;
        case 'AUTH': {
          const [mechanism = '', initial] = arg.split(' ');
          if (mechanism.toUpperCase() === 'PLAIN' && initial) {
            const [, username = '', password = ''] = decode(initial).split('\0');
            authenticate(username, password);
          } else if (mechanism.toUpperCase() === 'LOGIN') {
            mode = 'auth-login-user';
            send('334 VXNlcm5hbWU6');
          } else {
            send('504 5.5.4 Unsupported mechanism');
          }
          break;
        }
        case 'MAIL':
          if (options.credentials && !auth) {
            send('530 5.7.0 Authentication required');
            break;
          }
          from = /<([^>]*)>/.exec(arg)?.[1] ?? '';
          send('250 OK');
          break;
        case 'RCPT':
          to.push(/<([^>]*)>/.exec(arg)?.[1] ?? '');
          send('250 OK');
          break;
        case 'DATA':
          mode = 'data';
          send('354 End data with <CR><LF>.<CR><LF>');
          break;
        case 'RSET':
          from = '';
          to = [];
          data = [];
          send('250 OK');
          break;
        case 'NOOP':
          send('250 OK');
          break;
        case 'QUIT':
          send('221 Bye');
          socket.end();
          break;
        default:
          send('502 5.5.2 Command not implemented');
      }
    };

    socket.on('data', (chunk: string) => {
      buffer += chunk;
      let index: number;
      while ((index = buffer.indexOf('\r\n')) !== -1) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        handleLine(line);
      }
    });
    send('220 fake-smtp ESMTP ready');
  });

  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as net.AddressInfo;

  return {
    host: '127.0.0.1',
    port,
    messages,
    failNext(...codes) {
      replies.push(...codes);
    },
    async waitForMessages(count, timeoutMs = 5_000) {
      const deadline = Date.now() + timeoutMs;
      while (messages.length < count) {
        if (Date.now() > deadline) throw new Error(`expected ${count} mails, got ${messages.length}`);
        await new Promise<void>((resolve) => {
          waiters.push(resolve);
          setTimeout(resolve, 50);
        });
      }
      return messages.slice(0, count);
    },
    async close() {
      sockets.forEach((s) => s.destroy());
      server.close();
      await once(server, 'close');
    },
  };
}

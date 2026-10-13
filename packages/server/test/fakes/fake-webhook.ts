import { once } from 'node:events';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

export interface ReceivedWebhook {
  method: string;
  path: string;
  headers: http.IncomingHttpHeaders;
  rawBody: string;
  /** Parsed JSON body, or undefined if the body was not JSON. */
  json: unknown;
  /** Status code the fake answered with. */
  status: number;
}

export interface FakeWebhookReply {
  status: number;
  body?: unknown;
}

export interface FakeWebhookServer {
  /** Base URL, e.g. http://127.0.0.1:43210 — append any path. */
  url: string;
  requests: ReceivedWebhook[];
  /** Queue replies for the next requests (default reply afterwards: 200 `{code:0}`). */
  replyNext(...replies: FakeWebhookReply[]): void;
  waitForRequests(count: number, timeoutMs?: number): Promise<ReceivedWebhook[]>;
  close(): Promise<void>;
}

/** Default reply mimics a Feishu bot accepting the message. */
const OK: FakeWebhookReply = { status: 200, body: { code: 0, msg: 'success' } };

/** In-process HTTP endpoint that records every request it receives. */
export async function startFakeWebhook(): Promise<FakeWebhookServer> {
  const requests: ReceivedWebhook[] = [];
  const queued: FakeWebhookReply[] = [];

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const rawBody = Buffer.concat(chunks).toString('utf8');
      let json: unknown;
      try {
        json = rawBody ? JSON.parse(rawBody) : undefined;
      } catch {
        json = undefined;
      }
      const reply = queued.shift() ?? OK;
      requests.push({
        method: req.method ?? 'GET',
        path: req.url ?? '/',
        headers: req.headers,
        rawBody,
        json,
        status: reply.status,
      });
      res.writeHead(reply.status, { 'content-type': 'application/json' });
      res.end(reply.body === undefined ? '' : JSON.stringify(reply.body));
    });
  });

  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    replyNext(...replies) {
      queued.push(...replies);
    },
    async waitForRequests(count, timeoutMs = 5_000) {
      const deadline = Date.now() + timeoutMs;
      while (requests.length < count) {
        if (Date.now() > deadline) throw new Error(`expected ${count} requests, got ${requests.length}`);
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      return requests.slice(0, count);
    },
    async close() {
      server.closeAllConnections();
      server.close();
      await once(server, 'close');
    },
  };
}

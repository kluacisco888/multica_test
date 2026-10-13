import { once } from 'node:events';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

/** What the fake answers for one `<year>.json`: a JSON body, a status code, or raw text. */
export type FakeYearReply = { json: unknown } | { status: number } | { raw: string };

export interface FakeHolidayCn {
  /** Use as HOLIDAY_DATA_URL; files are requested as `<url>/<year>.json`. */
  url: string;
  /** Requested paths, in order. */
  requests: string[];
  /** Set the reply for a year; years without a reply answer 404 (not published). */
  set(year: number, reply: FakeYearReply): void;
  close(): Promise<void>;
}

/** Stand-in for jsDelivr serving NateScarlet/holiday-cn, so tests never reach the internet. */
export async function startFakeHolidayCn(): Promise<FakeHolidayCn> {
  const replies = new Map<number, FakeYearReply>();
  const requests: string[] = [];
  const server = http.createServer((req, res) => {
    requests.push(req.url ?? '/');
    const match = /^\/(\d{4})\.json$/.exec(req.url ?? '');
    const reply = match ? replies.get(Number(match[1])) : undefined;
    if (!reply) {
      res.writeHead(404, { 'content-type': 'text/plain' }).end('Not Found');
    } else if ('json' in reply) {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(reply.json));
    } else if ('raw' in reply) {
      res.writeHead(200, { 'content-type': 'application/json' }).end(reply.raw);
    } else {
      res.writeHead(reply.status, { 'content-type': 'text/plain' }).end('error');
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    set: (year, reply) => void replies.set(year, reply),
    close: () =>
      new Promise((resolve, reject) => {
        server.closeAllConnections();
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

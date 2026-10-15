// Stand-in for holiday-cn on jsDelivr (节假日数据), so e2e runs never reach the
// internet: serves the files built into the image, 404 for years without one.
// Used by scripts/e2e-server.mjs and scripts/e2e-compose.mjs.
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const holidayDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../packages/server/holidays');

/**
 * Listen on `bind` (any free port) and resolve to the server and its port.
 * @param {string} bind
 * @returns {Promise<{ server: http.Server, port: number }>}
 */
export async function startHolidayStandIn(bind = '127.0.0.1') {
  const server = http.createServer(async (req, res) => {
    const match = /^\/(\d{4})\.json$/.exec(req.url ?? '');
    const body = match ? await readFile(path.join(holidayDir, `${match[1]}.json`)).catch(() => null) : null;
    if (body) res.writeHead(200, { 'content-type': 'application/json' }).end(body);
    else res.writeHead(404).end('Not Found');
  });
  server.listen(0, bind);
  await once(server, 'listening');
  const { port } = /** @type {import('node:net').AddressInfo} */ (server.address());
  return { server, port };
}

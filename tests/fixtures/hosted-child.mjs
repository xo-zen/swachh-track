import { appendFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';

const name = process.argv[2];
const scenario = process.env.SCENARIO;
const record = (event, extra = {}) => appendFileSync(process.env.EVENT_LOG, `${JSON.stringify({ name, event, pid: process.pid, ...extra })}\n`);
let server;
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    record(signal);
    if ((scenario === 'stubborn' && name === 'web') || name === 'descendant') return;
    setTimeout(() => {
      server?.close();
      record('clean-exit');
      process.exit(0);
    }, 60);
  });
}
process.on('SIGUSR2', () => { record('crash'); process.exit(23); });
record('start', { env: Object.fromEntries(['NODE_ENV', 'HOSTED_DEMO', 'DEMO_MODE', 'HOST', 'PORT', 'API_PUBLIC_URL', 'CORS_ORIGINS', 'API_INTERNAL_URL', 'NEXT_PUBLIC_API_URL', 'NEXT_PUBLIC_HOSTED_DEMO', 'NEXT_PUBLIC_DEMO_MODE', 'DATABASE_URL', 'JWT_SECRET', 'S3_SECRET_KEY'].map(key => [key, process.env[key]])) });
if (scenario === `${name}-fail`) process.exit(23);
if (['storage', 'migrate', 'seed'].includes(name) && scenario !== `${name}-hang`) process.exit(0);

let probes = 0;
server = createServer((request, response) => {
  if (request.url !== '/api/v1/readyz') { response.writeHead(404).end(); return; }
  if (scenario === 'hanging-timeout') return;
  const ready = scenario !== 'readiness-timeout' && ++probes > 1;
  record(ready ? 'ready' : 'not-ready');
  response.writeHead(ready ? 200 : 503).end();
});
server.listen(name === 'api' ? Number(process.env.FAKE_API_PORT) : 0, '127.0.0.1', () => {
  record('listening');
  if (name === 'web' && scenario === 'descendant') spawn(process.execPath, [process.argv[1], 'descendant'], { stdio: 'ignore' });
});

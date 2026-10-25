import { createServer } from 'node:net';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { runHostedDemo } from '../../scripts/start-hosted-demo.mjs';

// Use an ephemeral loopback port, never the developer's real API or external services.
const reservation = createServer().listen(0, '127.0.0.1');
await once(reservation, 'listening');
const port = reservation.address().port;
await new Promise(resolve => reservation.close(resolve));
const fixture = fileURLToPath(new URL('./hosted-child.mjs', import.meta.url));
try {
  await runHostedDemo({
    env: { ...process.env, FAKE_API_PORT: String(port) },
    commands: Object.fromEntries(['storage', 'migrate', 'seed', 'api', 'web'].map(name => [name, [fixture, name]])),
    readyUrl: `http://127.0.0.1:${port}/api/v1/readyz`,
    readyTimeoutMs: process.env.SCENARIO?.includes('timeout') ? 500 : 5000,
    shutdownTimeoutMs: 200,
  });
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}

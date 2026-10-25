import 'dotenv/config';
import { buildApp } from './app.js';

const app = await buildApp();
await app.listen({ host: app.config.HOST, port: app.config.PORT });
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, async () => { await app.close(); process.exit(0); });

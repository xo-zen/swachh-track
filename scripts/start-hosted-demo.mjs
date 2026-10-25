import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const root = fileURLToPath(new URL('../', import.meta.url));

export function hostedEnvironments(env) {
  if (env.HOSTED_DEMO !== 'true' || env.DEMO_MODE !== 'true') {
    throw new Error('Hosted startup requires explicit HOSTED_DEMO=true and DEMO_MODE=true. Use dedicated fictional-demo resources only.');
  }
  const noAuth = env.NO_AUTH ?? 'true';
  if (!['true', 'false'].includes(noAuth)) throw new Error('NO_AUTH must be true or false.');
  const required = key => {
    const value = env[key];
    if (!value?.trim() || /CHANGE_ME|REPLACE_ME/i.test(value)) throw new Error(`${key} must be explicitly configured for the dedicated fictional demo.`);
    return value;
  };
  const url = (value, key) => {
    try { return new URL(value); }
    catch { throw new Error(`${key} must be a valid URL.`); }
  };
  const database = url(required('DATABASE_URL'), 'DATABASE_URL');
  if (!['postgres:', 'postgresql:'].includes(database.protocol) || !database.hostname || !database.username || !database.password || database.pathname.length < 2) {
    throw new Error('DATABASE_URL must identify a dedicated PostgreSQL database with explicit credentials.');
  }
  for (const key of ['JWT_SECRET', 'QR_SECRET']) {
    if (required(key).length < 32) throw new Error(`${key} must contain at least 32 characters.`);
  }
  if (env.JWT_SECRET === env.QR_SECRET) throw new Error('JWT_SECRET and QR_SECRET must be different dedicated signing secrets.');
  if (required('STORAGE_DRIVER') !== 's3') throw new Error('Hosted startup requires STORAGE_DRIVER=s3.');
  for (const key of ['S3_REGION', 'S3_BUCKET', 'S3_ACCESS_KEY', 'S3_SECRET_KEY']) required(key);
  for (const key of ['S3_ENDPOINT', 'S3_PUBLIC_ENDPOINT']) {
    const endpoint = url(required(key), key);
    if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw new Error(`${key} must be an HTTPS endpoint without embedded credentials, query, or fragment.`);
  }
  const origin = url(env.API_PUBLIC_URL ?? required('RENDER_EXTERNAL_URL'), 'API_PUBLIC_URL / RENDER_EXTERNAL_URL');
  if (origin.protocol !== 'https:' || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) {
    throw new Error('API_PUBLIC_URL / RENDER_EXTERNAL_URL must be an HTTPS origin without credentials, path, query, or fragment.');
  }
  const port = env.PORT ?? '10000';
  if (!/^[1-9]\d{0,4}$/.test(port) || Number(port) > 65535 || Number(port) === 4000) {
    throw new Error('PORT must be 1-65535 and must not use the internal API port 4000.');
  }
  const api = {
    ...env, NODE_ENV: 'development', HOSTED_DEMO: 'true', DEMO_MODE: 'true', NO_AUTH: noAuth,
    HOST: '127.0.0.1', PORT: '4000', API_PUBLIC_URL: origin.origin, CORS_ORIGINS: origin.origin,
  };
  const web = {
    ...env, NODE_ENV: 'production', HOSTED_DEMO: 'false', DEMO_MODE: 'false', NO_AUTH: 'false',
    HOST: '0.0.0.0', PORT: port, API_INTERNAL_URL: 'http://127.0.0.1:4000',
    NEXT_PUBLIC_API_URL: '/api/v1', NEXT_PUBLIC_HOSTED_DEMO: 'true', NEXT_PUBLIC_DEMO_MODE: 'false',
    NEXT_TELEMETRY_DISABLED: '1',
  };
  for (const key of Object.keys(web)) {
    if (/^(DATABASE_URL|JWT_SECRET|QR_SECRET|S3_.*|REDIS_URL|SWACHHATA_WEBHOOK_SECRET|WHATSAPP_WEBHOOK_SECRET)$/.test(key)) delete web[key];
  }
  return { api, web };
}

export async function runHostedDemo({ env = process.env, commands, readyUrl = 'http://127.0.0.1:4000/api/v1/readyz', readyTimeoutMs = 60000, shutdownTimeoutMs = 10000 } = {}) {
  const { api, web } = hostedEnvironments(env);
  commands ??= {
    storage: ['--import', 'tsx', 'apps/api/src/init-storage.ts', '--check'],
    migrate: ['node_modules/prisma/build/index.js', 'migrate', 'deploy'],
    seed: ['--import', 'tsx', 'prisma/seed.ts'],
    api: ['--import', 'tsx', 'apps/api/src/server.ts'],
    web: ['apps/web/node_modules/next/dist/bin/next', 'start', 'apps/web', '--hostname', '0.0.0.0', '--port', web.PORT],
  };
  const children = [];
  const controller = new AbortController();
  let failure;
  let stopped;
  const stopping = new Promise(resolve => { stopped = resolve; });
  const stop = error => {
    if (controller.signal.aborted) return;
    failure = error;
    controller.abort();
    stopped();
  };
  const onSignal = () => stop();
  process.on('SIGTERM', onSignal);
  process.on('SIGINT', onSignal);
  const start = (name, childEnv, oneShot = false) => {
    // Direct Node entry points avoid pnpm wrappers; groups also cover engine/Next descendants.
    const child = spawn(process.execPath, commands[name], { cwd: root, env: childEnv, stdio: 'inherit', detached: true });
    const closed = new Promise(resolve => {
      child.once('error', () => stop(new Error(`${name} could not start.`)));
      child.once('close', (code, signal) => {
        if (!oneShot || code !== 0) stop(new Error(`${name} exited unexpectedly (${signal ?? code}).`));
        resolve();
      });
    });
    children.push({ child, closed });
    return closed;
  };
  const terminate = signal => {
    for (const { child } of children) {
      if (!child.pid) continue;
      try { process.kill(-child.pid, signal); }
      catch (error) { if (error.code !== 'ESRCH') failure ??= error; }
    }
  };
  try {
    for (const step of ['storage', 'migrate', 'seed']) {
      if (controller.signal.aborted) break;
      await Promise.race([start(step, api, true), stopping]);
    }
    if (!controller.signal.aborted) {
      start('api', api);
      const deadline = Date.now() + readyTimeoutMs;
      let ready = false;
      while (!controller.signal.aborted && Date.now() < deadline) {
        try {
          const signal = globalThis.AbortSignal.any([controller.signal, globalThis.AbortSignal.timeout(Math.min(1000, Math.max(1, deadline - Date.now())))]);
          const response = await fetch(readyUrl, { signal, redirect: 'error' });
          ready = response.ok;
          await response.body?.cancel();
        } catch { /* Not listening or not ready yet. */ }
        if (ready) break;
        await delay(100, undefined, { signal: controller.signal }).catch(() => {});
      }
      if (!controller.signal.aborted) {
        if (!ready) throw new Error('API readiness timed out.');
        start('web', web);
        await stopping;
      }
    }
  } catch (error) { stop(error); }
  finally {
    stop();
    terminate('SIGTERM');
    const force = setTimeout(() => terminate('SIGKILL'), shutdownTimeoutMs);
    await Promise.all(children.map(({ closed }) => closed));
    // A child may exit before its descendants. Never leave its process group running.
    terminate('SIGKILL');
    clearTimeout(force);
    process.off('SIGTERM', onSignal);
    process.off('SIGINT', onSignal);
  }
  if (failure) throw failure;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runHostedDemo().catch(error => { console.error(error.message); process.exitCode = 1; });
}

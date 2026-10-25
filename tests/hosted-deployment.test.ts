import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { hostedEnvironments } from '../scripts/start-hosted-demo.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const base = {
  HOSTED_DEMO: 'true', DEMO_MODE: 'true', NODE_ENV: 'production', STORAGE_DRIVER: 's3',
  DATABASE_URL: 'postgresql://demo:fake-password@db.invalid/fictional_demo',
  JWT_SECRET: 'fictional-test-jwt-secret-at-least-32-characters',
  QR_SECRET: 'fictional-test-qr-secret-at-least-32-characters',
  S3_ENDPOINT: 'https://s3.invalid', S3_PUBLIC_ENDPOINT: 'https://s3.invalid',
  S3_REGION: 'us-east-1', S3_BUCKET: 'fictional-demo', S3_ACCESS_KEY: 'fake-access', S3_SECRET_KEY: 'fake-secret',
  RENDER_EXTERNAL_URL: 'https://fictional-demo.onrender.com',
};

describe('hosted environment boundaries', () => {
  it('defaults to no-login for the demo API, not the production web process', () => {
    expect(hostedEnvironments(base).api.NO_AUTH).toBe('true');
    expect(hostedEnvironments(base).web.NO_AUTH).toBe('false');
    expect(hostedEnvironments({ ...base, NO_AUTH: 'false' }).api.NO_AUTH).toBe('false');
    expect(() => hostedEnvironments({ ...base, NO_AUTH: '1' })).toThrow('NO_AUTH');
  });
  it('uses a production web process and a loopback-only development demo API', () => {
    const input = { ...base, HOST: '0.0.0.0', CORS_ORIGINS: '*', API_INTERNAL_URL: 'https://wrong.invalid', NEXT_PUBLIC_DEMO_MODE: 'true' };
    const { api, web } = hostedEnvironments(input);
    expect(api).toMatchObject({ NODE_ENV: 'development', HOSTED_DEMO: 'true', DEMO_MODE: 'true', HOST: '127.0.0.1', PORT: '4000', API_PUBLIC_URL: base.RENDER_EXTERNAL_URL, CORS_ORIGINS: base.RENDER_EXTERNAL_URL });
    expect(web).toMatchObject({ NODE_ENV: 'production', HOSTED_DEMO: 'false', DEMO_MODE: 'false', HOST: '0.0.0.0', PORT: '10000', API_INTERNAL_URL: 'http://127.0.0.1:4000', NEXT_PUBLIC_API_URL: '/api/v1', NEXT_PUBLIC_HOSTED_DEMO: 'true', NEXT_PUBLIC_DEMO_MODE: 'false' });
    for (const key of ['DATABASE_URL', 'JWT_SECRET', 'QR_SECRET', 'S3_SECRET_KEY', 'S3_ACCESS_KEY']) expect(web).not.toHaveProperty(key);
    expect(input.NODE_ENV).toBe('production');
    expect(input.HOST).toBe('0.0.0.0');
  });
  it('prefers an explicit HTTPS origin, normalizes its slash and uses Render PORT', () => {
    const { api, web } = hostedEnvironments({ ...base, API_PUBLIC_URL: 'https://demo.example.org/', PORT: '65535' });
    expect(api.API_PUBLIC_URL).toBe('https://demo.example.org');
    expect(api.CORS_ORIGINS).toBe(api.API_PUBLIC_URL);
    expect(web.PORT).toBe('65535');
  });
  it.each(['HOSTED_DEMO', 'DEMO_MODE'])('requires explicit true for %s', key => {
    for (const value of [undefined, '', 'false', 'TRUE', '1']) expect(() => hostedEnvironments({ ...base, [key]: value })).toThrow('explicit');
  });
  it.each(['DATABASE_URL', 'JWT_SECRET', 'QR_SECRET', 'STORAGE_DRIVER', 'S3_ENDPOINT', 'S3_PUBLIC_ENDPOINT', 'S3_REGION', 'S3_BUCKET', 'S3_ACCESS_KEY', 'S3_SECRET_KEY', 'RENDER_EXTERNAL_URL'])('requires dedicated explicit %s, without local dotenv fallback', key => {
    expect(() => hostedEnvironments({ ...base, [key]: undefined })).toThrow(key);
    expect(() => hostedEnvironments({ ...base, [key]: '  ' })).toThrow();
  });
  it.each(['', 'http://demo.example.org', 'https://user:pass@demo.example.org', 'https://demo.example.org/path', 'https://demo.example.org/?query=1', 'https://demo.example.org/#fragment', 'not a URL'])('fails closed for an invalid explicit origin %j even with a valid Render URL', API_PUBLIC_URL => {
    expect(() => hostedEnvironments({ ...base, API_PUBLIC_URL })).toThrow();
  });
  it.each([
    ['DATABASE_URL', 'file:demo.db'], ['DATABASE_URL', 'postgresql://db.invalid/demo'],
    ['DATABASE_URL', 'postgresql://user:password@db.invalid'], ['DATABASE_URL', 'not-a-url'],
    ['JWT_SECRET', 'short'], ['QR_SECRET', 'short'], ['JWT_SECRET', base.QR_SECRET],
    ['JWT_SECRET', 'CHANGE_ME_RANDOM_SECRET_AT_LEAST_32_CHARACTERS'],
    ['STORAGE_DRIVER', 'local'], ['S3_ENDPOINT', 'http://localhost:9000'],
    ['S3_PUBLIC_ENDPOINT', 'https://user:password@s3.invalid'], ['S3_PUBLIC_ENDPOINT', 'https://s3.invalid?secret=value'],
  ])('rejects unsafe %s configuration', (key, value) => {
    expect(() => hostedEnvironments({ ...base, [key]: value })).toThrow();
  });
  it.each(['', '0', '-1', '1.5', '4000', '65536', '10000junk'])('rejects invalid or conflicting public port %j', PORT => {
    expect(() => hostedEnvironments({ ...base, PORT })).toThrow('PORT');
  });
});

type Event = { name: string; event: string; pid: number; env: Record<string, string> };
type Running = { child: ChildProcess; log: string; directory: string; output: () => string; exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }> };
const running: Running[] = [];
async function events(run: Running): Promise<Event[]> {
  const text = await readFile(run.log, 'utf8').catch(() => '');
  return text.trim() ? text.trim().split('\n').map(line => JSON.parse(line)) : [];
}
async function start(scenario = '', overrides: NodeJS.ProcessEnv = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'hosted-supervision-'));
  const log = join(directory, 'events.ndjson');
  const child = spawn(process.execPath, ['tests/fixtures/hosted-supervisor.mjs'], {
    cwd: root, env: { PATH: process.env.PATH, ...base, SCENARIO: scenario, EVENT_LOG: log, ...overrides },
    stdio: ['ignore', 'pipe', 'pipe'], detached: true,
  });
  let output = '';
  child.stdout!.on('data', chunk => { output += chunk; });
  child.stderr!.on('data', chunk => { output += chunk; });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => child.once('close', (code, signal) => resolve({ code, signal })));
  const run = { child, directory, log, output: () => output, exited };
  running.push(run);
  return run;
}
async function waitFor(run: Running, name: string, event = 'start') {
  await expect.poll(async () => (await events(run)).some(row => row.name === name && row.event === event), { timeout: 7000 }).toBe(true);
  return (await events(run)).find(row => row.name === name && row.event === event)!;
}
async function isRunning(pid: number) {
  // A killed orphan can briefly be a zombie until the container init reaps it.
  const stat = await readFile(`/proc/${pid}/stat`, 'utf8').catch(() => '');
  return stat !== '' && !/^.*\) Z /.test(stat);
}
async function expectStopped(run: Running) {
  for (const { pid } of await events(run)) await expect.poll(() => isRunning(pid), { timeout: 2000 }).toBe(false);
}
afterEach(async () => {
  for (const run of running.splice(0)) {
    if (run.child.exitCode === null && run.child.signalCode === null) run.child.kill('SIGTERM');
    const force = setTimeout(() => {
      run.child.kill('SIGKILL');
      void events(run).then(rows => rows.forEach(({ pid }) => {
        try { process.kill(-pid, 'SIGKILL'); } catch { /* Already gone or not a group leader. */ }
        try { process.kill(pid, 'SIGKILL'); } catch { /* Already gone. */ }
      }));
    }, 2000);
    await run.exited;
    clearTimeout(force);
    for (const { pid } of await events(run)) {
      try { process.kill(-pid, 'SIGKILL'); } catch { /* Already gone or not a group leader. */ }
      try { process.kill(pid, 'SIGKILL'); } catch { /* Already gone. */ }
    }
    await rm(run.directory, { recursive: true, force: true });
  }
});

describe('real child-process supervision with fake services', () => {
  it.each(['SIGTERM', 'SIGINT'] as const)('initializes in order, waits for readiness and awaits both clean exits on %s', async signal => {
    const run = await start();
    await waitFor(run, 'web', 'listening');
    const rows = await events(run);
    expect(rows.filter(row => row.event === 'start').map(row => row.name)).toEqual(['storage', 'migrate', 'seed', 'api', 'web']);
    expect(rows.findIndex(row => row.event === 'ready')).toBeLessThan(rows.findIndex(row => row.name === 'web'));
    for (const name of ['storage', 'migrate', 'seed', 'api']) expect(rows.find(row => row.name === name)!.env).toMatchObject({ NODE_ENV: 'development', HOSTED_DEMO: 'true', DEMO_MODE: 'true', HOST: '127.0.0.1', PORT: '4000', API_PUBLIC_URL: base.RENDER_EXTERNAL_URL, CORS_ORIGINS: base.RENDER_EXTERNAL_URL });
    expect(rows.find(row => row.name === 'web')!.env).toMatchObject({ NODE_ENV: 'production', HOSTED_DEMO: 'false', DEMO_MODE: 'false', PORT: '10000', NEXT_PUBLIC_HOSTED_DEMO: 'true', NEXT_PUBLIC_DEMO_MODE: 'false' });
    expect(rows.find(row => row.name === 'web')!.env).not.toHaveProperty('DATABASE_URL');
    run.child.kill(signal);
    expect(await run.exited).toEqual({ code: 0, signal: null });
    expect((await events(run)).filter(row => row.event === 'clean-exit').map(row => row.name).sort()).toEqual(['api', 'web']);
    await expectStopped(run);
  });
  it.each(['storage', 'migrate', 'seed', 'api', 'web'])('stops initialization/startup when %s fails', async name => {
    const run = await start(`${name}-fail`);
    expect((await run.exited).code).toBe(1);
    expect(run.output()).toContain(`${name} exited unexpectedly (23)`);
    const names = ['storage', 'migrate', 'seed', 'api', 'web'];
    expect((await events(run)).filter(row => row.event === 'start').map(row => row.name)).toEqual(names.slice(0, names.indexOf(name) + 1));
    await expectStopped(run);
  });
  it.each(['SIGTERM', 'SIGINT'] as const)('interrupts an in-progress initialization on %s', async signal => {
    const run = await start('seed-hang');
    await waitFor(run, 'seed', 'listening');
    run.child.kill(signal);
    expect((await run.exited).code).toBe(0);
    expect((await events(run)).some(row => row.name === 'api')).toBe(false);
    expect((await events(run)).some(row => row.name === 'seed' && row.event === 'clean-exit')).toBe(true);
    await expectStopped(run);
  });
  it.each(['readiness-timeout', 'hanging-timeout'])('bounds %s, stops the API and never starts Next', async scenario => {
    const run = await start(scenario);
    expect((await run.exited).code).toBe(1);
    expect(run.output()).toContain('API readiness timed out');
    expect((await events(run)).some(row => row.name === 'web')).toBe(false);
    await expectStopped(run);
  });
  it.each(['api', 'web'])('shuts down both when %s crashes after startup', async name => {
    const run = await start();
    await waitFor(run, 'web', 'listening');
    const target = await waitFor(run, name);
    process.kill(target.pid, 'SIGUSR2');
    expect((await run.exited).code).toBe(1);
    expect(run.output()).toContain(`${name} exited unexpectedly (23)`);
    const other = name === 'api' ? 'web' : 'api';
    expect((await events(run)).some(row => row.name === other && row.event === 'clean-exit')).toBe(true);
    await expectStopped(run);
  });
  it.each(['api', 'web'])('treats an unrequested successful %s exit as a service failure', async name => {
    const run = await start();
    await waitFor(run, 'web', 'listening');
    process.kill((await waitFor(run, name)).pid, 'SIGTERM');
    expect((await run.exited).code).toBe(1);
    expect(run.output()).toContain(`${name} exited unexpectedly (0)`);
    await expectStopped(run);
  });
  it('force-kills a child that ignores graceful shutdown', async () => {
    const run = await start('stubborn');
    await waitFor(run, 'web', 'listening');
    run.child.kill('SIGTERM');
    expect((await run.exited).code).toBe(0);
    expect((await events(run)).some(row => row.name === 'web' && row.event === 'SIGTERM')).toBe(true);
    expect((await events(run)).some(row => row.name === 'web' && row.event === 'clean-exit')).toBe(false);
    await expectStopped(run);
  });
  it('keeps supervising cleanup when shutdown signals are repeated', async () => {
    const run = await start('stubborn');
    await waitFor(run, 'web', 'listening');
    run.child.kill('SIGTERM');
    await waitFor(run, 'web', 'SIGTERM');
    run.child.kill('SIGTERM');
    run.child.kill('SIGINT');
    expect((await run.exited).code).toBe(0);
    await expectStopped(run);
  });
  it('does not orphan descendants when their direct parent exits first', async () => {
    const run = await start('descendant');
    await waitFor(run, 'descendant', 'listening');
    run.child.kill('SIGTERM');
    expect((await run.exited).code).toBe(0);
    await expectStopped(run);
  });
  it('rejects missing opt-in before any initialization executable starts', async () => {
    const run = await start('', { HOSTED_DEMO: undefined });
    expect((await run.exited).code).toBe(1);
    expect(run.output()).toContain('explicit HOSTED_DEMO=true');
    expect(await events(run)).toEqual([]);
  });
});

describe('S3 startup preflight', () => {
  const originalArgv = process.argv;
  const sdk = createRequire(new URL('../apps/api/package.json', import.meta.url)).resolve('@aws-sdk/client-s3');
  function mockStorage(driver = 's3') {
    vi.resetModules();
    process.argv = [...originalArgv, '--check'];
    const send = vi.fn(async (_command: unknown) => ({}));
    const destroy = vi.fn();
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.doMock(sdk, () => ({
      S3Client: class { send = send; destroy = destroy; },
      HeadBucketCommand: class HeadBucketCommand { constructor(readonly input: unknown) {} },
      CreateBucketCommand: class CreateBucketCommand { constructor(readonly input: unknown) {} },
    }));
    vi.doMock('../apps/api/src/config.js', () => ({ loadConfig: () => ({ ...base, STORAGE_DRIVER: driver, S3_ENDPOINT: 'http://127.0.0.1:1' }) }));
    return { send, destroy, log };
  }
  afterEach(() => {
    process.argv = originalArgv;
    vi.doUnmock(sdk);
    vi.doUnmock('../apps/api/src/config.js');
    vi.resetModules();
    vi.restoreAllMocks();
  });
  it('only HEADs an existing bucket and does not claim to prove privacy', async () => {
    const { send, destroy, log } = mockStorage();
    await import('../apps/api/src/init-storage.js');
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0]?.constructor.name).toBe('HeadBucketCommand');
    expect(destroy).toHaveBeenCalledOnce();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('privacy is not verified'));
  });
  it.each(['NotFound', 'NoSuchBucket'])('refuses %s without creating or retrying the bucket', async name => {
    const { send, destroy } = mockStorage();
    send.mockRejectedValueOnce(Object.assign(new Error('missing'), { name }));
    await expect(import('../apps/api/src/init-storage.js')).rejects.toThrow('--check never creates');
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0]?.constructor.name).toBe('HeadBucketCommand');
    expect(destroy).toHaveBeenCalledOnce();
  });
  it('fails closed on denied access and still destroys the S3 client', async () => {
    const { send, destroy } = mockStorage();
    send.mockRejectedValueOnce(new Error('Forbidden'));
    await expect(import('../apps/api/src/init-storage.js')).rejects.toThrow('Forbidden');
    expect(send).toHaveBeenCalledTimes(1);
    expect(destroy).toHaveBeenCalledOnce();
  });
  it('rejects local storage instead of reporting a successful S3 preflight', async () => {
    const { send } = mockStorage('local');
    await expect(import('../apps/api/src/init-storage.js')).rejects.toThrow('requires S3');
    expect(send).not.toHaveBeenCalled();
  });
});

describe('Render deployment contract', () => {
  it('declares just one free Docker web service and no paid/predeploy resources', async () => {
    const yaml = await readFile(join(root, 'render.yaml'), 'utf8');
    expect(yaml.match(/- type:/g)).toHaveLength(1);
    for (const value of ['type: web', 'runtime: docker', 'plan: free', 'dockerfilePath: ./Dockerfile.render', 'healthCheckPath: /api/v1/readyz']) expect(yaml).toContain(value);
    expect(yaml).not.toMatch(/preDeployCommand|databases:|disk:|redis|keyvalue|type: worker/i);
    expect(yaml).toMatch(/key: NO_AUTH\s+value: "true"/);
    for (const key of ['JWT_SECRET', 'QR_SECRET']) expect(yaml).toMatch(new RegExp(`key: ${key}\\s+generateValue: true`));
    for (const key of ['DATABASE_URL', 'S3_ENDPOINT', 'S3_PUBLIC_ENDPOINT', 'S3_REGION', 'S3_BUCKET', 'S3_ACCESS_KEY', 'S3_SECRET_KEY']) expect(yaml).toMatch(new RegExp(`key: ${key}\\s+sync: false`));
  });
  it('builds production Next with hosted UI only, and launches Node without a wrapper', async () => {
    const docker = await readFile(join(root, 'Dockerfile.render'), 'utf8');
    for (const value of ['NODE_ENV=production', 'HOSTED_DEMO=false', 'DEMO_MODE=false', 'API_INTERNAL_URL=http://127.0.0.1:4000', 'NEXT_PUBLIC_API_URL=/api/v1', 'NEXT_PUBLIC_HOSTED_DEMO=true', 'NEXT_PUBLIC_DEMO_MODE=false']) {
      expect(docker).toContain(value);
      expect(docker.indexOf(value)).toBeLessThan(docker.indexOf('RUN pnpm --filter @swachh/web build'));
    }
    expect(docker).toContain('pnpm install --frozen-lockfile --prod=false');
    expect(docker).toContain('CMD ["node", "scripts/start-hosted-demo.mjs"]');
    const launcher = await readFile(join(root, 'scripts/start-hosted-demo.mjs'), 'utf8');
    expect(launcher).toContain("'apps/api/src/init-storage.ts', '--check'");
    expect(launcher).toContain("'node_modules/prisma/build/index.js', 'migrate', 'deploy'");
    expect(launcher).toContain("'--import', 'tsx', 'prisma/seed.ts'");
    expect(launcher).toContain("'--import', 'tsx', 'apps/api/src/server.ts'");
    expect(launcher).toContain("'apps/web/node_modules/next/dist/bin/next', 'start', 'apps/web', '--hostname', '0.0.0.0', '--port', web.PORT");
    expect(launcher).not.toMatch(/db:reset|migrate.*reset|worker\.ts|setInterval\(/);
    const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
    expect(pkg.scripts['start:hosted-demo']).toBe('node scripts/start-hosted-demo.mjs');
  });
  it('excludes nested environment secrets and user memory from the Docker context', async () => {
    const dockerignore = (await readFile(join(root, '.dockerignore'), 'utf8')).split('\n');
    for (const pattern of ['**/.env*', '!**/.env.example', '**/.bcode', '**/MEMORY.md', '**/AGENTS.md', 'uploads', 'outputs']) expect(dockerignore).toContain(pattern);
    const gitignore = (await readFile(join(root, '.gitignore'), 'utf8')).split('\n');
    expect(gitignore).toContain('**/.env*');
    expect(gitignore).toContain('!**/.env.example');
  });
});

import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config.js';

const base = { DATABASE_URL: 'postgresql://localhost/test', JWT_SECRET: 'test-only-secret-with-more-than-32-bytes', QR_SECRET: 'test-only-qr-secret-with-more-than-32-bytes' };
describe('deployment security configuration', () => {
  afterEach(() => vi.unstubAllEnvs());
  it('rejects demo mode and local evidence storage in production', () => {
    expect(() => loadConfig({ ...base, NODE_ENV: 'production', DEMO_MODE: 'true' })).toThrow('DEMO_MODE');
    expect(() => loadConfig({ ...base, NODE_ENV: 'production', DEMO_MODE: 'false', STORAGE_DRIVER: 'local' })).toThrow('Local storage');
  });
  it('requires strong explicit signing secrets and defaults optional flags off', () => {
    expect(() => loadConfig({ ...base, JWT_SECRET: 'short' })).toThrow();
    expect(loadConfig({ ...base, NODE_ENV: 'development', DEMO_MODE: 'false', STORAGE_DRIVER: 's3' }).DEMO_MODE).toBe('false');
  });
  it('defaults hosted demo off and enables it only with explicit development demo mode', () => {
    expect(loadConfig({ ...base, HOSTED_DEMO: undefined }).HOSTED_DEMO).toBe('false');
    expect(loadConfig({ ...base, NODE_ENV: 'development', DEMO_MODE: 'true', HOSTED_DEMO: 'true' }).HOSTED_DEMO).toBe('true');
  });
  it.each([
    ['development', 'false'], ['test', 'false'], ['test', 'true'], ['production', 'false'], ['production', 'true'],
  ] as const)('fails closed for HOSTED_DEMO with NODE_ENV=%s and DEMO_MODE=%s', (NODE_ENV, DEMO_MODE) => {
    expect(() => loadConfig({ ...base, NODE_ENV, DEMO_MODE, HOSTED_DEMO: 'true' })).toThrow(/HOSTED_DEMO|DEMO_MODE/);
  });
  it.each(['', 'TRUE', '1', 'yes'])('rejects non-enum HOSTED_DEMO=%j', value => {
    vi.stubEnv('HOSTED_DEMO', value);
    expect(() => loadConfig({ ...base, NODE_ENV: 'development', DEMO_MODE: 'true' })).toThrow();
  });
  it('does not infer DEMO_MODE from HOSTED_DEMO', () => {
    expect(() => loadConfig({ ...base, NODE_ENV: 'development', DEMO_MODE: undefined, HOSTED_DEMO: 'true' })).toThrow('HOSTED_DEMO');
  });
  it('keeps the default bind address and port, and accepts loopback binding', () => {
    const defaults = loadConfig({ ...base, HOST: undefined, PORT: undefined });
    expect(defaults.HOST).toBe('0.0.0.0');
    expect(defaults.PORT).toBe(4000);
    expect(loadConfig({ ...base, HOST: '127.0.0.1', PORT: 65535 }).HOST).toBe('127.0.0.1');
    expect(loadConfig({ ...base, HOST: '::1', PORT: 1 }).PORT).toBe(1);
    expect(loadConfig({ ...base, HOST: 'localhost' }).HOST).toBe('localhost');
  });
  it.each(['', ' ', 'http://127.0.0.1', '127.0.0.1:4000', '999.999.999.999', '-bad-host', 'bad host', 'host/path'])('rejects invalid HOST=%j', HOST => {
    expect(() => loadConfig({ ...base, HOST })).toThrow('HOST');
  });
  it.each([0, -1, 1.5, 65536, Number.NaN])('rejects invalid PORT=%j', PORT => {
    expect(() => loadConfig({ ...base, PORT })).toThrow();
  });
});

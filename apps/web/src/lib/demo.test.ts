import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); });

describe('demo presentation flags', () => {
  it.each([
    ['production', undefined, undefined, false, false],
    ['production', 'true', undefined, false, false],
    ['production', 'true', 'false', false, false],
    ['production', undefined, 'true', true, true],
    ['production', 'false', 'true', true, true],
    ['production', 'true', 'true', true, true],
    ['development', undefined, undefined, false, false],
    ['development', 'true', undefined, true, false],
    ['development', 'true', 'false', true, false],
    ['development', 'false', 'true', true, true],
    ['test', 'true', undefined, true, false],
  ] as const)('NODE_ENV=%s, DEMO_MODE=%s, HOSTED_DEMO=%s', async (nodeEnv, demo, hosted, enabled, hostedEnabled) => {
    vi.stubEnv('NODE_ENV', nodeEnv);
    vi.stubEnv('NEXT_PUBLIC_DEMO_MODE', demo);
    vi.stubEnv('NEXT_PUBLIC_HOSTED_DEMO', hosted);
    vi.resetModules();
    const flags = await import('./demo');
    expect(flags.DEMO_ENABLED).toBe(enabled);
    expect(flags.HOSTED_DEMO_ENABLED).toBe(hostedEnabled);
  });

  it.each(['', 'TRUE', '1', 'yes'])('requires literal true, not %j', async value => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('NEXT_PUBLIC_DEMO_MODE', value);
    vi.stubEnv('NEXT_PUBLIC_HOSTED_DEMO', value);
    vi.resetModules();
    const flags = await import('./demo');
    expect(flags.DEMO_ENABLED).toBe(false);
    expect(flags.HOSTED_DEMO_ENABLED).toBe(false);
  });
});

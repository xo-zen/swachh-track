import { defineConfig } from 'vitest/config';

export default defineConfig({
  root: import.meta.dirname,
  test: { include: ['src/lib/*.test.ts'], fileParallelism: false, maxWorkers: 1 },
});

import { z } from 'zod';
import { config as readEnv } from 'dotenv';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { isIP } from 'node:net';

const projectRoot = fileURLToPath(new URL('../../../', import.meta.url));
readEnv({ path: resolve(projectRoot, '.env') });

const environment = z.object({
  DATABASE_URL: z.string().min(1),
  JWT_SECRET: z.string().min(32),
  QR_SECRET: z.string().min(32),
  QR_SECRET_VERSION: z.string().default('1'),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  DEMO_MODE: z.enum(['true', 'false']).default('false'),
  HOSTED_DEMO: z.enum(['true', 'false']).default('false'),
  STORAGE_DRIVER: z.enum(['s3', 'local']).default('s3'),
  LOCAL_STORAGE_PATH: z.string().default('apps/api/.storage'),
  API_PUBLIC_URL: z.string().url().default('http://localhost:4000'),
  S3_ENDPOINT: z.string().url().optional(),
  S3_PUBLIC_ENDPOINT: z.string().url().optional(),
  S3_REGION: z.string().default('ap-south-1'),
  S3_ACCESS_KEY: z.string().optional(),
  S3_SECRET_KEY: z.string().optional(),
  S3_BUCKET: z.string().default('swachh-track'),
  REDIS_URL: z.string().default('redis://localhost:6379'),
  CORS_ORIGINS: z.string().default('http://localhost:3000'),
  HOST: z.string().min(1).max(253).refine(value => isIP(value) !== 0 || (!/^[\d.]+$/.test(value) && /^(?:[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?)(?:\.[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?)*$/i.test(value)), 'HOST must be an IP address or hostname').default('0.0.0.0'),
  PORT: z.coerce.number().int().positive().max(65535).default(4000),
  SWACHHATA_WEBHOOK_SECRET: z.string().optional(),
  WHATSAPP_WEBHOOK_SECRET: z.string().optional(),
});

export type Config = z.infer<typeof environment>;
export function loadConfig(overrides: Partial<Config> = {}): Config {
  const config = environment.parse({ ...process.env, ...overrides });
  if (config.STORAGE_DRIVER === 'local') config.LOCAL_STORAGE_PATH = resolve(projectRoot, config.LOCAL_STORAGE_PATH);
  if (config.NODE_ENV === 'production' && config.DEMO_MODE === 'true') {
    throw new Error('DEMO_MODE is forbidden in production');
  }
  if (config.HOSTED_DEMO === 'true' && (config.NODE_ENV !== 'development' || config.DEMO_MODE !== 'true')) {
    throw new Error('HOSTED_DEMO requires NODE_ENV=development and DEMO_MODE=true');
  }
  if (config.NODE_ENV === 'production' && config.STORAGE_DRIVER === 'local') {
    throw new Error('Local storage is development/test only');
  }
  return config;
}

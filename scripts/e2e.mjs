import { chromium } from '@playwright/test';
import { runWebAcceptance } from '../tests/web.e2e.mjs';

const remote = process.env.E2E_CDP_URL;
if (process.env.BU_CDP_WS && !remote) throw new Error('Set E2E_CDP_URL to the provisioned browser. Do not launch a local browser in the hosted worker.');
const browser = remote ? await chromium.connectOverCDP(remote) : await chromium.launch({ headless: true });
const existing = process.env.E2E_REUSE_PAGE === 'true';
const context = existing ? browser.contexts()[0] : await browser.newContext();
const page = existing ? context.pages().find(page => page.url().includes('swachh-track.test')) ?? context.pages()[0] : await context.newPage();
try {
  await runWebAcceptance(page, process.env.E2E_BASE_URL ?? 'http://localhost:3000');
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  if (!existing) await context.close();
  if (!remote) await browser.close();
}
process.exit(process.exitCode ?? 0);

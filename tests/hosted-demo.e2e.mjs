import { expect } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';

// Run only against disposable compact fixtures; this creates a synthetic upload.
export async function runHostedDemoAcceptance(page, baseURL) {
  await mkdir('outputs', { recursive: true });
  const results = [];
  const failures = [];
  let artifactFailed = false;
  page.setDefaultTimeout(30000);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const onError = error => failures.push(error.message);
  page.on('pageerror', onError);
  async function check(name, action) {
    const start = Date.now();
    try { await action(); results.push({ name, status: 'PASS', durationMs: Date.now() - start }); }
    catch (error) { results.push({ name, status: 'FAIL', error: error.message }); throw error; }
    console.log(`PASS ${name}`);
  }
  try {
    await page.goto(baseURL, { waitUntil: 'domcontentloaded' });
    await page.setViewportSize({ width: 1280, height: 900 });
    await check('Production-built login shows fictional-data and disabled-automation notices', async () => {
      await expect(page.getByRole('heading', { name: 'Explore the hosted demo' })).toBeVisible();
      await expect(page.locator('[name="phone"]')).toHaveCount(0);
      await expect(page.locator('.demo-logins button')).toHaveCount(5);
      await expect(page.getByText('Shared fictional data. Do not enter personal data.', { exact: true })).toBeVisible();
      await expect(page.getByText('Reminders, notification delivery and background escalation are disabled.', { exact: false })).toBeVisible();
      await page.screenshot({ path: 'outputs/hosted-demo-login.png' });
    });
    await check('Login layouts fit 360, 390, 768 and 1280px; Hindi notice is present', async () => {
      for (const width of [360, 390, 768, 1280]) {
        await page.setViewportSize({ width, height: 900 });
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
      }
      await page.getByLabel('Language', { exact: true }).selectOption('hi');
      await expect(page.locator('html')).toHaveAttribute('lang', 'hi');
      await expect(page.locator('.hosted-demo-notice strong')).toHaveText('होस्टेड डेमो');
      await page.getByLabel('भाषा', { exact: true }).selectOption('en');
    });
    for (const role of ['Society administrator', 'Resident', 'Supervisor', 'ULB administrator', 'Collector']) {
      let identity;
      await check(`${role}: guarded shortcut login and authenticated demo notice`, async () => {
        const response = page.waitForResponse(response => response.url().endsWith('/auth/otp/verify'));
        await page.getByRole('button', { name: role, exact: true }).click();
        const verified = await response;
        expect(verified.status()).toBe(200);
        identity = await verified.json();
        expect(identity.memberships).toHaveLength(1);
        await expect(page.locator('nav')).toBeVisible();
        await expect(page.locator('.hosted-demo-notice')).toBeVisible();
        await expect(page.getByRole('button', { name: 'Sign out', exact: true })).toBeVisible();
      });
      if (role === 'Society administrator') {
        await check('Compact society dashboard is live and responsive', async () => {
          await expect(page.getByText('Collection coverage', { exact: true }).first()).toBeVisible();
          await page.screenshot({ path: 'outputs/hosted-demo-desktop.png' });
          for (const width of [360, 390, 768, 1280]) {
            await page.setViewportSize({ width, height: 900 });
            await expect.poll(() => page.locator('.main-shell').evaluate(element => element.getBoundingClientRect().left)).toBeGreaterThanOrEqual(0);
            expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
            if (width <= 768) await expect.poll(() => page.locator('.sidebar').evaluate(element => element.getBoundingClientRect().right)).toBeLessThanOrEqual(1);
            if (width === 390) await page.screenshot({ path: 'outputs/hosted-demo-mobile.png' });
          }
        });
        await check('Profile and resident identity controls are hidden; backend rejects mutations', async () => {
          await page.locator('nav').getByRole('button', { name: 'Settings', exact: true }).click();
          await expect(page.getByText('Seeded identities are read-only.', { exact: false })).toBeVisible();
          await expect(page.getByRole('button', { name: 'Edit', exact: true })).toHaveCount(0);
          await page.locator('nav').getByRole('button', { name: 'Residents', exact: true }).click();
          await expect(page.getByRole('button', { name: 'Invite resident', exact: true })).toHaveCount(0);
          await expect(page.getByRole('button', { name: 'Deactivate', exact: true })).toHaveCount(0);
          const status = await page.evaluate(async identity => (await fetch('/api/v1/me', {
            method: 'PATCH', headers: { authorization: `Bearer ${identity.accessToken}`, 'X-Membership-Id': identity.memberships[0].id, 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: 'Synthetic mutation must be refused' }),
          })).status, identity);
          expect(status).toBe(403);
        });
        await check('Real local private-byte upload, confirmation and signed image read', async () => {
          const result = await page.evaluate(async identity => {
            const bytes = Uint8Array.from(window.atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aip8AAAAASUVORK5CYII='), char => char.charCodeAt(0));
            const headers = { authorization: `Bearer ${identity.accessToken}`, 'X-Membership-Id': identity.memberships[0].id, 'Content-Type': 'application/json' };
            const reserved = await fetch('/api/v1/files/presign', { method: 'POST', headers, body: JSON.stringify({ filename: 'synthetic-preview.png', contentType: 'image/png', size: bytes.length, purpose: 'COMPLAINT' }) });
            if (!reserved.ok) throw new Error(`Presign failed: ${reserved.status}`);
            const file = await reserved.json();
            const put = await fetch(file.uploadUrl, { method: 'PUT', headers: { 'Content-Type': 'image/png' }, body: bytes });
            const confirmed = await fetch(`/api/v1/files/${file.fileId}/confirm`, { method: 'POST', headers, body: '{}' });
            const confirmation = await confirmed.json();
            const info = await fetch(`/api/v1/photos/${file.fileId}`, { headers });
            const photo = await info.json();
            const download = await fetch(photo.url);
            const image = new Uint8Array(await download.arrayBuffer());
            return { uploaded: put.ok, confirmed: confirmed.status, status: confirmation.status, hash: confirmation.sha256, info: info.status, download: download.status, jpeg: image[0] === 255 && image[1] === 216, size: image.length };
          }, identity);
          expect(result.uploaded).toBe(true);
          expect(result.confirmed).toBe(200);
          expect(result.status).toBe('CONFIRMED');
          expect(result.hash).toMatch(/^[0-9a-f]{64}$/);
          expect(result.info).toBe(200);
          expect(result.download).toBe(200);
          expect(result.jpeg).toBe(true);
          expect(result.size).toBeGreaterThan(0);
        });
      }
      await page.getByRole('button', { name: 'Sign out', exact: true }).click();
      await expect(page.getByRole('heading', { name: 'Explore the hosted demo' })).toBeVisible();
    }
    await check('Unseeded identity is rejected and there are no browser runtime errors', async () => {
      const status = await page.evaluate(async () => (await fetch('/api/v1/auth/otp/request', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phone: '+919999999999' }) })).status);
      expect(status).toBe(403);
      expect(failures).toEqual([]);
    });
  } finally {
    page.off('pageerror', onError);
    const report = { generatedAt: new Date().toISOString(), environment: 'Production-built Next, development-only HOSTED_DEMO API, disposable local PostgreSQL and local private storage; provisioned cloud Chromium through private bridge.', publiclyDeployed: false, s3Tested: false, nativeAndroidTested: false, results };
    const text = JSON.stringify(report, null, 2) + '\n';
    if (existsSync('/app/v4-stack')) {
      const written = spawnSync('/app/v4-stack', ['artifact-write', 'outputs/hosted-demo-e2e.json'], { input: text, encoding: 'utf8' });
      artifactFailed = written.status !== 0;
    } else await writeFile('outputs/hosted-demo-e2e.json', text).catch(() => { artifactFailed = true; });
  }
  if (artifactFailed) throw new Error('Could not write hosted demo browser evidence.');
}

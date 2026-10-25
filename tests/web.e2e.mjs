import { expect } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

export async function runWebAcceptance(page, baseURL) {
  const results = [];
  const identities = new Map();
  const suffix = Date.now().toString(36);
  let complaintId;
  page.setDefaultTimeout(30000);
  page.on('response', async response => {
    if (response.url().endsWith('/auth/otp/verify') && response.status() === 200) {
      const identity = await response.json();
      identities.set(identity.memberships[0].role, identity);
    }
  });
  await mkdir('outputs', { recursive: true });
  async function scenario(name, action) {
    const started = Date.now();
    try { await action(); results.push({ name, status: 'PASS', durationMs: Date.now() - started }); console.log(`PASS ${name}`); }
    catch (error) { results.push({ name, status: 'FAIL', error: error.message, url: page.url(), stack: error.stack }); throw error; }
  }
  async function navigate(name) {
    await page.locator('nav').getByRole('button', { name, exact: true }).click();
    await expect(page.locator('#main-content h2').first()).toBeVisible();
  }
  async function login(name) {
    await page.waitForFunction(() => [...document.querySelectorAll('button')].some(button => Object.keys(button).some(key => key.startsWith('__reactProps'))));
    if (await page.getByRole('button', { name: 'Sign out', exact: true }).count()) await page.getByRole('button', { name: 'Sign out', exact: true }).click();
    const phones = { Resident: '+919000000001', 'Society administrator': '+919000000002', Collector: '+919000000003', Supervisor: '+919000000004', 'ULB administrator': '+919000000005' };
    await page.locator('[name="phone"]').fill(phones[name]);
    const requested = page.waitForResponse(response => response.url().endsWith('/auth/otp/request'));
    await page.locator('form button[type="submit"]').click();
    const response = await requested;
    expect(response.status(), await response.text()).toBe(202);
    await page.locator('[name="code"]').fill('123456');
    await page.locator('form button[type="submit"]').click();
    await expect(page.locator('nav')).toBeVisible({ timeout: 30000 });
  }
  async function downloaded(button, path, prefix = '%PDF-') {
    await page.evaluate(() => {
      window.__swachhDownload = null;
      window.__swachhCreateObjectURL ??= URL.createObjectURL.bind(URL);
      URL.createObjectURL = blob => { window.__swachhDownload = blob; return window.__swachhCreateObjectURL(blob); };
    });
    const waiting = page.waitForResponse(response => response.url().includes(path) && response.request().method() === 'GET', { timeout: 120000 });
    await button.click();
    const response = await waiting;
    expect(response.status(), `${new URL(response.url()).pathname}: ${response.status() === 200 ? 'download' : await response.text()}`).toBe(200);
    await page.waitForFunction(() => window.__swachhDownload instanceof Blob);
    const bytes = Buffer.from(await page.evaluate(async () => [...new Uint8Array(await window.__swachhDownload.arrayBuffer())]));
    expect(bytes.subarray(0, prefix.length).toString()).toBe(prefix);
    return bytes;
  }
  async function api(role, path, body, method = 'POST') {
    const identity = identities.get(role);
    if (!identity) throw new Error(`No authenticated test identity for ${role}`);
    return page.evaluate(async ({ identity, path, body, method }) => {
      const response = await fetch(`/api/v1${path}`, { method, headers: { authorization: `Bearer ${identity.accessToken}`, 'X-Membership-Id': identity.memberships[0].id, ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
      return { status: response.status, body: await response.json() };
    }, { identity, path, body, method });
  }
  try {
    await page.goto(baseURL, { waitUntil: 'domcontentloaded' });
    await page.setViewportSize({ width: 1280, height: 900 });
    await scenario('Society OTP login and server-calculated dashboard', async () => {
      await login('Society administrator');
      await expect(page.getByText('Collection coverage', { exact: true }).first()).toBeVisible();
      await expect(page.getByText('Verified waste', { exact: true })).toBeVisible();
      await page.screenshot({ path: 'outputs/swachh-track-desktop.png', fullPage: false });
    });
    await scenario('360/390/768/1280 layouts and Hindi controls', async () => {
      for (const width of [360, 390, 768, 1280]) {
        await page.setViewportSize({ width, height: 900 });
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
        if (width === 390) await page.screenshot({ path: 'outputs/swachh-track-mobile.png' });
      }
      await page.getByLabel('Language', { exact: true }).selectOption('hi');
      await expect(page.locator('html')).toHaveAttribute('lang', 'hi');
      await page.getByLabel('भाषा', { exact: true }).selectOption('en');
    });
    await scenario('Import twenty persisted properties and download QR PDF', async () => {
      await navigate('Properties');
      await page.getByRole('button', { name: 'Import property CSV', exact: true }).click();
      const csv = 'unitNo,block,floor,latitude,longitude,status\n' + Array.from({ length: 20 }, (_, i) => `E2E-${suffix}-${i},QA,1,18.5204,73.8567,ACTIVE`).join('\n');
      await page.locator('textarea[name="csv"]').fill(csv);
      const saved = page.waitForResponse(r => r.url().includes('/properties/import'));
      await page.getByRole('button', { name: 'Save record', exact: true }).click();
      expect((await saved).status()).toBe(201);
      await expect(page.getByRole('dialog')).toHaveCount(0);
      await page.getByRole('textbox', { name: 'Search records', exact: true }).fill(`E2E-${suffix}-`);
      await page.getByRole('button', { name: 'Search records', exact: true }).click();
      await expect(page.locator('tbody tr')).toHaveCount(20);
      const pdf = await downloaded(page.getByRole('button', { name: 'QR sticker sheet', exact: true }), 'qr-sheet.pdf');
      await writeFile('outputs/example-qr-stickers.pdf', pdf);
    });
    await scenario('Invoice generation, audited deductions and PDF download', async () => {
      await navigate('Invoices');
      await page.getByRole('button', { name: 'Generate monthly draft', exact: true }).click();
      const now = new Date(); const year = now.getUTCFullYear(); const month = now.getUTCMonth();
      const start = new Date(Date.UTC(year, month, 1)).toISOString().slice(0, 10);
      const end = new Date(Date.UTC(year, month + 1, 0)).toISOString().slice(0, 10);
      await page.locator('[name="periodStart"]').fill(start); await page.locator('[name="periodEnd"]').fill(end);
      await page.locator('[name="dueDate"]').fill(end);
      const waiting = page.waitForResponse(r => r.url().endsWith('/invoices/generate'));
      await page.getByRole('button', { name: 'Save record', exact: true }).click();
      const response = await waiting; const data = await response.json();
      if (response.status() === 409 && data.error?.code === 'INVOICE_EXISTS') await page.getByRole('button', { name: 'Cancel', exact: true }).click();
      else expect(response.status(), JSON.stringify(data)).toBe(201);
      const invoice = response.status() === 201 ? data : data.error.details.original;
      expect(Number.isInteger(invoice.totalPaise)).toBe(true);
      expect(invoice.deductionsPaise).toBeGreaterThan(0);
      const pdf = await downloaded(page.getByRole('button', { name: 'Invoice PDF', exact: true }).first(), '/invoices/');
      await writeFile('outputs/example-invoice.pdf', pdf);
    });
    await scenario('Annual draft generation and complete inspection PDF', async () => {
      await navigate('Compliance');
      await expect(page.getByText('Evidence workspace, not a compliance certification.', { exact: false }).first()).toBeVisible();
      await page.getByRole('button', { name: 'Annual return draft', exact: true }).click();
      await page.getByRole('button', { name: 'Generate annual return', exact: true }).click();
      const today = new Date();
      await page.locator('[name="financialYearStart"]').fill(String(today.getUTCFullYear() - (today.getUTCMonth() < 3 ? 1 : 0)));
      const waiting = page.waitForResponse(r => r.url().endsWith('/annual-return') && r.request().method() === 'POST');
      await page.getByRole('button', { name: 'Save record', exact: true }).click();
      const response = await waiting; const data = await response.json();
      if (response.status() === 409 && data.error?.code === 'ANNUAL_RETURN_EXISTS') await page.getByRole('button', { name: 'Cancel', exact: true }).click();
      else expect(response.status(), JSON.stringify(data)).toBe(201);
      await expect(page.getByRole('dialog')).toHaveCount(0);
      const annual = await downloaded(page.getByRole('button', { name: 'Annual return PDF', exact: true }).first(), '/annual-return/');
      await writeFile('outputs/example-annual-return-draft.pdf', annual);
      const inspection = await downloaded(page.getByRole('button', { name: 'Inspection pack PDF', exact: true }), 'inspection-pack.pdf');
      await writeFile('outputs/example-inspection-pack.pdf', inspection);
    });
    await scenario('Resident evidence, private photo and verified-only rating', async () => {
      await login('Resident'); await navigate('Pickup evidence');
      await page.getByRole('combobox', { name: 'Status', exact: true }).selectOption('VERIFIED');
      await page.getByRole('button', { name: 'Evidence record', exact: true }).first().click();
      await expect(page.getByRole('dialog').getByText('Stream weights', { exact: true })).toBeVisible();
      await expect(page.getByRole('dialog').locator('img').first()).toBeVisible();
      expect(await page.getByRole('dialog').locator('img').first().evaluate(image => image.complete && image.naturalWidth > 0)).toBe(true);
      const rate = page.getByRole('button', { name: 'Rate pickup', exact: true });
      if (await rate.count()) {
        await rate.click();
        for (const name of ['punctuality', 'quality', 'guidance']) await page.locator(`[name="${name}"]`).fill('4');
        const saved = page.waitForResponse(r => r.url().endsWith('/ratings') && r.request().method() === 'POST');
        await page.getByRole('button', { name: 'Save record', exact: true }).click();
        expect((await saved).status()).toBe(201);
      }
      await page.getByRole('button', { name: 'Close', exact: true }).last().click();
    });
    await scenario('Complaint image upload, creation and accountable resolution/reopen', async () => {
      await navigate('Complaints & SLA');
      await page.getByRole('button', { name: 'Raise complaint', exact: true }).click();
      await expect(page.locator('[name="propertyId"] option')).toHaveCount(2);
      await page.locator('[name="propertyId"]').selectOption({ index: 1 });
      await page.locator('[name="categoryId"]').selectOption({ index: 1 });
      await page.getByRole('dialog').getByRole('textbox', { name: 'Description', exact: true }).fill(`E2E civic collection complaint ${suffix}`);
      const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aip8AAAAASUVORK5CYII=', 'base64');
      await page.locator('[name="photoId"]').setInputFiles({ name: 'e2e-evidence.png', mimeType: 'image/png', buffer: png });
      const waiting = page.waitForResponse(r => r.url().endsWith('/resident/complaints') && r.request().method() === 'POST');
      await page.getByRole('button', { name: 'Save record', exact: true }).click();
      const created = await waiting; expect(created.status(), await created.text()).toBe(201); complaintId = (await created.json()).id;
      await expect(page.getByRole('dialog')).toHaveCount(0);
      for (const status of ['ACKNOWLEDGED', 'IN_PROGRESS']) expect((await api('SOCIETY_ADMIN', `/complaints/${complaintId}`, { status, note: 'E2E resolver audit trail' }, 'PATCH')).status).toBe(200);
      const reserved = await api('SOCIETY_ADMIN', '/files/presign', { filename: 'resolution.png', contentType: 'image/png', size: png.length, purpose: 'RESOLUTION' });
      expect(reserved.status).toBe(200);
      const put = await page.evaluate(async ({ url, bytes }) => (await fetch(url, { method: 'PUT', headers: { 'Content-Type': 'image/png' }, body: Uint8Array.from(bytes) })).status, { url: reserved.body.uploadUrl, bytes: [...png] });
      expect(put).toBeGreaterThanOrEqual(200); expect(put).toBeLessThan(300);
      expect((await api('SOCIETY_ADMIN', `/files/${reserved.body.fileId}/confirm`, {})).status).toBe(200);
      expect((await api('SOCIETY_ADMIN', `/complaints/${complaintId}`, { status: 'RESOLVED', note: 'Collected and evidence attached', photoId: reserved.body.fileId }, 'PATCH')).status).toBe(200);
      expect((await api('RESIDENT', `/resident/complaints/${complaintId}/reopen`, { note: 'Resident requests a follow-up inspection' })).status).toBe(200);
      await page.getByRole('button', { name: 'Refresh', exact: true }).click();
      await page.getByRole('combobox', { name: 'Status', exact: true }).selectOption('REOPENED');
      await expect(page.getByText(`E2E civic collection complaint ${suffix}`, { exact: true })).toBeVisible();
    });
    await scenario('Supervisor review queue and evidence controls', async () => {
      await login('Supervisor'); await navigate('Supervisor review');
      await page.getByRole('button', { name: 'Evidence record', exact: true }).first().click();
      await expect(page.getByRole('button', { name: 'Approve', exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Reject', exact: true })).toBeVisible();
      await page.getByRole('button', { name: 'Close', exact: true }).click();
    });
    await scenario('ULB ward map, contractor filter, SLA breaches and CSV export', async () => {
      await login('ULB administrator'); await navigate('Ward & society map');
      await expect(page.locator('.maplibregl-canvas')).toBeVisible();
      await navigate('Contractor scorecards');
      const filtered = page.waitForResponse(response => response.url().includes('/dashboard?contractorId='), { timeout: 60000 });
      await page.getByRole('combobox', { name: 'Contractor scorecards', exact: true }).selectOption({ index: 1 });
      const response = await filtered; expect(response.status(), await response.text()).toBe(200);
      await expect(page.locator('tbody tr')).toHaveCount(1);
      await navigate('Complaints & SLA'); await page.getByLabel('SLA breaches only', { exact: true }).check();
      await expect(page.getByText('SLA breached', { exact: false }).first()).toBeVisible();
      await navigate('Reports & exports'); await page.getByRole('combobox', { name: 'Report type', exact: true }).selectOption('complaints');
      const csv = await downloaded(page.getByRole('button', { name: 'Export CSV', exact: true }), '.csv', '"id"');
      await writeFile('outputs/example-complaints.csv', csv);
    });
    await scenario('Collector web role is an honest Android handoff', async () => {
      await login('Collector');
      await expect(page.getByText('Capture happens in the collector app', { exact: true })).toBeVisible();
    });
  } finally {
    const report = JSON.stringify({ generatedAt: new Date().toISOString(), browser: 'Chromium / Playwright', nativeAndroidTested: false, results }, null, 2);
    if (existsSync('/app/v4-stack')) {
      const saved = spawnSync('/app/v4-stack', ['artifact-write', 'outputs/web-e2e.json'], { input: report, encoding: 'utf8' });
      if (saved.status !== 0) { console.error('Could not save browser acceptance report'); process.exitCode = 1; }
    } else await writeFile('outputs/web-e2e.json', report);
    console.log(`${results.filter(r => r.status === 'PASS').length}/${results.length} Playwright scenarios passed. Native Android flow is not included.`);
  }
}

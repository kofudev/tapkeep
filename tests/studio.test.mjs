import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { request } from 'node:http';
import { Recorder } from '../dist/recorder.js';
import { startStudio } from '../dist/studio.js';
import { startDemoApp } from '../scripts/demo-app.mjs';

test('Studio runs real flows and protects its local API', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'tapkeep-studio-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  const app = await startDemoApp();
  t.after(async () => {
    await app.close();
  });
  const recorder = new Recorder(root, () => {}, true);
  t.after(async () => {
    await recorder.close();
  });
  await recorder.start('Create a project', app.url);
  await recorder.activePage.getByLabel('Project name').fill('Weekend build');
  await recorder.activePage.getByLabel('Plan').selectOption('team');
  await recorder.activePage.getByRole('button', { name: 'Create project', exact: true }).click();
  await recorder.activePage.getByRole('heading', { name: 'Project created', exact: true }).waitFor();
  await recorder.activePage.waitForTimeout(800);
  recorder.addTextCheck('Project created');
  const flow = await recorder.stop();
  assert.deepEqual(
    flow.steps.map((step) => step.type),
    ['fill', 'select', 'click', 'checkText'],
  );

  const studio = await startStudio(root, app.url, 0, false);
  t.after(async () => {
    await studio.close();
  });
  const studioUrl = new URL(studio.url);
  const token = studioUrl.hash.slice(1);
  assert.equal((await fetch(`${studioUrl.origin}/api/state`)).status, 401);
  assert.equal(
    (
      await fetch(`${studioUrl.origin}/api/state`, {
        headers: { Authorization: `Bearer ${token}`, Origin: 'https://example.com' },
      })
    ).status,
    403,
  );
  const badHostStatus = await new Promise((resolve, reject) => {
    const req = request(
      `${studioUrl.origin}/api/state`,
      {
        headers: { Authorization: `Bearer ${token}`, Host: `evil.example:${studioUrl.port}` },
      },
      (res) => {
        res.resume();
        resolve(res.statusCode);
      },
    );
    req.on('error', reject);
    req.end();
  });
  assert.equal(badHostStatus, 403);

  const browser = await chromium.launch({ headless: true });
  t.after(async () => {
    await browser.close();
  });
  const page = await browser.newPage({ viewport: { width: 1440, height: 980 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(studio.url);
  await page.getByRole('heading', { name: 'Create a project', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Run flow', exact: false }).click();
  await page.getByText('Flow passed.', { exact: true }).waitFor({ timeout: 20_000 });

  await page.getByRole('button', { name: 'Watch changes', exact: false }).click();
  await page.waitForFunction(
    () => document.getElementById('watch-button').getAttribute('aria-pressed') === 'true',
  );
  await page.waitForTimeout(300);
  const oldRun = (
    await (
      await fetch(`${studioUrl.origin}/api/state`, { headers: { Authorization: `Bearer ${token}` } })
    ).json()
  ).results[0].finishedAt;
  await writeFile(path.join(root, 'source.js'), 'export const changed = true;');
  await page.waitForFunction(
    async ({ origin, token, oldRun }) => {
      const response = await fetch(`${origin}/api/state`, { headers: { Authorization: `Bearer ${token}` } });
      const state = await response.json();
      return !state.running && state.results[0].finishedAt !== oldRun;
    },
    { origin: studioUrl.origin, token, oldRun },
    { timeout: 20_000 },
  );
  await page.getByRole('button', { name: 'Watching', exact: false }).click();
  await page.waitForFunction(
    () => document.getElementById('watch-button').getAttribute('aria-pressed') === 'false',
  );

  app.setBroken(true);
  await page.getByRole('button', { name: 'Run flow', exact: false }).click();
  await page.getByText('Flow failed.', { exact: true }).waitFor({ timeout: 20_000 });
  await page.getByText('View screenshot', { exact: true }).click();
  await page.locator('#failure-image').waitFor({ state: 'visible' });
  assert.ok(await page.locator('#failure-image').evaluate((image) => image.src.startsWith('blob:')));
  await page.locator('#image-close').click();
  assert.deepEqual(errors, []);

  if (process.env.TAPKEEP_SCREENSHOTS === '1')
    await page.screenshot({
      path: fileURLToPath(new URL('../assets/studio.png', import.meta.url)),
      fullPage: true,
    });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  if (process.env.TAPKEEP_SCREENSHOTS === '1')
    await page.screenshot({
      path: fileURLToPath(new URL('../assets/studio-mobile.png', import.meta.url)),
      fullPage: true,
    });

  page.on('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: 'Delete', exact: true }).click();
  await page.getByRole('heading', { name: 'Know when a real user path breaks.', exact: true }).waitFor();
  const result = await fetch(`${studioUrl.origin}/api/state`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.equal(
    (await result.json()).flows.some((item) => item.id === flow.id),
    false,
  );
});
// Kofu

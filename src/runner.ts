import { mkdir, readFile, readdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import { parseEnv } from 'node:util';
import { chromium, type Browser, type Page } from 'playwright';
import { captureCheckpoint, pageLocator, safeError } from './browser.js';
import { checkpointDifference } from './flow.js';
import type { Checkpoint, Flow, RunResult, Step, StepResult } from './types.js';

function targetUrl(startUrl: string, override?: string): string {
  if (!override) return startUrl;
  const original = new URL(startUrl);
  const base = new URL(override);
  if (!['http:', 'https:'].includes(base.protocol)) throw new Error('URL override must use HTTP or HTTPS.');
  return new URL(original.pathname + original.search, base.origin).toString();
}

async function verifyCheckpoint(
  page: Page,
  expected: Checkpoint,
): Promise<{ message: string | null; actual: Checkpoint }> {
  const deadline = Date.now() + 3_500;
  let actual = await captureCheckpoint(page);
  let message = checkpointDifference(expected, actual);
  while (message && Date.now() < deadline) {
    await page.waitForTimeout(150);
    actual = await captureCheckpoint(page);
    message = checkpointDifference(expected, actual);
  }
  return { message, actual };
}

async function perform(
  page: Page,
  step: Step,
  variables: Record<string, string>,
  trustedOrigin: string,
): Promise<void> {
  if (step.type === 'checkText') {
    await page.getByText(step.text!, { exact: false }).first().waitFor({ state: 'visible', timeout: 5_000 });
    return;
  }
  const locator = pageLocator(page, step.locator!);
  if (step.type === 'click') await locator.click({ timeout: 5_000 });
  if (step.type === 'fill') {
    if (step.env && new URL(page.url()).origin !== trustedOrigin)
      throw new Error('Secret input blocked: page redirected outside the target origin.');
    const value = step.env ? variables[step.env] : step.value;
    if (value === undefined) throw new Error(`Set ${step.env} before replaying this password field.`);
    await locator.fill(value, { timeout: 5_000 });
  }
  if (step.type === 'select') await locator.selectOption(step.value!, { timeout: 5_000 });
  if (step.type === 'press') await locator.press(step.value!, { timeout: 5_000 });
}

export async function runFlow(
  browser: Browser,
  flow: Flow,
  root: string,
  override?: string,
): Promise<RunResult> {
  const started = Date.now();
  const result: RunResult = {
    flowId: flow.id,
    name: flow.name,
    status: 'pass',
    durationMs: 0,
    finishedAt: '',
    steps: [],
    errors: [],
  };
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  let fileVariables: Record<string, string | undefined> = {};
  try {
    fileVariables = parseEnv(await readFile(path.join(root, '.env'), 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      await context.close();
      throw error;
    }
  }
  const variables: Record<string, string> = {};
  for (const step of flow.steps) {
    if (step.env) {
      const value = process.env[step.env] ?? fileVariables[step.env];
      if (value !== undefined) variables[step.env] = value;
    }
  }
  const secrets = Object.values(variables).filter(Boolean);
  const redact = (text: string) =>
    secrets.reduce((value, secret) => value.split(secret).join('[redacted]'), text);
  const recordError = (text: string) => {
    if (result.errors.length < 30) result.errors.push(redact(text));
  };
  const origin = new URL(targetUrl(flow.startUrl, override)).origin;
  page.on('pageerror', (error) => recordError(`Page: ${safeError(error)}`));
  page.on('console', (message) => {
    if (message.type() === 'error') recordError(`Console: ${safeError(message.text())}`);
  });
  page.on('response', (response) => {
    if (response.status() >= 500 && new URL(response.url()).origin === origin)
      recordError(`HTTP ${response.status()}: ${response.url()}`);
  });
  page.on('requestfailed', (request) => {
    const failure = request.failure()?.errorText || 'Request failed';
    if (new URL(request.url()).origin === origin && !failure.includes('ERR_ABORTED'))
      recordError(`Network: ${failure} (${request.url()})`);
  });
  try {
    await page.goto(targetUrl(flow.startUrl, override), { waitUntil: 'domcontentloaded', timeout: 15_000 });
    for (let index = 0; index < flow.steps.length; index++) {
      const step = flow.steps[index];
      const stepResult: StepResult = { index, status: 'pass', message: 'Passed' };
      try {
        await perform(page, step, variables, origin);
        await page.waitForTimeout(250);
        if (step.after) {
          const check = await verifyCheckpoint(page, step.after);
          stepResult.actual = {
            path: redact(check.actual.path),
            title: redact(check.actual.title),
            headings: check.actual.headings.map(redact),
          };
          if (check.message) throw new Error(check.message);
        }
      } catch (error) {
        stepResult.status = 'fail';
        stepResult.message = redact(safeError(error));
        result.status = 'fail';
      }
      result.steps.push(stepResult);
      if (result.status === 'fail') break;
    }
    await page.waitForTimeout(500);
    if (result.errors.length) result.status = 'fail';
  } catch (error) {
    result.status = 'fail';
    recordError(safeError(error));
  }
  if (result.status === 'fail') {
    try {
      const dir = path.join(root, '.tapkeep', 'runs');
      await mkdir(dir, { recursive: true });
      const file = path.join(dir, `${flow.id}-${Date.now()}.png`);
      await page.screenshot({
        path: file,
        fullPage: false,
        timeout: 5_000,
        maskColor: '#1d2b31',
        mask: flow.steps
          .filter((step) => step.env && step.locator)
          .map((step) => pageLocator(page, step.locator!)),
      });
      result.screenshot = file;
      const previous = (await readdir(dir))
        .filter((name) => name.startsWith(`${flow.id}-`) && /-\d+\.png$/.test(name))
        .sort((a, b) => Number(b.match(/-(\d+)\.png$/)![1]) - Number(a.match(/-(\d+)\.png$/)![1]));
      for (const name of previous.slice(3)) await unlink(path.join(dir, name));
    } catch {
      /* A closed page must not hide the original failure. */
    }
  }
  await context.close();
  result.durationMs = Date.now() - started;
  result.finishedAt = new Date().toISOString();
  return result;
}

export async function runFlows(flows: Flow[], root: string, override?: string): Promise<RunResult[]> {
  if (flows.length === 0) return [];
  const browser = await chromium.launch({ headless: true });
  try {
    const results: RunResult[] = [];
    for (const flow of flows) results.push(await runFlow(browser, flow, root, override));
    return results;
  } finally {
    await browser.close();
  }
}
// Kofu
// KOFUDEV

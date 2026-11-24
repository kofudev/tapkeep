import { randomBytes } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Checkpoint, Flow, Step } from './types.js';

const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,79}$/;

export function flowDirectory(root: string): string {
  return path.join(root, '.tapkeep', 'flows');
}

export function makeFlowId(name: string): string {
  const base =
    name
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 60) || 'flow';
  return `${base}-${randomBytes(3).toString('hex')}`;
}

export function assertFlowId(id: string): void {
  if (!ID_PATTERN.test(id)) throw new Error('Invalid flow ID.');
}

export function validFlow(data: unknown): data is Flow {
  if (!data || typeof data !== 'object') return false;
  const flow = data as Partial<Flow>;
  if (
    flow.version !== 1 ||
    typeof flow.id !== 'string' ||
    !ID_PATTERN.test(flow.id) ||
    typeof flow.name !== 'string' ||
    !flow.name.trim() ||
    flow.name.length > 80 ||
    typeof flow.startUrl !== 'string' ||
    typeof flow.createdAt !== 'string' ||
    !Number.isFinite(Date.parse(flow.createdAt)) ||
    !Array.isArray(flow.steps) ||
    flow.steps.length < 1 ||
    flow.steps.length > 1000
  )
    return false;
  try {
    const url = new URL(flow.startUrl);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return false;
  } catch {
    return false;
  }
  return flow.steps.every(validStep);
}

function validStep(data: unknown): data is Step {
  if (!data || typeof data !== 'object') return false;
  const step = data as Partial<Step>;
  if (step.label !== undefined && (typeof step.label !== 'string' || step.label.length > 180)) return false;
  if (!['click', 'fill', 'select', 'press', 'checkText'].includes(String(step.type))) return false;
  if (step.after && !validCheckpoint(step.after)) return false;
  if (step.type === 'checkText')
    return typeof step.text === 'string' && step.text.length > 0 && step.text.length <= 180;
  if (
    !step.locator ||
    typeof step.locator.value !== 'string' ||
    !step.locator.value ||
    step.locator.value.length > 2000 ||
    !['testId', 'id', 'name', 'label', 'placeholder', 'text', 'css', 'role'].includes(step.locator.by)
  )
    return false;
  if (step.locator.by === 'role' && !['button', 'link', 'checkbox', 'radio'].includes(step.locator.role))
    return false;
  if (step.type === 'fill')
    return (
      (typeof step.value === 'string' && step.value.length <= 100_000) ||
      (typeof step.env === 'string' && /^[A-Z_][A-Z0-9_]*$/.test(step.env))
    );
  if (step.type === 'select') return typeof step.value === 'string';
  if (step.type === 'press') return step.value === 'Enter';
  return true;
}

function validCheckpoint(data: unknown): data is Checkpoint {
  if (!data || typeof data !== 'object') return false;
  const checkpoint = data as Partial<Checkpoint>;
  return (
    typeof checkpoint.path === 'string' &&
    typeof checkpoint.title === 'string' &&
    Array.isArray(checkpoint.headings) &&
    checkpoint.headings.every((item) => typeof item === 'string')
  );
}

export async function listFlows(root: string): Promise<Flow[]> {
  const dir = flowDirectory(root);
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const flows: Flow[] = [];
  for (const name of names.filter((item) => item.endsWith('.json')).sort()) {
    let flow: unknown;
    try {
      flow = JSON.parse(await readFile(path.join(dir, name), 'utf8'));
    } catch {
      throw new Error(`Cannot read flow ${name}. Check its JSON syntax.`);
    }
    if (!validFlow(flow) || `${flow.id}.json` !== name)
      throw new Error(`Invalid flow ${name}. Check its fields and steps.`);
    flows.push(flow);
  }
  return flows.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function saveFlow(root: string, flow: Flow): Promise<void> {
  if (!validFlow(flow)) throw new Error('Invalid flow.');
  const dir = flowDirectory(root);
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, `${flow.id}.json`);
  const temp = path.join(dir, `.${flow.id}-${randomBytes(3).toString('hex')}.tmp`);
  await writeFile(temp, `${JSON.stringify(flow, null, 2)}\n`, { flag: 'wx' });
  try {
    await rename(temp, file);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
}

export async function deleteFlow(root: string, id: string): Promise<void> {
  assertFlowId(id);
  await rm(path.join(flowDirectory(root), `${id}.json`));
}

export function checkpointDifference(expected: Checkpoint, actual: Checkpoint): string | null {
  if (expected.path !== actual.path) return `URL changed: expected ${expected.path}, got ${actual.path}`;
  if (expected.title && expected.title !== actual.title)
    return `Title changed: expected “${expected.title}”, got “${actual.title}”`;
  for (const heading of expected.headings) {
    if (!actual.headings.includes(heading)) return `Missing heading: “${heading}”`;
  }
  return null;
}

export function normalizeText(value: string): string {
  return value.replace(/\s+/g, ' ').trim().slice(0, 180);
}
// Kofu
// KOFUDEV

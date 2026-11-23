import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { captureCheckpoint, RECORDER_SCRIPT, safeError } from './browser.js';
import { makeFlowId, saveFlow } from './flow.js';
import type { Flow, Locator, Step } from './types.js';

type RecordedEvent = {
  type: 'click' | 'fill' | 'select' | 'press';
  locator: Locator;
  label?: string;
  value?: string;
  secret?: boolean;
};

export class Recorder {
  private browser?: Browser;
  private context?: BrowserContext;
  private page?: Page;
  private pending?: ReturnType<typeof setTimeout>;
  private secretCount = 0;
  private secretFields = new Map<string, string>();
  private starting = false;
  private flow?: Flow;
  private errors: string[] = [];

  constructor(
    private root: string,
    private notify: () => void,
    private headless = false,
  ) {}

  get activePage(): Page | undefined {
    return this.page;
  }

  get state() {
    return {
      active: Boolean(this.flow),
      starting: this.starting,
      flow: this.flow,
      errors: this.errors.slice(-5),
    };
  }

  async start(name: string, startUrl: string): Promise<void> {
    if (this.flow || this.starting) throw new Error('Recording already active.');
    if (!name.trim() || name.length > 80) throw new Error('Name must be 1–80 characters.');
    const url = new URL(startUrl);
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Use an HTTP or HTTPS URL.');
    if (url.username || url.password)
      throw new Error('Use a URL without embedded credentials. Record form login instead.');
    this.starting = true;
    try {
      this.browser = await chromium.launch({ headless: this.headless });
      this.context = await this.browser.newContext({ viewport: { width: 1280, height: 800 } });
      this.flow = {
        version: 1,
        id: makeFlowId(name),
        name: name.trim(),
        startUrl: url.toString(),
        createdAt: new Date().toISOString(),
        steps: [],
      };
      this.errors = [];
      await this.context.exposeBinding('__tapkeepRecord', async (_source, event: RecordedEvent) => {
        if (!this.flow || !event || !['click', 'fill', 'select', 'press'].includes(event.type)) return;
        if (!event.locator || typeof event.locator.value !== 'string') return;
        if (this.flow.steps.length >= 1000) {
          if (!this.errors.includes('Step limit reached. Save this flow before recording another.'))
            this.errors.push('Step limit reached. Save this flow before recording another.');
          return;
        }
        const step: Step = { type: event.type, locator: event.locator, label: event.label?.slice(0, 180) };
        if (event.type === 'fill' && event.secret) {
          const key = JSON.stringify(event.locator);
          if (!this.secretFields.has(key)) this.secretFields.set(key, `TAPKEEP_SECRET_${++this.secretCount}`);
          step.env = this.secretFields.get(key);
        } else if (event.type !== 'click') {
          step.value = String(event.value ?? '');
        }
        const previous = this.flow.steps.at(-1);
        if (
          step.type === 'fill' &&
          previous?.type === 'fill' &&
          JSON.stringify(previous.locator) === JSON.stringify(step.locator)
        ) {
          previous.value = step.value;
          previous.env = step.env;
          previous.after = undefined;
          this.scheduleCheckpoint();
          this.notify();
          return;
        }
        this.flow.steps.push(step);
        this.scheduleCheckpoint();
        this.notify();
      });
      await this.context.addInitScript({ content: RECORDER_SCRIPT });
      this.page = await this.context.newPage();
      this.page.on('pageerror', (error) => {
        if (this.errors.length < 20) this.errors.push(safeError(error));
        this.notify();
      });
      this.page.on('close', () => {
        this.errors.push('Browser window closed. Stop or discard recording.');
        this.notify();
      });
      await this.page.goto(url.toString(), { waitUntil: 'domcontentloaded', timeout: 15_000 });
      this.notify();
    } catch (error) {
      await this.browser?.close();
      this.reset();
      throw error;
    } finally {
      this.starting = false;
    }
  }

  private scheduleCheckpoint(): void {
    if (this.pending) clearTimeout(this.pending);
    this.pending = setTimeout(() => {
      void this.captureLast();
    }, 650);
  }

  private async captureLast(): Promise<void> {
    this.pending = undefined;
    if (!this.flow || !this.page || this.page.isClosed() || this.flow.steps.length === 0) return;
    try {
      const step = this.flow.steps.at(-1)!;
      step.after = await captureCheckpoint(this.page);
      this.notify();
    } catch (error) {
      this.errors.push(`Could not capture page state: ${safeError(error)}`);
      this.notify();
    }
  }

  addTextCheck(text: string): void {
    if (!this.flow) throw new Error('Start a recording first.');
    const clean = text.trim();
    if (!clean || clean.length > 180) throw new Error('Text check must be 1–180 characters.');
    this.flow.steps.push({ type: 'checkText', text: clean });
    this.scheduleCheckpoint();
    this.notify();
  }

  async stop(save = true): Promise<Flow | undefined> {
    if (this.starting) throw new Error('Wait for browser to finish opening.');
    if (!this.flow) throw new Error('No recording active.');
    if (this.pending) {
      clearTimeout(this.pending);
      await this.captureLast();
    }
    const flow = this.flow;
    if (save) {
      if (flow.steps.length === 0) throw new Error('Nothing recorded. Add an action or discard recording.');
      await saveFlow(this.root, flow);
    }
    await this.browser?.close();
    this.reset();
    if (save) return flow;
    return undefined;
  }

  async close(): Promise<void> {
    if (this.pending) clearTimeout(this.pending);
    await this.browser?.close();
    this.reset();
  }

  private reset(): void {
    this.flow = undefined;
    this.context = undefined;
    this.page = undefined;
    this.browser = undefined;
    this.pending = undefined;
    this.secretCount = 0;
    this.secretFields.clear();
    this.notify();
  }
}
// Kofu

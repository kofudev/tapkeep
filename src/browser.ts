import type { Locator, Checkpoint } from './types.js';
import type { Page } from 'playwright';
import { normalizeText } from './flow.js';

export async function captureCheckpoint(page: Page): Promise<Checkpoint> {
  return page.evaluate(() => {
    const clean = (value: string) => value.replace(/\s+/g, ' ').trim().slice(0, 180);
    const url = new URL(location.href);
    const headings = [...document.querySelectorAll('h1, h2')]
      .filter((element) => (element as HTMLElement).getClientRects().length > 0)
      .map((element) => clean(element.textContent || ''))
      .filter(Boolean)
      .slice(0, 6);
    return { path: url.pathname + url.search, title: clean(document.title), headings };
  });
}

export function pageLocator(page: Page, locator: Locator) {
  switch (locator.by) {
    case 'testId':
      return page.getByTestId(locator.value);
    case 'role':
      return page.getByRole(locator.role, { name: locator.value, exact: true });
    case 'id':
      return page.locator(`[id=${JSON.stringify(locator.value)}]`);
    case 'name':
      return page.locator(`[name=${JSON.stringify(locator.value)}]`);
    case 'label':
      return page.getByLabel(locator.value, { exact: true });
    case 'placeholder':
      return page.getByPlaceholder(locator.value, { exact: true });
    case 'text':
      return page.getByText(locator.value, { exact: true });
    case 'css':
      return page.locator(locator.value);
  }
}

export function safeError(error: unknown): string {
  return normalizeText(error instanceof Error ? error.message : String(error)).slice(0, 300);
}

export const RECORDER_SCRIPT = `(() => {
  const clean = (value) => String(value || '').replace(/\\s+/g, ' ').trim().slice(0, 180);
  const css = (value) => CSS.escape(value);
  const labelFor = (element) => clean(element.getAttribute('aria-label') || element.labels?.[0]?.textContent
    || element.innerText || element.getAttribute('placeholder') || element.name || element.id || element.tagName.toLowerCase());
  const unique = (selector) => {
    try { return document.querySelectorAll(selector).length === 1; } catch { return false; }
  };
  const locatorFor = (element) => {
    const testId = element.getAttribute('data-testid');
    if (testId && unique('[data-testid="' + css(testId) + '"]')) return { by: 'testId', value: testId };
    if (element.id && unique('#' + css(element.id))) return { by: 'id', value: element.id };
    const name = element.getAttribute('name');
    if (name && unique('[name="' + css(name) + '"]')) return { by: 'name', value: name };
    const label = element.labels?.[0]?.textContent || element.getAttribute('aria-label');
    if (label && clean(label)) return { by: 'label', value: clean(label) };
    const placeholder = element.getAttribute('placeholder');
    if (placeholder && unique('[placeholder="' + css(placeholder) + '"]')) return { by: 'placeholder', value: placeholder };
    const role = element.getAttribute('role') || (element.matches('button, input[type=submit], summary') ? 'button'
      : element.matches('a[href]') ? 'link' : element.matches('input[type=checkbox]') ? 'checkbox'
      : element.matches('input[type=radio]') ? 'radio' : null);
    const accessibleName = clean(element.getAttribute('aria-label') || element.textContent || element.value);
    if (role && ['button', 'link', 'checkbox', 'radio'].includes(role) && accessibleName) {
      const candidates = [...document.querySelectorAll('button, a[href], [role], input[type=submit], summary')];
      if (candidates.filter(node => clean(node.getAttribute('aria-label') || node.textContent || node.value) === accessibleName).length === 1)
        return { by: 'role', role, value: accessibleName };
    }
    let node = element;
    const parts = [];
    while (node && node.nodeType === 1 && node !== document.documentElement && parts.length < 7) {
      let part = node.tagName.toLowerCase();
      const parent = node.parentElement;
      if (parent) {
        const siblings = [...parent.children].filter(child => child.tagName === node.tagName);
        if (siblings.length > 1) part += ':nth-of-type(' + (siblings.indexOf(node) + 1) + ')';
      }
      parts.unshift(part);
      const selector = parts.join(' > ');
      if (unique(selector)) return { by: 'css', value: selector };
      node = parent;
    }
    return { by: 'css', value: parts.join(' > ') };
  };
  const send = (event) => { if (window.__tapkeepRecord) window.__tapkeepRecord(event).catch(() => {}); };
  let lastEnter = -1000;
  document.addEventListener('input', (event) => {
    const element = event.target;
    if (!(element instanceof HTMLElement)) return;
    if (element.matches('input:not([type=checkbox]):not([type=radio]):not([type=file]), textarea')) {
      const secret = element.getAttribute('type') === 'password'
        || /password|token|secret|api[-_]?key|authorization|credit|card|cvv/i.test(
          [element.getAttribute('name'), element.id, element.getAttribute('autocomplete')].join(' '));
      send({ type: 'fill', locator: locatorFor(element), label: labelFor(element), value: secret ? undefined : element.value, secret });
    }
  }, true);
  document.addEventListener('change', (event) => {
    const element = event.target;
    if (element instanceof HTMLSelectElement) send({ type: 'select', locator: locatorFor(element), label: labelFor(element), value: element.value });
  }, true);
  document.addEventListener('click', (event) => {
    if (event.detail === 0 && performance.now() - lastEnter < 500) return;
    const element = event.target instanceof Element
      ? event.target.closest('a, button, [role=button], input[type=submit], input[type=checkbox], input[type=radio], summary') : null;
    if (!element) return;
    send({ type: 'click', locator: locatorFor(element), label: labelFor(element) });
  }, true);
  document.addEventListener('keydown', (event) => {
    const element = event.target;
    if (event.key !== 'Enter' || !(element instanceof HTMLInputElement) || element.type === 'file') return;
    lastEnter = performance.now();
    const secret = element.type === 'password'
      || /password|token|secret|api[-_]?key|authorization|credit|card|cvv/i.test([element.name, element.id, element.autocomplete].join(' '));
    send({ type: 'fill', locator: locatorFor(element), label: labelFor(element), value: secret ? undefined : element.value, secret });
    send({ type: 'press', locator: locatorFor(element), label: labelFor(element), value: 'Enter' });
  }, true);
})();`;
// Kofu

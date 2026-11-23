#!/usr/bin/env node
import path from 'node:path';
import { stat } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import chokidar from 'chokidar';
import { listFlows } from './flow.js';
import { runFlows } from './runner.js';
import { startStudio } from './studio.js';

const help = `Tapkeep — record a working path. Know what broke.

Usage:
  tapkeep setup [--with-deps]
  tapkeep studio <url> [--root dir] [--port number] [--no-open]
  tapkeep run [flow-id] [--root dir] [--url base-url] [--json]
  tapkeep watch [--root dir] [--url base-url]
  tapkeep list [--root dir]

First time: tapkeep setup

Studio opens a local dashboard. Record actions in the browser it launches.
Flows live in .tapkeep/flows. Commit flows; ignore .tapkeep/runs.
`;

async function run(root: string, flowId?: string, baseUrl?: string, json = false): Promise<boolean> {
  const flows = await listFlows(root);
  const selected = flowId ? flows.filter((flow) => flow.id === flowId) : flows;
  if (flowId && selected.length === 0) throw new Error(`Flow “${flowId}” not found.`);
  if (selected.length === 0) throw new Error('No flows found. Start with tapkeep studio <url>.');
  const results = await runFlows(selected, root, baseUrl);
  if (json) {
    console.log(JSON.stringify(results, null, 2));
    return results.every((result) => result.status === 'pass');
  }
  for (const result of results) {
    const icon = result.status === 'pass' ? 'PASS' : 'FAIL';
    console.log(`${icon}  ${result.name}  ${result.durationMs} ms`);
    for (const step of result.steps.filter((item) => item.status === 'fail'))
      console.log(`  Step ${step.index + 1}: ${step.message}`);
    for (const error of result.errors) console.log(`  ${error}`);
    if (result.screenshot) console.log(`  Screenshot: ${result.screenshot}`);
  }
  return results.every((result) => result.status === 'pass');
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      root: { type: 'string' },
      url: { type: 'string' },
      port: { type: 'string' },
      'no-open': { type: 'boolean' },
      json: { type: 'boolean' },
      'with-deps': { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean', short: 'v' },
    },
  });
  if (values.version) {
    console.log('0.1.0');
    return;
  }
  const command = positionals[0] || 'help';
  if (command === 'help' || values.help) {
    console.log(help);
    return;
  }
  if (positionals.length > (['studio', 'run'].includes(command) ? 2 : 1))
    throw new Error('Unexpected positional argument. Run tapkeep --help.');
  if (command === 'setup') {
    const require = createRequire(import.meta.url);
    const cli = path.join(path.dirname(require.resolve('playwright/package.json')), 'cli.js');
    const args = ['install', ...(values['with-deps'] ? ['--with-deps'] : []), 'chromium'];
    const child = spawn(process.execPath, [cli, ...args], { stdio: 'inherit' });
    process.exitCode = await new Promise<number>((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code) => resolve(code ?? 2));
    });
    if (process.exitCode === 0) console.log('Chromium ready. Start with tapkeep studio <app-url>.');
    return;
  }
  const root = path.resolve(values.root || process.cwd());
  if (!(await stat(root)).isDirectory()) throw new Error('Project root must be a directory.');
  if (command === 'list') {
    const flows = await listFlows(root);
    for (const flow of flows) console.log(`${flow.id}\t${flow.name}\t${flow.steps.length} steps`);
    if (!flows.length) console.log('No flows yet.');
    return;
  }
  if (command === 'studio') {
    const url = positionals[1];
    if (!url || url.startsWith('--'))
      throw new Error('Studio needs an app URL. Example: tapkeep studio http://127.0.0.1:3000');
    const portText = values.port;
    const port = portText ? Number(portText) : 0;
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Port must be 0–65535.');
    if (!['http:', 'https:'].includes(new URL(url).protocol))
      throw new Error('App URL must use HTTP or HTTPS.');
    const studio = await startStudio(root, url, port, !values['no-open']);
    console.log(`Tapkeep Studio: ${studio.url}`);
    console.log(`Project: ${root}`);
    const shutdown = async () => {
      await studio.close();
      process.exit(0);
    };
    process.once('SIGINT', () => {
      void shutdown();
    });
    process.once('SIGTERM', () => {
      void shutdown();
    });
    return;
  }
  if (command === 'run') {
    if (!(await run(root, positionals[1], values.url, values.json))) process.exitCode = 1;
    return;
  }
  if (command === 'watch') {
    let busy = false;
    let queued = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const check = async () => {
      if (busy) {
        queued = true;
        return;
      }
      busy = true;
      try {
        await run(root, undefined, values.url);
      } catch (error) {
        console.error(error instanceof Error ? error.message : error);
      } finally {
        busy = false;
        if (queued) {
          queued = false;
          setTimeout(() => {
            void check();
          }, 200);
        }
      }
    };
    await check();
    const watcher = chokidar.watch(root, {
      ignoreInitial: true,
      depth: 8,
      ignored: (item) =>
        /(^|[\\/])(\.git|\.tapkeep|node_modules|dist|build|coverage|\.next|\.venv)([\\/]|$)/.test(item),
    });
    watcher.on('all', () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        void check();
      }, 800);
    });
    watcher.on('error', (error) => console.error(`Watch failed: ${String(error)}`));
    console.log('Watching project files. Ctrl+C to stop.');
    process.once('SIGINT', () => {
      void watcher.close().then(() => process.exit(0));
    });
    return;
  }
  throw new Error(`Unknown command “${command}”. Run tapkeep --help.`);
}

main().catch((error) => {
  console.error(`Tapkeep: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 2;
});
// Kofu

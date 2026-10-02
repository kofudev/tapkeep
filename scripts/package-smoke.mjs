import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error('Run through npm run smoke.');
const temp = await mkdtemp(path.join(os.tmpdir(), 'tapkeep-package-'));
let child;
let app;
try {
  const packed = JSON.parse(
    (await exec(process.execPath, [npmCli, 'pack', '--json', '--pack-destination', temp])).stdout,
  )[0];
  const installRoot = path.join(temp, 'installed');
  await mkdir(installRoot);
  await exec(process.execPath, [
    npmCli,
    'install',
    '--prefix',
    installRoot,
    path.join(temp, packed.filename),
    '--no-audit',
    '--no-fund',
  ]);
  const cli = path.join(installRoot, 'node_modules', 'tapkeep', 'dist', 'cli.js');
  assert.equal((await exec(process.execPath, [cli, '--version'])).stdout.trim(), '0.1.0');

  app = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html' });
    response.end(
      '<!doctype html><title>Package fixture</title><link rel="icon" href="data:,"><h1>Ready</h1><button id="next" onclick="document.querySelector(\'h1\').textContent=\'Done\'">Next</button>',
    );
  });
  await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
  const appUrl = `http://127.0.0.1:${app.address().port}/`;
  const flowDir = path.join(installRoot, '.tapkeep', 'flows');
  await mkdir(flowDir, { recursive: true });
  await writeFile(
    path.join(flowDir, 'package-flow.json'),
    JSON.stringify({
      version: 1,
      id: 'package-flow',
      name: 'Packaged replay',
      startUrl: appUrl,
      createdAt: new Date().toISOString(),
      steps: [
        {
          type: 'click',
          locator: { by: 'id', value: 'next' },
          after: { path: '/', title: 'Package fixture', headings: ['Done'] },
        },
      ],
    }),
  );
  const results = JSON.parse(
    (await exec(process.execPath, [cli, 'run', '--root', installRoot, '--json'])).stdout,
  );
  assert.equal(results[0].status, 'pass');

  child = spawn(process.execPath, [cli, 'studio', appUrl, '--root', installRoot, '--no-open'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const studioUrl = await new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error('Packaged Studio did not start.')), 10_000);
    child.stdout.on('data', (chunk) => {
      output += chunk;
      const match = output.match(/Tapkeep Studio: (http:\/\/[^\s]+)/);
      if (match) {
        clearTimeout(timer);
        resolve(new URL(match[1]));
      }
    });
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', (code) => {
      if (code) {
        clearTimeout(timer);
        reject(new Error(`Studio exited ${code}`));
      }
    });
  });
  assert.equal((await fetch(studioUrl.origin)).status, 200);
  assert.equal((await fetch(`${studioUrl.origin}/app.js`)).status, 200);
  const response = await fetch(`${studioUrl.origin}/api/state`, {
    headers: { Authorization: `Bearer ${studioUrl.hash.slice(1)}` },
  });
  assert.equal((await response.json()).flows[0].name, 'Packaged replay');
  console.log('Clean package install, browser replay and Studio assets passed.');
} finally {
  if (child && child.exitCode === null) {
    const exited = new Promise((resolve) => child.once('exit', resolve));
    child.kill();
    await exited;
  }
  if (app) await new Promise((resolve) => app.close(resolve));
  await rm(temp, { recursive: true, force: true });
}

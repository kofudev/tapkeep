import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { makeFlowId, checkpointDifference, listFlows, validFlow } from '../dist/flow.js';
import { Recorder } from '../dist/recorder.js';
import { runFlows } from '../dist/runner.js';

test('flow IDs stay inside flow directory', () => {
  for (let index = 0; index < 20; index++)
    assert.match(makeFlowId('../../Très mauvais?'), /^[a-z0-9][a-z0-9-]*$/);
  assert.equal(validFlow({ version: 1, id: '../bad', name: 'Bad', startUrl: 'x', steps: [] }), false);
});

test('checkpoint compares actual behavior', () => {
  const baseline = { path: '/new', title: 'Demo', headings: ['Project created'] };
  assert.equal(checkpointDifference(baseline, baseline), null);
  assert.match(checkpointDifference(baseline, { ...baseline, path: '/login' }), /URL changed/);
  assert.match(checkpointDifference(baseline, { ...baseline, headings: ['Oops'] }), /Missing heading/);
});

test('record → replay → detect first changed step', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'tapkeep-test-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  let broken = false;
  const server = createServer((request, response) => {
    if (request.url === '/favicon.ico') {
      response.writeHead(204);
      response.end();
      return;
    }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(`<!doctype html><title>Demo</title><h1>Ready</h1><button id="create">Create project</button><script>
      document.getElementById('create').onclick = () => {
        document.querySelector('h1').textContent = ${JSON.stringify(broken ? 'Oops' : 'Project created')};
      };
    </script>`);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
  });
  const address = server.address();
  const url = `http://127.0.0.1:${address.port}/`;

  const recorder = new Recorder(root, () => {}, true);
  t.after(async () => {
    await recorder.close();
  });
  const opening = recorder.start('Create project', url);
  await assert.rejects(recorder.start('Duplicate start', url), /already active/);
  await opening;
  await assert.rejects(recorder.stop(), /Nothing recorded/);
  assert.equal(recorder.state.active, true);
  await recorder.activePage.getByRole('button', { name: 'Create project' }).click();
  await recorder.activePage.waitForTimeout(900);
  recorder.addTextCheck('Project created');
  const flow = await recorder.stop();
  assert.equal(flow.steps.length, 2);
  assert.equal(flow.steps[0].type, 'click');
  assert.equal(flow.steps[0].after.headings[0], 'Project created');
  assert.equal(flow.steps[1].type, 'checkText');
  assert.equal((await listFlows(root))[0].id, flow.id);
  assert.equal(
    JSON.parse(await readFile(path.join(root, '.tapkeep', 'flows', `${flow.id}.json`), 'utf8')).version,
    1,
  );

  const passing = await runFlows([flow], root);
  assert.equal(passing[0].status, 'pass', JSON.stringify(passing[0]));

  broken = true;
  const failing = await runFlows([flow], root);
  assert.equal(failing[0].status, 'fail');
  assert.equal(failing[0].steps[0].status, 'fail');
  assert.match(failing[0].steps[0].message, /Missing heading/);
  assert.ok((await stat(failing[0].screenshot)).size > 0);
});

test('sensitive input and Enter submission replay through environment references', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'tapkeep-secret-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  const secret = 'private-test-token-8367';
  let noisy = false;
  let redirectTo;
  const server = createServer((request, response) => {
    if (request.url === '/redirect') {
      response.writeHead(302, { location: redirectTo });
      response.end();
      return;
    }
    response.writeHead(200, { 'content-type': 'text/html' });
    response.end(`<!doctype html><title>Token form</title><link rel="icon" href="data:,"><h1>Sign in</h1><form><input name="api_token" aria-label="API token"><button>Submit</button></form><script>
      document.querySelector('form').onsubmit = (event) => { event.preventDefault();
        const value = document.querySelector('input').value;
        document.querySelector('h1').textContent = value === ${JSON.stringify(secret)} ? 'Signed in' : 'Invalid token';
        if (${noisy}) console.error('Token was ' + value);
      };
    </script>`);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
  });
  const recorder = new Recorder(root, () => {}, true);
  t.after(async () => {
    await recorder.close();
  });
  await recorder.start('Token login', `http://127.0.0.1:${server.address().port}/`);
  await recorder.activePage.getByLabel('API token').fill(secret);
  await recorder.activePage.getByLabel('API token').press('Enter');
  await recorder.activePage.waitForTimeout(800);
  const flow = await recorder.stop();
  assert.deepEqual(
    flow.steps.map((step) => step.type),
    ['fill', 'press'],
  );
  assert.equal(flow.steps[0].env, 'TAPKEEP_SECRET_1');
  assert.equal(JSON.stringify(flow).includes(secret), false);
  await writeFile(path.join(root, '.env'), `TAPKEEP_SECRET_1=${secret}\n`);
  assert.equal((await runFlows([flow], root))[0].status, 'pass');
  noisy = true;
  const failed = (await runFlows([flow], root))[0];
  assert.equal(failed.status, 'fail');
  assert.equal(JSON.stringify(failed).includes(secret), false);
  assert.ok(failed.errors.some((message) => message.includes('[redacted]')));
  const foreignServer = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html' });
    response.end('<!doctype html><input name="api_token" aria-label="API token">');
  });
  await new Promise((resolve) => foreignServer.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise((resolve) => foreignServer.close(resolve));
  });
  redirectTo = `http://127.0.0.1:${foreignServer.address().port}/`;
  const redirected = await runFlows(
    [{ ...flow, startUrl: `http://127.0.0.1:${server.address().port}/redirect` }],
    root,
  );
  assert.equal(redirected[0].status, 'fail');
  assert.match(redirected[0].steps[0].message, /Secret input blocked/);
});

test('CLI rejects empty collections, invalid flows and unknown flags', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'tapkeep-cli-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
  const exec = promisify(execFile);
  assert.equal((await exec(process.execPath, [cli, '--version'])).stdout.trim(), '0.1.0');
  await assert.rejects(
    exec(process.execPath, [cli, 'run', '--root', root]),
    (error) => error.code === 2 && error.stderr.includes('No flows found'),
  );
  await assert.rejects(exec(process.execPath, [cli, '--unknown']), (error) => error.code === 2);
  await mkdir(path.join(root, '.tapkeep', 'flows'), { recursive: true });
  await writeFile(path.join(root, '.tapkeep', 'flows', 'broken.json'), '{"version":1}');
  await assert.rejects(
    exec(process.execPath, [cli, 'run', '--root', root]),
    (error) => error.code === 2 && error.stderr.includes('Invalid flow'),
  );
});

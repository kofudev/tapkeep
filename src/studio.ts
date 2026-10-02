import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import chokidar, { type FSWatcher } from 'chokidar';
import open from 'open';
import { deleteFlow, listFlows } from './flow.js';
import { Recorder } from './recorder.js';
import { runFlows } from './runner.js';
import type { Flow, RunResult } from './types.js';

const publicDir = fileURLToPath(new URL('../public/', import.meta.url));
const files: Record<string, [string, string]> = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
};

function respond(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  response.end(JSON.stringify(body));
}

async function bodyJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk);
    size += buffer.length;
    if (size > 16_384) throw new Error('Request too large.');
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as Record<string, unknown>;
}

export async function startStudio(root: string, targetUrl: string, requestedPort = 0, autoOpen = true) {
  const token = randomBytes(24).toString('hex');
  const tokenBuffer = Buffer.from(token);
  let flows = await listFlows(root);
  const results = new Map<string, RunResult>();
  let message = '';
  let running = false;
  let watcher: FSWatcher | undefined;
  let watchTimer: ReturnType<typeof setTimeout> | undefined;
  let watchEnabled = false;
  let pendingRun = false;
  const recorder = new Recorder(root, () => {});

  async function run(selected?: string) {
    if (running || recorder.state.active || recorder.state.starting) {
      pendingRun = true;
      return;
    }
    running = true;
    message = '';
    try {
      flows = await listFlows(root);
      const chosen = selected ? flows.filter((flow) => flow.id === selected) : flows;
      if (selected && chosen.length === 0) throw new Error('Flow not found.');
      for (const result of await runFlows(chosen, root)) results.set(result.flowId, result);
      message = chosen.length
        ? `${chosen.length} flow${chosen.length === 1 ? '' : 's'} checked.`
        : 'No flows yet.';
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    } finally {
      running = false;
      if (pendingRun && watchEnabled && !recorder.state.active) {
        pendingRun = false;
        setTimeout(() => {
          void run();
        }, 300);
      }
    }
  }

  async function setWatch(enabled: boolean) {
    if (!enabled) {
      watchEnabled = false;
      if (watchTimer) clearTimeout(watchTimer);
      await watcher?.close();
      watcher = undefined;
      return;
    }
    if (watchEnabled) return;
    watcher = chokidar.watch(root, {
      ignoreInitial: true,
      depth: 8,
      ignored: (item) =>
        /(^|[\\/])(\.git|\.tapkeep|node_modules|dist|build|coverage|\.next|\.venv)([\\/]|$)/.test(item),
    });
    watcher.on('all', () => {
      if (watchTimer) clearTimeout(watchTimer);
      watchTimer = setTimeout(() => {
        void run();
      }, 800);
    });
    watcher.on('error', (error) => {
      message = `Watch failed: ${error instanceof Error ? error.message : String(error)}`;
    });
    watchEnabled = true;
  }

  const server = createServer(async (request, response) => {
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : requestedPort;
    const expectedHost = `127.0.0.1:${port}`;
    if (request.headers.host !== expectedHost) {
      respond(response, 403, { error: 'Invalid host.' });
      return;
    }
    const origin = request.headers.origin;
    if (origin && origin !== `http://${expectedHost}`) {
      respond(response, 403, { error: 'Invalid origin.' });
      return;
    }
    const url = new URL(request.url || '/', `http://${expectedHost}`);
    const staticFile = files[url.pathname];
    if (request.method === 'GET' && staticFile) {
      try {
        const content = await readFile(path.join(publicDir, staticFile[0]));
        response.writeHead(200, {
          'content-type': staticFile[1],
          'cache-control': 'no-store',
          'x-content-type-options': 'nosniff',
          'content-security-policy':
            "default-src 'self'; img-src 'self' blob: data:; script-src 'self'; style-src 'self'; frame-ancestors 'none'; base-uri 'none'",
        });
        response.end(content);
      } catch {
        respond(response, 500, { error: 'Studio files missing. Run npm run build.' });
      }
      return;
    }
    const supplied = request.headers.authorization?.replace(/^Bearer /, '') || '';
    const suppliedBuffer = Buffer.from(supplied);
    if (suppliedBuffer.length !== tokenBuffer.length || !timingSafeEqual(suppliedBuffer, tokenBuffer)) {
      respond(response, 401, { error: 'Invalid studio token.' });
      return;
    }
    try {
      if (request.method === 'GET' && url.pathname === '/api/state') {
        flows = await listFlows(root);
        respond(response, 200, {
          targetUrl,
          root,
          flows,
          results: [...results.values()],
          recording: recorder.state,
          running,
          watchEnabled,
          message,
        });
      } else if (request.method === 'POST' && url.pathname === '/api/record/start') {
        const data = await bodyJson(request);
        if (running) throw new Error('Wait for current run to finish.');
        await recorder.start(String(data.name || ''), String(data.url || targetUrl));
        respond(response, 200, { ok: true });
      } else if (request.method === 'POST' && url.pathname === '/api/record/stop') {
        const flow = await recorder.stop(true);
        flows = await listFlows(root);
        message = `Saved ${flow?.name}.`;
        if (pendingRun && watchEnabled) {
          pendingRun = false;
          void run();
        }
        respond(response, 200, { flow });
      } else if (request.method === 'POST' && url.pathname === '/api/record/discard') {
        await recorder.stop(false);
        message = 'Recording discarded.';
        respond(response, 200, { ok: true });
      } else if (request.method === 'POST' && url.pathname === '/api/record/text') {
        const data = await bodyJson(request);
        recorder.addTextCheck(String(data.text || ''));
        respond(response, 200, { ok: true });
      } else if (request.method === 'POST' && url.pathname === '/api/run') {
        const data = await bodyJson(request);
        if (running) throw new Error('Run already in progress.');
        if (recorder.state.active || recorder.state.starting)
          throw new Error('Stop recording before running.');
        const id = data.id ? String(data.id) : undefined;
        void run(id);
        respond(response, 202, { ok: true });
      } else if (request.method === 'POST' && url.pathname === '/api/watch') {
        const data = await bodyJson(request);
        await setWatch(data.enabled === true);
        respond(response, 200, { watchEnabled });
      } else if (request.method === 'DELETE' && url.pathname.startsWith('/api/flows/')) {
        if (recorder.state.active || recorder.state.starting || running)
          throw new Error('Wait for recording or run to finish.');
        const id = url.pathname.slice('/api/flows/'.length);
        await deleteFlow(root, id);
        results.delete(id);
        flows = await listFlows(root);
        respond(response, 200, { ok: true });
      } else if (request.method === 'GET' && url.pathname.startsWith('/api/screenshot/')) {
        const id = url.pathname.slice('/api/screenshot/'.length);
        const file = results.get(id)?.screenshot;
        if (!file) {
          respond(response, 404, { error: 'Screenshot not found.' });
          return;
        }
        const data = await readFile(file);
        response.writeHead(200, {
          'content-type': 'image/png',
          'cache-control': 'no-store',
          'x-content-type-options': 'nosniff',
        });
        response.end(data);
      } else {
        respond(response, 404, { error: 'Not found.' });
      }
    } catch (error) {
      respond(response, 400, { error: error instanceof Error ? error.message : String(error) });
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(requestedPort, '127.0.0.1', resolve);
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : requestedPort;
  const studioUrl = `http://127.0.0.1:${port}/#${token}`;
  if (autoOpen) void open(studioUrl).catch(() => {});
  return {
    url: studioUrl,
    close: async () => {
      await setWatch(false);
      await recorder.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

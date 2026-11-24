import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';

export async function startDemoApp() {
  const html = await readFile(new URL('../examples/demo-page.html', import.meta.url));
  let broken = false;
  const server = createServer(async (request, response) => {
    if (request.url === '/demo-bug' && request.method === 'POST') {
      broken = !broken;
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ broken }));
    } else if (request.url === '/api/projects' && request.method === 'POST') {
      let body = '';
      for await (const chunk of request) body += chunk;
      const data = JSON.parse(body || '{}');
      response.writeHead(broken ? 500 : 201, { 'content-type': 'application/json' });
      response.end(JSON.stringify(broken ? { error: 'Demo API regression.' } : data));
    } else {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(html);
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}/`,
    setBroken: (value) => {
      broken = value;
    },
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
// Kofu
// KOFUDEV

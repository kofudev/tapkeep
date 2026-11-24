import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { startStudio } from '../dist/studio.js';
import { startDemoApp } from './demo-app.mjs';

const app = await startDemoApp();
const root = path.resolve('.tapkeep/demo');
await mkdir(root, { recursive: true });
const studio = await startStudio(root, app.url, 0, !process.argv.includes('--no-open'));
console.log(`Demo app: ${app.url}`);
console.log(`Tapkeep Studio: ${studio.url}`);
console.log('Record the create-project form. Save it. Then introduce a regression and replay.');
async function close() {
  await studio.close();
  await app.close();
  process.exit(0);
}
process.once('SIGINT', () => {
  void close();
});
process.once('SIGTERM', () => {
  void close();
});
// Kofu
// KOFUDEV

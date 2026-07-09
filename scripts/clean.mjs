import { rm } from 'node:fs/promises';
import path from 'node:path';

const root = process.cwd();
const targets = ['dist', 'server.js'];

for (const target of targets) {
  const resolved = path.resolve(root, target);
  if (!resolved.startsWith(root + path.sep) && resolved !== root) {
    throw new Error(`Refusing to remove path outside repository: ${resolved}`);
  }
  await rm(resolved, { recursive: true, force: true });
}

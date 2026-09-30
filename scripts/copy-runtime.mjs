import fs from 'node:fs';
import path from 'node:path';
const root = path.resolve(import.meta.dirname, '..');
const target = path.join(root, 'dist/runtime');
fs.mkdirSync(target, { recursive: true });
for (const file of fs.readdirSync(path.join(root, 'src/runtime'))) {
  if (file.endsWith('.ts')) fs.copyFileSync(path.join(root, 'src/runtime', file), path.join(target, file));
}

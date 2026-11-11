import { cp, mkdir, readdir, rm } from 'node:fs/promises';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const output = join(root, 'vercel-public');
const publicExtensions = new Set(['.html', '.css', '.js', '.txt', '.xml']);

await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });

for (const entry of await readdir(root, { withFileTypes: true })) {
  if (!entry.isFile() || !publicExtensions.has(extname(entry.name))) continue;
  await cp(join(root, entry.name), join(output, entry.name));
}

await cp(join(root, 'images'), join(output, 'images'), { recursive: true });

console.log(`Prepared Vercel static output in ${output}`);

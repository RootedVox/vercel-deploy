// Syntax-checks every first-party script, so a new file cannot be left out of `npm run check`.
// Vendored code, dependencies and build output are skipped.
import { spawn } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const skipped = new Set(['.git', 'node_modules', 'vendor', 'vercel-public', '.vercel', '.wrangler']);

async function scripts(directory) {
  const found = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (skipped.has(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) found.push(...await scripts(path));
    else if (/\.(?:js|mjs)$/.test(entry.name)) found.push(path);
  }
  return found;
}

function check(file) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, ['--check', file], { stdio: ['ignore', 'ignore', 'pipe'] });
    let error = '';
    child.stderr.on('data', chunk => { error += chunk; });
    child.on('close', code => resolve({ file, code, error }));
  });
}

const files = (await scripts(root)).sort();
const failures = [];
for (let index = 0; index < files.length; index += 8) {
  const results = await Promise.all(files.slice(index, index + 8).map(check));
  failures.push(...results.filter(result => result.code !== 0));
}
for (const failure of failures) console.error(`${relative(root, failure.file)}\n${failure.error}`);
if (failures.length) process.exit(1);
console.log(`Syntax OK: ${files.length} files`);

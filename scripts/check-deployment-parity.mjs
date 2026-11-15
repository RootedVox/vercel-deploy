// Compare independently deployed repositories without copying platform adapters.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const other = process.argv[2];
if (!other) throw new Error('Pass the path to the other deployment checkout');
const tracked = root => execFileSync('git', ['-C', root, 'ls-files', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean);
const platform = /^(?:\.github\/|\.assetsignore$|\.dev\.vars\.example$|api\/|vercel(?:\/|\.json$)|package(?:-lock)?\.json$|scripts\/build-vercel\.mjs$|docs\/VERCEL_DEPLOYMENT\.zh-CN\.md$|test\/(?:auth|go-live|vercel)\.test\.js$|functions\/(?:_middleware\.js|_lib\/(?:api|http)\.js|auth\/logout\.js)$)/;
const files = new Set([...tracked('.'), ...tracked(other)]);
const different = [];
for (const file of files) {
  if (platform.test(file)) continue;
  try {
    if (readFileSync(file).equals(readFileSync(join(other, file)))) continue;
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  different.push(file);
}
if (different.length) {
  console.error('Shared files differ:\n' + different.join('\n'));
  process.exitCode = 1;
}

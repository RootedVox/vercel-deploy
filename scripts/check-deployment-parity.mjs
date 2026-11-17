// Compare independently deployed repositories without copying platform adapters.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const other = process.argv[2];
if (!other) throw new Error('Pass the path to the other deployment checkout');
const tracked = root => execFileSync('git', ['-C', root, 'ls-files', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean);
// These paths are allowed to differ because Cloudflare and Vercel genuinely have
// different runtimes (request env, CORS/OPTIONS, cookie domain, API wrappers).
// They are exempt from the byte-for-byte check, NOT from review: when changing
// any of them, a human must manually compare BOTH deployments and keep the
// security behaviour (Origin check, session cookie, logout) equivalent.
const platform = /^(?:\.github\/|\.assetsignore$|_routes\.json$|\.dev\.vars\.example$|api\/|vercel(?:\/|\.json$)|package(?:-lock)?\.json$|scripts\/build-vercel\.mjs$|docs\/VERCEL_DEPLOYMENT\.zh-CN\.md$|test\/(?:auth|go-live|vercel)\.test\.js$|functions\/(?:_middleware\.js|_lib\/(?:api|http)\.js|auth\/logout\.js)$)/;
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

// Copies the shared header and footer into every page, so they are part of the HTML
// instead of being fetched by script after load (two extra requests and a late
// navigation bar on every visit). Edit header.html, header-checker.html or footer.html,
// then run this script; with --check it only reports pages that are out of date.
import { readdir, readFile, writeFile } from 'node:fs/promises';

const root = new URL('../', import.meta.url);
const partial = async name => (await readFile(new URL(name, root), 'utf8')).replace(/^\s*<!--[\s\S]*?-->\s*/, '').trim();
const slots = [
  ['headerBox', await partial('header.html')],
  ['footerBox', await partial('footer.html')],
  ['checkHeader', await partial('header-checker.html')]
];
const stale = [];
for (const name of (await readdir(root)).filter(name => name.endsWith('.html')).sort()) {
  const path = new URL(name, root);
  const page = await readFile(path, 'utf8');
  let updated = page;
  for (const [id, html] of slots) {
    // The closing marker lets the next run find the end of a filled slot.
    const slot = new RegExp(`(<(div|header) id="${id}"[^>]*>)(?:[\\s\\S]*?<!--/${id}-->)?(</\\2>)`);
    updated = updated.replace(slot, (match, open, tag, close) => `${open}${html}<!--/${id}-->${close}`);
  }
  if (updated === page) continue;
  if (process.argv.includes('--check')) stale.push(name);
  else await writeFile(path, updated);
}
if (stale.length) {
  console.error(`Run node scripts/sync-layout.mjs: the shared header or footer changed (${stale.join(', ')})`);
  process.exitCode = 1;
}

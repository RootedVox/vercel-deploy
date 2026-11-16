// Stamps every reference to a local script or stylesheet with a hash of the file's
// content: `common.css` becomes `common.css?v=<hash>`. Cloudflare keeps static files at
// the edge for days (s-maxage in _headers, plus the zone's browser cache TTL), and a
// changed file under an unchanged URL kept being served stale after a release. With
// the hash in the URL, a changed file gets a new URL and an unchanged one stays cached.
//
// Run after changing any .js or .css file; with --check it only reports what is stale.
// Scripts that load other files are stamped first, because stamping changes their own
// content and so their own hash.
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';

const root = new URL('../', import.meta.url);
const read = name => readFileSync(new URL(name, root), 'utf8');
const hash = name => createHash('sha256').update(readFileSync(new URL(name, root))).digest('hex').slice(0, 10);
// A same-origin reference to a .js or .css file, with an optional old ?v= stamp. The
// path may start with "/", "./" or nothing; absolute URLs and other files are ignored.
const reference = /(["'`])((?:\.\/|\/)?)((?:vendor\/(?:webp\/)?)?[A-Za-z0-9_.-]+\.(?:js|css))(?:\?v=[^"'`]*)?\1/g;

function stamp(text) {
  return text.replace(reference, (match, quote, prefix, path) => {
    if (!existsSync(new URL(path, root))) return match;
    return `${quote}${prefix}${path}?v=${hash(path)}${quote}`;
  });
}

const check = process.argv.includes('--check');
const stale = [];
function update(name) {
  const before = read(name), after = stamp(before);
  if (after === before) return;
  stale.push(name);
  if (!check) writeFileSync(new URL(name, root), after);
}

// Loaders first, in dependency order: the avatar editor loads the WebP encoder, the
// forum page loads the editor, and preferences.js loads the English table.
for (const name of ['avatar-editor.js', 'messages.js', 'preferences.js']) update(name);
for (const name of readdirSync(root).filter(name => name.endsWith('.html')).sort()) update(name);

if (stale.length) {
  console.error(`${check ? 'Out of date' : 'Updated'}: ${stale.join(', ')}`);
  if (check) {
    console.error('Run node scripts/sync-asset-versions.mjs after changing a script or stylesheet.');
    process.exitCode = 1;
  }
}

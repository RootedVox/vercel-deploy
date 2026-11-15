import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

const root = new URL('../', import.meta.url);
const read = name => readFileSync(new URL(name, root), 'utf8');

test('every page that runs home.js also loads forum-ui.js', () => {
  const pages = readdirSync(root).filter(name => name.endsWith('.html'))
    .filter(name => /<script[^>]+home\.js/.test(read(name)));
  assert.ok(pages.includes('index.html') && pages.includes('main.html'));
  for (const name of pages) assert.match(read(name), /<script src="\.\/forum-ui\.js"><\/script>/, name);
});

test('the two home pages stay identical', () => {
  assert.equal(read('index.html'), read('main.html'), 'edit both home pages together and rerun scripts/sync-home-notices.mjs');
});

test('unversioned scripts and styles are revalidated by browsers', () => {
  const headers = read('_headers');
  for (const type of ['js', 'css']) {
    assert.match(headers, new RegExp(`/\\*\\.${type}\\n  Cache-Control: public, max-age=0, must-revalidate`));
  }
});

test('pages show the small logo instead of the 1600px PNG', () => {
  for (const page of ['login.html', 'contact.html']) {
    assert.doesNotMatch(read(page), /<img[^>]+logo\.png/, page);
    assert.match(read(page), /<img src="\.\/images\/logo-512-v1\.webp"/, page);
  }
  assert.ok(readFileSync(new URL('images/logo-512-v1.webp', root)).length < 40_000);
});

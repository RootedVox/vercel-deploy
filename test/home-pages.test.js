import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

const root = new URL('../', import.meta.url);

test('every page that runs home.js also loads forum-ui.js', () => {
  const pages = readdirSync(root).filter(name => name.endsWith('.html'))
    .filter(name => /<script[^>]+home\.js/.test(readFileSync(new URL(name, root), 'utf8')));
  assert.ok(pages.includes('index.html') && pages.includes('main.html'));
  for (const name of pages) {
    assert.match(readFileSync(new URL(name, root), 'utf8'), /<script src="\.\/forum-ui\.js"><\/script>/, name);
  }
});

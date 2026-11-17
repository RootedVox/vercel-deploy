import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import vm from 'node:vm';

const root = new URL('../', import.meta.url);
const read = name => readFileSync(new URL(name, root), 'utf8');

test('every page that runs home.js also loads forum-ui.js', () => {
  const pages = readdirSync(root).filter(name => name.endsWith('.html'))
    .filter(name => /<script[^>]+home\.js/.test(read(name)));
  assert.ok(pages.includes('index.html') && pages.includes('main.html'));
  for (const name of pages) assert.match(read(name), /<script src="\.\/forum-ui\.js(?:\?v=[0-9a-f]{10})?"><\/script>/, name);
});

test('standalone HTML pages participate in the site theme', () => {
  for (const name of readdirSync(root).filter(name => name.endsWith('.html'))) {
    const html = read(name);
    if (!/<!doctype html>/i.test(html)) continue; // Header and footer fragments inherit the host theme.
    assert.match(html, /<script src="\/preferences\.js(?:\?[^"]*)?"><\/script>/, name);
    assert.match(html, /<link rel="stylesheet" href="\.?\/common\.css(?:\?[^"]*)?">/, name);
    assert.match(html, /<link rel="stylesheet" href="\/preferences\.css(?:\?[^"]*)?">/, name);
    assert.doesNotMatch(html, /<html[^>]*style="[^"]*color-scheme:/i, name);
  }
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

test('every notice has a date and the home pages show real dates', () => {
  const notices = [...read('notice.html').matchAll(/<li class="notice-item[^"]*"([^>]*)>/g)];
  assert.ok(notices.length >= 3);
  for (const [, attributes] of notices) assert.match(attributes, /data-date="20\d{2}-\d{2}-\d{2}"/);
  const dates = [...read('main.html').matchAll(/<time class="notice-date" datetime="(20\d{2}-\d{2}-\d{2})">\1<\/time>/g)];
  assert.equal(dates.length, 3);
  assert.doesNotMatch(read('main.html'), /notice-date">最新</);
});

test('zone cards show when the zone was last active, not how many posts they show', async () => {
  // The card lists at most two posts, so "最新 2 条" said nothing about the zone.
  const listeners = {}, host = { innerHTML: '' };
  const hour = new Date(Date.now() - 3 * 3600 * 1000).toISOString();
  const older = new Date(Date.now() - 5 * 86400 * 1000).toISOString();
  vm.runInNewContext(read('home.js'), {
    Intl, URL, Date, Math, Object,
    window: { RootedVoxPublicData: {} },
    RootedVoxPublicData: { overview: async () => ({ messages: [
      { id: '1', content: '作业求助', zone: '学习互助', username: 'A', created_at: older },
      { id: '2', content: '数学题', zone: '学习互助', username: 'B', created_at: hour }
    ] }) },
    ForumUI: { parseMessageContent: (content, zone) => ({ zone, text: content }), escapeHtml: String },
    performance: { getEntriesByType: () => [{ type: 'reload' }] },
    document: {
      addEventListener: (type, fn) => { listeners[type] = fn; },
      getElementById: id => id === 'latestFeed' ? host : null,
      querySelector: () => null, querySelectorAll: () => [],
      createElement: () => ({ set textContent(value) { this.innerHTML = value; } })
    }
  });
  listeners.DOMContentLoaded();
  await new Promise(resolve => setTimeout(resolve, 0));
  const badges = [...host.innerHTML.matchAll(/<span class="zone-count">([^<]*)<\/span>/g)].map(match => match[1]);
  assert.deepEqual(badges, ['暂无动态', '3小时前更新', '暂无动态', '暂无动态']);
  assert.doesNotMatch(host.innerHTML, /最新 \d+ 条/);
});

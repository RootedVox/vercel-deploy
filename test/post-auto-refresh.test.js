import test from 'node:test';
import assert from 'node:assert/strict';
import { runPageScript } from './page-script.js';

const POST = { id: 'p1', username: '测试', content: '周末一起打球吗', zone: '活动社团', created_at: '2026-11-17T08:00:00Z', pic_url: null };

// Runs messages.js with a feed container, a fake clock and a public thread that becomes
// visible after `publishedAfter` reads.
function setup({ publishedAfter = 1, filters = {}, failFirst = false } = {}) {
  const timers = [];
  const toasts = [];
  const rendered = [];
  let reads = 0;
  const cards = new Map();
  const container = {
    html: '<div class="empty-message">暂无留言</div>',
    querySelector: selector => selector === '.empty-message' && container.html.includes('empty-message')
      ? { remove() { container.html = ''; } } : null,
    insertAdjacentHTML(where, html) {
      assert.equal(where, 'afterbegin');
      container.html = html + container.html;
      const id = /id="message-([^"]+)"/.exec(html)[1];
      cards.set('message-' + id, { id });
    }
  };
  const page = runPageScript('messages.js', {
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    document: {
      addEventListener() {},
      getElementById: id => id === 'messageContainer' ? container : cards.get(id) || null
    },
    RootedVoxPublicData: {
      async threadPage(id) {
        reads++;
        if (failFirst && reads === 1) throw new Error('network');
        return { messages: reads >= publishedAfter ? [{ ...POST, id }] : [] };
      }
    },
    ForumUI: {
      escapeHtml: value => String(value ?? ''),
      parseMessageContent: (content, zone) => ({ zone, text: content }),
      renderMessageAvatars: items => rendered.push(...items),
      notify: (message, type) => toasts.push([message, type])
    }
  }, {
    replace: { activeSort: 'newest', activeSearch: '', activeZone: 'all', activeFeaturedFirst: false, ...filters },
    expose: ['watchForPublication']
  });
  const run = async () => {
    const timer = timers.shift();
    await timer.fn();
    return timer.ms;
  };
  return { page, timers, toasts, rendered, container, run, reads: () => reads };
}

test('a new text post appears at the top of the feed once the AI review publishes it', async () => {
  const h = setup({ publishedAfter: 2 });
  h.page.watchForPublication('p1');
  assert.equal(await h.run(), 3000);
  assert.equal(h.container.html.includes('message-p1'), false, 'still pending after the first check');
  assert.equal(await h.run(), 6000);
  assert.match(h.container.html, /^\s*<div class="message-item" id="message-p1"/);
  assert.doesNotMatch(h.container.html, /empty-message/);
  assert.match(h.container.html, /发表评论/, 'a brand-new post has no replies yet');
  assert.equal(h.rendered.length, 1);
  assert.deepEqual(h.toasts, [['你的留言已通过审核并公开。', 'success']]);
  assert.equal(h.timers.length, 0, 'no more checks after it is public');
});

test('the page gives up after four checks, about 45 seconds in all', async () => {
  const h = setup({ publishedAfter: 99 });
  h.page.watchForPublication('p1');
  const waits = [];
  while (h.timers.length) waits.push(await h.run());
  assert.deepEqual(waits, [3000, 6000, 12000, 24000]);
  assert.equal(h.reads(), 4);
  assert.equal(h.toasts.length, 0);
});

test('a failed read is retried at the next step', async () => {
  const h = setup({ publishedAfter: 2, failFirst: true });
  h.page.watchForPublication('p1');
  await h.run();
  await h.run();
  assert.match(h.container.html, /message-p1/);
});

test('the post is announced but not inserted where the current list would not show it', async () => {
  for (const filters of [{ activeZone: '学习互助' }, { activeSearch: '篮球' }, { activeSort: 'oldest' }, { activeFeaturedFirst: true }]) {
    const h = setup({ filters });
    h.page.watchForPublication('p1');
    await h.run();
    assert.equal(h.container.html.includes('message-p1'), false, JSON.stringify(filters));
    assert.equal(h.toasts.length, 1, JSON.stringify(filters));
  }
});

test('posting watches only plain text posts; images and featured submissions wait for a human', async () => {
  const source = (await import('node:fs')).readFileSync(new URL('../messages.js', import.meta.url), 'utf8');
  assert.match(source, /if \(result\.published === true\) loadMainMessages\(false\);\s*else if \(!featured && !picUrls\.length && result\.id\) watchForPublication\(result\.id\);/);
});

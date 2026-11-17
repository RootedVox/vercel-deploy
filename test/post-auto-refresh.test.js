import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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
  const source = readFileSync(new URL('../messages.js', import.meta.url), 'utf8');
  assert.match(source, /if \(result\.published === true\) loadMainMessages\(false\);\s*else if \(!featured && !picUrls\.length && result\.id\) watchForPublication\(result\.id\);/);
});

// ---- Replies on the thread page ----
const REPLY = { id: 'r9', username: '回复者', content: '我也去！', reply_to: 'root', created_at: '2026-11-17T08:01:00Z', pic_url: null };

function setupThread({ publishedAfter = 1, search = '?id=root', state = {} } = {}) {
  const timers = [];
  const toasts = [];
  const rendered = [];
  let reads = 0;
  const appended = [];
  const container = {
    empty: true,
    querySelector: selector => selector === '.empty-comment' && container.empty ? { remove() { container.empty = false; } } : null,
    append(fragment) { appended.push(fragment.html); }
  };
  const document = {
    addEventListener() {},
    querySelector: () => null,
    getElementById: id => id === 'commentContainer' ? container : null,
    createElement: () => {
      const template = { set innerHTML(html) { template.content.html = html; template.content.children = [{ html }]; }, content: { html: '', children: [] } };
      return template;
    }
  };
  const page = runPageScript('details.js', {
    location: { search },
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    document,
    RootedVoxPublicData: {
      async threadPage(root, after, reply) {
        reads++;
        assert.equal(root, 'root');
        assert.equal(after, null);
        return { messages: reads >= publishedAfter ? [{ id: 'root' }, { ...REPLY, id: reply }] : [{ id: 'root' }] };
      }
    },
    ForumUI: {
      escapeHtml: value => String(value ?? ''),
      parseMessageContent: (content, zone) => ({ zone, text: content }),
      renderMessageAvatars: items => rendered.push(...items),
      notify: (message, type) => toasts.push([message, type])
    }
  }, {
    replace: { mainMsgId: 'root', threadCursor: null, renderedComments: 0, orderedComments: [], userMap: { root: '楼主' }, ...state },
    expose: ['watchReplyPublication', 'orderedComments', 'userMap']
  });
  const run = async () => { const timer = timers.shift(); await timer.fn(); return timer.ms; };
  return { page, timers, toasts, rendered, appended, container, run, reads: () => reads };
}

test('a new text reply is added to the end of the thread once it is public', async () => {
  const h = setupThread({ publishedAfter: 2 });
  h.page.watchReplyPublication('r9');
  assert.equal(await h.run(), 3000);
  assert.equal(h.appended.length, 0);
  assert.equal(await h.run(), 6000);
  assert.equal(h.appended.length, 1);
  assert.match(h.appended[0], /id="msg-r9"/);
  assert.match(h.appended[0], /我也去！/);
  assert.equal(h.container.empty, false, 'the "no comments yet" line is removed');
  assert.equal(h.rendered.length, 1);
  assert.deepEqual(h.toasts, [['你的回复已通过审核并公开。', 'success']]);
  assert.equal(h.timers.length, 0);
});

test('a reply is announced but not added while earlier comments are not all on the page', async () => {
  for (const state of [{ threadCursor: 'more' }, { renderedComments: 20, orderedComments: new Array(25).fill({}) }]) {
    const h = setupThread({ state });
    h.page.watchReplyPublication('r9');
    await h.run();
    assert.equal(h.appended.length, 0, JSON.stringify(Object.keys(state)));
    assert.equal(h.toasts.length, 1);
  }
});

test('a page that shows one linked reply is left as it is', async () => {
  const h = setupThread({ search: '?id=root&replyId=12345' });
  h.page.watchReplyPublication('r9');
  await h.run();
  assert.equal(h.appended.length, 0);
  assert.equal(h.toasts.length, 1);
});

test('reply watching gives up after four checks', async () => {
  const h = setupThread({ publishedAfter: 99 });
  h.page.watchReplyPublication('r9');
  const waits = [];
  while (h.timers.length) waits.push(await h.run());
  assert.deepEqual(waits, [3000, 6000, 12000, 24000]);
  assert.equal(h.toasts.length, 0);
});

test('replying watches only text replies the server has not published yet', () => {
  const source = readFileSync(new URL('../details.js', import.meta.url), 'utf8');
  assert.match(source, /if \(result\.id && result\.published !== true && !urls\.length\) watchReplyPublication\(result\.id\);/);
});

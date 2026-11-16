import test from 'node:test';
import assert from 'node:assert/strict';

import { runPageScript } from './page-script.js';

function setup() {
  const calls = [];
  const frames = [];
  const feed = { scrollTop: 100, clientHeight: 600, scrollHeight: 1200 };
  const container = {
    innerHTML: '', append(button) { this.retry = button; },
    insertAdjacentHTML(_where, html) { this.innerHTML += html; }
  };
  const document = {
    createElement() { return {}; },
    getElementById(id) { return id === 'messageContainer' ? container : id === 'messageFeed' ? feed : null; },
    querySelector(selector) {
      if (selector === '.feed-retry' && container.retry) return {remove() { delete container.retry; }};
      if (selector === '.list-loading-tip' && container.innerHTML.includes('list-loading-tip')) {
        return { remove() { container.innerHTML = container.innerHTML.replace('<div class="loading list-loading-tip">加载更多...</div>', ''); } };
      }
      return null;
    }
  };
  const RootedVoxPublicData = { listMessages(options) { return new Promise((resolve, reject) => calls.push({ options, resolve, reject })); } };
  const { loadMainMessages } = runPageScript('messages.js', {
    document, AbortController, requestAnimationFrame: callback => frames.push(callback), window: { RootedVoxPublicData }, RootedVoxPublicData,
    ForumUI: { parseMessageContent: () => ({ zone: '校园生活', text: '留言' }), escapeHtml: value => value || '', renderMessageAvatars() {} }
  }, { replace: { showNoMoreTip() {} }, expose: ['loadMainMessages'] });
  const context = { load: loadMainMessages };
  return { calls, container, feed, frames, load: context.load };
}
const item = { id: '1', username: '测试', content: '留言', created_at: '2026-01-01', pic_url: [] };

test('a scroll cannot replace an in-flight first page', async () => {
  const h = setup();
  const first = h.load();
  await h.load(true);
  assert.equal(h.calls.length, 1);
  h.calls[0].resolve({ messages: [item], hasMore: true });
  await first;
  assert.doesNotMatch(h.container.innerHTML, /加载留言中/);
  assert.match(h.container.innerHTML, /message-1/);
});

test('an aborted old request cannot unlock the current request', async () => {
  const h = setup();
  const old = h.load();
  const current = h.load();
  h.calls[0].resolve({ messages: [item], hasMore: true });
  await old;
  await h.load(true);
  assert.equal(h.calls.length, 2);
  h.calls[1].resolve({ messages: [item], hasMore: true });
  await current;
  assert.doesNotMatch(h.container.innerHTML, /加载留言中/);
});

test('a failed load-more request keeps the list and retries the same cursor', async () => {
  const h = setup();
  const first = h.load();
  h.calls[0].resolve({ messages: [item], hasMore: true, nextCursor: 'next-20' });
  await first;
  const more = h.load(true);
  h.calls[1].reject(new Error('offline'));
  await more;
  assert.doesNotMatch(h.container.innerHTML, /加载更多/);
  assert.match(h.container.innerHTML, /message-1/);
  const retry = h.container.retry.onclick();
  assert.equal(h.calls[2].options.cursor, 'next-20');
  h.calls[2].resolve({messages: [{...item, id: '2'}], hasMore: false});
  await retry;
  assert.equal(h.container.innerHTML.match(/id="message-1"/g).length, 1);
  assert.match(h.container.innerHTML, /id="message-2"/);
});


test('first-page loads reset the feed and fill a short viewport', async () => {
  const h = setup();
  h.feed.scrollHeight = 100;
  const first = h.load();
  assert.equal(h.feed.scrollTop, 0);
  h.calls[0].resolve({ messages: [item], hasMore: true });
  await first;
  assert.equal(h.frames.length, 1);
  h.frames.shift()();
  assert.equal(h.calls.length, 2);
  h.calls[1].resolve({ messages: [item], hasMore: false });
  await new Promise(resolve => setImmediate(resolve));
  assert.doesNotMatch(h.container.innerHTML, /加载更多/);
});

test('a replaced request cannot auto-load another page from its old frame', async () => {
  const h = setup();
  h.feed.scrollHeight = 100;
  const first = h.load();
  h.calls[0].resolve({ messages: [item], hasMore: true });
  await first;
  const current = h.load();
  h.frames.shift()();
  assert.equal(h.calls.length, 2);
  h.calls[1].resolve({ messages: [item], hasMore: false });
  await current;
});

test('returning to a post loads its saved pages and focuses the original card', async () => {
  const pages = [], frames = [];
  let focused = false, scrolled = false;
  const card = {
    scrollIntoView() { scrolled = true; },
    querySelector() { return { focus() { focused = true; } }; }
  };
  const container = { innerHTML: '', insertAdjacentHTML(_where, html) { this.innerHTML += html; } };
  const feed = { clientHeight: 100, scrollHeight: 800 };
  const api = { async listMessages(options) {
    pages.push(options.page);
    return { messages: [{ ...item, id: String(options.page + 1) }], hasMore: true, nextCursor: 'more' };
  } };
  const page = runPageScript('messages.js', {
    AbortController, RootedVoxPublicData: api, window: { RootedVoxPublicData: api },
    requestAnimationFrame: fn => frames.push(fn),
    ForumUI: { parseMessageContent: () => ({ zone: '', text: '' }), escapeHtml: String, renderMessageAvatars() {} },
    document: { querySelector() { return null; }, getElementById(id) {
      if (id === 'messageContainer') return container;
      if (id === 'messageFeed') return feed;
      if (id === 'message-2' && container.innerHTML.includes('id="message-2"')) return card;
      return null;
    } }
  }, { replace: { restorePosition: { id: '2', pages: 2 } }, expose: ['loadMainMessages'] });
  await page.loadMainMessages();
  assert.equal(scrolled, false);
  frames.shift()();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(pages, [0, 1]);
  assert.ok(scrolled && focused);
});

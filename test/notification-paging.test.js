import test from 'node:test';
import assert from 'node:assert/strict';
import { runPageScript } from './page-script.js';

function setup(receipt = new Response(null, { status: 503 })) {
  const frames = [], cursors = [], responses = [];
  const list = {
    scrollTop: 0, clientHeight: 500, scrollHeight: 500,
    querySelector() { return null; }, appendChild() {}
  };
  const modal = { style: { display: 'flex' } }, retry = {};
  const elements = { notificationList: list, notificationModal: modal, notificationRetry: retry };
  const page = runPageScript('messages.js', {
    ForumUI: { escapeHtml: String },
    document: {
      getElementById: id => elements[id],
      createElement: () => ({}), createDocumentFragment: () => ({ appendChild() {} })
    },
    requestAnimationFrame: cb => frames.push(cb),
    request: async (url, options) => {
      if (options.method === 'PATCH') return receipt;
      cursors.push(new URL(url, 'https://forum.test').searchParams.get('cursor'));
      return responses.shift();
    }
  }, { replace: { showModal() {} }, expose: ['openNotifications', 'loadMoreNotificationsIfNeeded'] });
  return { page, list, modal, retry, frames, cursors, responses };
}

const batch = nextCursor => Response.json({
  notifications: [{id: 10, title: '通知', content: '内容'}], hasMore: Boolean(nextCursor), nextCursor
});

test('a short notification list fills without scrolling and stops at the last page', async () => {
  const h = setup();
  h.responses.push(batch('next'), batch(null));
  await h.page.openNotifications();
  await h.frames.shift()();
  assert.deepEqual(h.cursors, ['', 'next']);
  assert.equal(h.frames.length, 0);
});

test('pagination respects dialog visibility, scroll position and manual retry', async () => {
  const h = setup();
  h.responses.push(batch('next'), new Response(null, { status: 503 }), batch(null));
  await h.page.openNotifications();
  h.modal.style.display = 'none';
  await h.frames.shift()();
  h.modal.style.display = 'flex';
  h.list.scrollHeight = 1400;
  await h.page.loadMoreNotificationsIfNeeded();
  assert.deepEqual(h.cursors, ['']);
  h.list.scrollTop = 900;
  await h.page.loadMoreNotificationsIfNeeded();
  assert.equal(h.retry.hidden, false);
  await h.page.loadMoreNotificationsIfNeeded();
  assert.deepEqual(h.cursors, ['', 'next']);
  await h.retry.onclick();
  assert.deepEqual(h.cursors, ['', 'next', 'next']);
  assert.equal(h.frames.length, 0);
});

test('scrolling to the bottom while the read receipt is pending still loads the next page', async () => {
  const receipt = Promise.withResolvers();
  const h = setup(receipt.promise);
  h.responses.push(batch('next'), batch(null));
  h.list.scrollHeight = 1400;
  const first = h.page.openNotifications();
  await new Promise(resolve => setImmediate(resolve));
  h.list.scrollTop = 900;
  await h.page.loadMoreNotificationsIfNeeded();
  assert.deepEqual(h.cursors, ['']);
  receipt.resolve(new Response(null, { status: 503 }));
  await first;
  await h.frames.shift()();
  assert.deepEqual(h.cursors, ['', 'next']);
});

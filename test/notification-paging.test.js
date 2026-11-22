import test from 'node:test';
import assert from 'node:assert/strict';
import { runPageScript } from './page-script.js';

function setup(receipt = new Response(null, { status: 503 })) {
  const frames = [], cursors = [], responses = [], receipts = [], probes = [];
  const dot = { style: {} }, menuDot = { style: {} };
  const list = {
    scrollTop: 0, clientHeight: 500, scrollHeight: 500,
    querySelector() { return null; }, querySelectorAll: () => [], appendChild() {}
  };
  const modal = { style: { display: 'flex' } }, retry = {};
  const elements = { notificationList: list, notificationModal: modal, notificationRetry: retry };
  const page = runPageScript('messages.js', {
    notificationDot: dot, dropdownDot: menuDot,
    ForumUI: { escapeHtml: String },
    document: {
      getElementById: id => elements[id],
      createElement: () => ({}), createDocumentFragment: () => ({ appendChild() {} })
    },
    requestAnimationFrame: cb => frames.push(cb),
    request: async (url, options) => {
      if (url.includes('exists=1')) return probes.shift();
      if (options.method === 'PATCH') {
        receipts.push(new URL(url, 'https://forum.test').searchParams.get('through'));
        return receipt;
      }
      cursors.push(new URL(url, 'https://forum.test').searchParams.get('cursor'));
      return responses.shift();
    }
  }, { replace: { userId: 'user', showModal() {} }, expose: ['refreshNotificationDot', 'openNotifications', 'loadMoreNotificationsIfNeeded'] });
  return { page, list, modal, retry, frames, cursors, responses, receipts, probes, dot, menuDot };
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

test('a list response arriving after close never marks unseen notifications read', async () => {
  const h = setup();
  const pending = Promise.withResolvers();
  h.responses.push(pending.promise);
  const first = h.page.openNotifications();
  h.modal.style.display = 'none';
  pending.resolve(batch('old'));
  await first;
  assert.deepEqual(h.receipts, []);
  assert.equal(h.frames.length, 0);
});

test('reopening refreshes page one while a stale page is still in flight', async () => {
  for (const stale of [batch('old'), new Response(null, { status: 503 })]) {
    const h = setup();
    const pending = Promise.withResolvers();
    const current = Promise.withResolvers();
    h.responses.push(batch('page2'), pending.promise, current.promise, batch(null));
    await h.page.openNotifications();
    const oldPage = h.frames.shift()();
    h.modal.style.display = 'none';
    h.modal.style.display = 'flex';
    const reopened = h.page.openNotifications();
    pending.resolve(stale);
    await oldPage;
    assert.deepEqual(h.cursors, ['', 'page2', '']);
    await h.page.loadMoreNotificationsIfNeeded();
    assert.deepEqual(h.cursors, ['', 'page2', '']);
    assert.equal(h.retry.hidden, true);
    assert.equal(h.frames.length, 0);
    current.resolve(batch('current'));
    await reopened;
    await h.frames.shift()();
    assert.deepEqual(h.cursors, ['', 'page2', '', 'current']);
  }
});

test('a late unread probe cannot relight the dots after the notifications were read', async () => {
  const h = setup(Response.json({ hasUnread: false }));
  const old = Promise.withResolvers();
  h.probes.push(old.promise);
  const probing = h.page.refreshNotificationDot();
  h.responses.push(batch(null));
  await h.page.openNotifications();
  old.resolve(Response.json({ hasUnread: true }));
  await probing;
  assert.equal(h.dot.style.display, 'none');
  assert.equal(h.menuDot.style.display, 'none');
});

test('out-of-order unread probes keep the latest result', async () => {
  const h = setup();
  const old = Promise.withResolvers();
  h.probes.push(old.promise, Response.json({ hasUnread: true }));
  const probing = h.page.refreshNotificationDot();
  await h.page.refreshNotificationDot();
  old.resolve(Response.json({ hasUnread: false }));
  await probing;
  assert.equal(h.dot.style.display, 'block');
  assert.equal(h.menuDot.style.display, 'inline-block');
});

test('a probe overlapping the read receipt is reconciled with a fresh unread lookup', async () => {
  const receipt = Promise.withResolvers();
  const h = setup(receipt.promise);
  h.responses.push(batch(null));
  const opened = h.page.openNotifications();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(h.receipts, ['10']);
  h.probes.push(Response.json({ hasUnread: false }), Response.json({ hasUnread: true }));
  await h.page.refreshNotificationDot();
  receipt.resolve(Response.json({ hasUnread: false }));
  await opened;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.dot.style.display, 'block');
  assert.equal(h.probes.length, 0);
});

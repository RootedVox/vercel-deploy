import test from 'node:test';
import assert from 'node:assert/strict';
import { runPageScript } from './page-script.js';

// notificationStyle maps the fixed database notification titles to a glyph,
// a status pill and a negative/featured flag. In particular the featured
// approval title must not fall through to the generic "通知" pill.
const { notificationStyle } = runPageScript('messages.js', {}, { expose: ['notificationStyle'] });

test('featured approval gets its own star icon and pill', () => {
  const style = notificationStyle({ title: '精华投稿已发表' });
  assert.equal(style.icon, '★');
  assert.equal(style.pill, '精华');
  assert.equal(style.featured, true);
  assert.equal(style.negative, false);
});

test('ordinary approval stays distinct from featured', () => {
  const style = notificationStyle({ title: '留言审核通过' });
  assert.equal(style.icon, '✓');
  assert.equal(style.pill, '已公开');
  assert.notEqual(style.featured, true);
});

test('rejection is still flagged negative', () => {
  const style = notificationStyle({ title: '留言未通过审核' });
  assert.equal(style.icon, '×');
  assert.equal(style.negative, true);
});

test('a post handed over to a human gets the amber pending style, not a rejection', () => {
  const style = notificationStyle({ title: '留言转为人工审核' });
  assert.equal(style.icon, '✎');
  assert.equal(style.pill, '人工复核');
  assert.equal(style.pending, true);
  // Must not be painted as an error: the post is still queued, not refused.
  assert.notEqual(style.negative, true);
  assert.notEqual(style.featured, true);
});

test('unknown title falls back to generic notice', () => {
  const style = notificationStyle({ title: '某条新通知' });
  assert.equal(style.icon, '•');
  assert.equal(style.pill, '通知');
  assert.notEqual(style.featured, true);
});

test('reply notifications preserve the sender and excerpt while status pills stay translatable', async () => {
  const rows = [];
  const reply = { type: 'reply', title: '回复 @同学 回复了你', content: '活动社团' };
  const audit = { type: 'audit', title: '留言审核通过', content: '你的留言、评论或回复已审核通过并公开显示' };
  const list = { querySelector: () => null, appendChild() {} };
  const { openNotifications } = runPageScript('messages.js', {
    ForumUI: { escapeHtml: value => value },
    document: {
      getElementById: id => id === 'notificationList' ? list : {},
      createElement: () => ({}),
      createDocumentFragment: () => ({ appendChild: row => rows.push(row) })
    },
    request: async () => Response.json({ notifications: [reply, audit] })
  }, { replace: { showModal() {} }, expose: ['openNotifications'] });
  await openNotifications(true);
  assert.equal(rows.length, 2);
  assert.match(rows[0].innerHTML, /<h4 class="notification-content">回复 @同学 回复了你<\/h4>/);
  assert.match(rows[0].innerHTML, /<p class="notification-content">活动社团<\/p>/);
  assert.match(rows[0].innerHTML, /<span class="item-pill">新回复<\/span>/);
  assert.doesNotMatch(rows[1].innerHTML, /class="notification-content"/);
});

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

test('unknown title falls back to generic notice', () => {
  const style = notificationStyle({ title: '某条新通知' });
  assert.equal(style.icon, '•');
  assert.equal(style.pill, '通知');
  assert.notEqual(style.featured, true);
});

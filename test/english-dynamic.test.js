import test from 'node:test';
import assert from 'node:assert/strict';
import { runPageScript } from './page-script.js';

// english.js must be evaluable as a plain browser script and expose every
// runtime-generated UI string. preferences.js translates new nodes through a
// MutationObserver, but a string missing from the map is never translated.
function loadMap() {
  const window = {};
  runPageScript('english.js', { window });
  return window.rvEnglish;
}

test('english.js defines a non-empty translation map', () => {
  const map = loadMap();
  // The map is built inside a vm context, so instanceof against the host Map
  // would fail; check the Map interface instead.
  assert.equal(typeof map?.get, 'function');
  assert.equal(typeof map?.has, 'function');
  assert.ok(map.size > 100);
});

test('notification pills, publish toasts and form states are translated', () => {
  const map = loadMap();
  const required = [
    // notification status pills
    '新回复', '人工复核', '审核中', '已公开', '未通过', '通知', '已删除',
    // automatic publish toasts
    '你的留言已通过审核并公开。', '你的回复已通过审核并公开。',
    // compose / upload states
    '请先写下留言内容。', '发布中...', '正在上传并提交…',
    '发布成功，审核结果会通过站内通知告知你。'
  ];
  for (const key of required) {
    assert.ok(map.has(key), `missing English translation: ${key}`);
    assert.ok(String(map.get(key)).length > 0, `empty translation: ${key}`);
  }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { runPageScript } from './page-script.js';

test('a failed canvas allocation rejects the upload and releases the preview URL', async () => {
  const window = {};
  const released = [];
  class Image {
    width = 1024;
    height = 768;
    set src(value) { queueMicrotask(() => this.onload()); }
  }
  runPageScript('forum-ui.js', {
    window, Image, FormData,
    URL: { createObjectURL: () => 'blob:photo', revokeObjectURL: url => released.push(url) },
    document: { createElement: () => ({ getContext: () => null }) }
  });
  await assert.rejects(window.ForumUI.uploadFiles([new File([new Uint8Array(150000)], 'photo.png', { type: 'image/png' })]), /图片压缩失败/);
  assert.deepEqual(released, ['blob:photo']);
});

test('an expired draft retries local files and leaves restored URLs available for removal', async () => {
  const window = {};
  let sends = 0;
  runPageScript('forum-ui.js', { window, FormData, request: async () => Response.json({ urls: ['url' + ++sends] }) });
  const file = new File(['data'], 'test.png', { type: 'image/png' });
  const [url] = await window.ForumUI.uploadFiles([file]);
  const local = { file, url }, restored = { url: 'restored' };
  window.ForumUI.recoverDraftImages([local, restored]);
  assert.equal(local.url, undefined);
  assert.equal(restored.needsReplacement, true);
  assert.equal(restored.url, 'restored');
  assert.deepEqual([...await window.ForumUI.uploadFiles([file])], ['url2']);
});

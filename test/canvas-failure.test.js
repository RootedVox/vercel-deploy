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
  await assert.rejects(window.ForumUI.uploadFiles([{ type: 'image/png', size: 150000 }]), /图片压缩失败/);
  assert.deepEqual(released, ['blob:photo']);
});

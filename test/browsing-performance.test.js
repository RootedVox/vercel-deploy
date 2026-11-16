import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

import { runPageScript } from './page-script.js';

test('new picture selections keep order and release old previews without allocating invalid selections', () => {
  const allocated = [], revoked = [], images = [];
  const container = {
    replaceChildren() { images.length = 0; },
    appendChild(fragment) { images.push(...fragment.items); }
  };
  const page = runPageScript('messages.js', {
    URL: { createObjectURL(file) { allocated.push(file); return 'blob:' + allocated.length; }, revokeObjectURL(url) { revoked.push(url); } },
    document: {
      getElementById() { return container; }, createElement() { return {}; },
      createDocumentFragment() { return { items: [], appendChild(img) { this.items.push(img); } }; }
    }
  }, { replace: { showFormStatus() {} }, expose: ['previewImages', 'clearImagePreviews'] });
  const context = { preview: page.previewImages, clear: page.clearImagePreviews };
  const image = name => ({ name, type: 'image/png', size: 1024 });
  context.preview({ files: [image('first.png'), image('second.png')] });
  assert.deepEqual(images.map(img => img.alt), ['first.png', 'second.png']);
  context.preview({ files: [image('replacement.png')] });
  assert.deepEqual(revoked, ['blob:1', 'blob:2']);
  assert.equal(images.length, 1);
  const invalid = { files: [image('good.png'), { name: 'large.png', type: 'image/png', size: 6 * 1024 * 1024 }], value: 'selection' };
  context.preview(invalid);
  assert.equal(invalid.value, '');
  assert.equal(allocated.length, 3, 'a rejected selection must allocate no previews');
  assert.deepEqual(revoked, ['blob:1', 'blob:2', 'blob:3']);
  context.clear();
  assert.equal(revoked.length, 3, 'cleanup is idempotent');
});

test('loading more messages preserves existing avatar elements and updates changed avatars', async () => {
  let writes = 0;
  const box = { dataset: {}, style: { removeProperty() {} }, set innerHTML(value) { writes++; this.html = value; } };
  const item = { dataset: { avatarUrl: 'https://db.example/avatar.png', anonymous: 'false' }, querySelector(selector) { return selector === '.message-avatar-box' ? box : { textContent: '用户' }; } };
  const context = vm.createContext({
    window: {}, document: { querySelectorAll() { return [item]; } }
  });
  vm.runInContext(readFileSync(new URL('../forum-ui.js', import.meta.url), 'utf8'), context);
  const { renderMessageAvatars: render, getFreshAvatar: fresh } = context.window.ForumUI;
  await render(); await render();
  assert.equal(writes, 1, 'existing avatar DOM must survive pagination');
  const hashed = 'https://db.example/avatar.' + 'a'.repeat(64) + '.webp';
  assert.equal(fresh(hashed), hashed);
  assert.equal(fresh(item.dataset.avatarUrl), fresh(item.dataset.avatarUrl));
  item.dataset.avatarUrl = hashed;
  await render();
  assert.equal(writes, 2);
  assert.ok(box.html.includes(hashed));
});

test('a slow or failed footer does not delay navigation initialization', async () => {
  const source = readFileSync(new URL('../common.js', import.meta.url), 'utf8');
  let finishFooter, headerInitializations = 0;
  const context = vm.createContext({
    document: {
      querySelector() { return {}; },
      getElementById(id) { if (id === 'siteHeader') headerInitializations++; return null; }
    },
    fetch: async path => path.includes('footer') ? new Promise(resolve => { finishFooter = resolve; }) : { ok: true, text: async () => '<header></header>' },
    console: { error() {} }
  });
  vm.runInContext(source, context);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(headerInitializations, 1, 'header initializes before footer finishes');
  finishFooter({ ok: false });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(headerInitializations, 1);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

import { runPageScript } from './page-script.js';

test('post pictures append in order, reject individual files and release only removed previews', () => {
  const revoked = [], errors = [];
  function node() {
    return { children: [], setAttribute() {}, append(...items) { this.children.push(...items); },
      replaceChildren() { this.children = []; }, remove() { container.children.splice(container.children.indexOf(this), 1); } };
  }
  const container = node();
  const page = runPageScript('messages.js', {
    URL: { createObjectURL: file => 'blob:' + file.name, revokeObjectURL: url => revoked.push(url) },
    document: { getElementById: () => container, createElement: node }
  }, { replace: { showFormStatus: message => errors.push(message), saveImageDraft() {} },
    expose: ['previewImages', 'addImagePreview', 'clearImagePreviews'] });
  const image = name => ({ name, type: 'image/png', size: 1024 });
  const labels = () => container.children.map(item => item.children[0].alt);
  page.addImagePreview({ url: 'stored', preview: 'stored' });
  page.previewImages({ files: [image('A'), image('B')] });
  const picker = { files: [image('C'), { ...image('large'), size: 6000000 }, image('D'), image('excess')] };
  page.previewImages(picker);
  assert.equal(picker.value, '');
  assert.deepEqual(labels(), ['已上传的图片', 'A', 'B', 'C', 'D']);
  assert.match(errors.at(-1), /large.*excess/);
  container.children[2].children[1].onclick();
  assert.deepEqual(revoked, ['blob:B']);
  page.previewImages({ files: [image('E')] });
  assert.deepEqual(labels(), ['已上传的图片', 'A', 'C', 'D', 'E']);
  page.clearImagePreviews();
  page.clearImagePreviews();
  assert.deepEqual(revoked, ['blob:B', 'blob:A', 'blob:C', 'blob:D', 'blob:E']);
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

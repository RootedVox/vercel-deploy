import assert from 'node:assert/strict';
import test from 'node:test';
import { runPageScript } from './page-script.js';

// Each quota read is a Functions request (daily quota), so opening the forum must not
// ask for it: only ticking "投稿到精华", or a restored draft that has it ticked, does.
function postForm(draft = null) {
  const elements = new Map();
  const element = id => {
    if (!elements.has(id)) {
      elements.set(id, { id, value: '', textContent: '', hidden: false, checked: false, style: {},
        listeners: {}, addEventListener(type, fn) { this.listeners[type] = fn; } });
    }
    return elements.get(id);
  };
  const requests = [];
  const { initPostDraft } = runPageScript('messages.js', {
    ForumUI: {},
    ForumDrafts: { bind() {}, get: () => draft, save() {}, clear() {} },
    document: { getElementById: element, addEventListener() {} },
    request: async path => { requests.push(path); return Response.json({ remaining: 2 }); }
  }, {
    replace: { showFormStatus: () => {}, setComposeOpen: () => {}, addImagePreview: () => {}, clearImagePreviews: () => {} },
    expose: ['initPostDraft']
  });
  return { initPostDraft, element, requests };
}

const settle = () => new Promise(resolve => setTimeout(resolve, 0));

test('opening the post form does not ask for the featured quota', async () => {
  const form = postForm();
  form.initPostDraft();
  await settle();
  assert.deepEqual(form.requests, []);
});

test('ticking 投稿到精华 asks for the quota once and shows it', async () => {
  const form = postForm();
  form.initPostDraft();
  const box = form.element('postFeatured');
  box.checked = true;
  box.listeners.change();
  box.checked = false; box.listeners.change();
  box.checked = true; box.listeners.change();
  await settle();
  assert.deepEqual(form.requests, ['/api/messages?featuredQuota=1']);
  assert.match(form.element('featuredQuota').textContent, /今日还可投稿 2 次/);
  box.checked = false; box.listeners.change();
  box.checked = true; box.listeners.change();
  await settle();
  assert.equal(form.requests.length, 1);
});

test('a restored draft with 投稿到精华 ticked shows the quota', async () => {
  const form = postForm({ text: '草稿', zone: '学习互助', featured: true });
  form.initPostDraft();
  await settle();
  assert.deepEqual(form.requests, ['/api/messages?featuredQuota=1']);
});

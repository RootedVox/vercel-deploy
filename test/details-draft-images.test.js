import test from 'node:test';
import assert from 'node:assert/strict';
import { runPageScript } from './page-script.js';

// Regression: restoring a draft with already-uploaded images and then picking one
// more file used to clear the draft's attachments and drop the old images on submit.
test('picking a new image keeps images restored from the draft', async () => {
  const drafts = new Map();
  const draft = {
    bind() {}, get: k => drafts.get(k), clear: k => drafts.delete(k),
    save(k, fields) { if (!fields.text && !fields.attachments?.length) return drafts.delete(k);
      drafts.set(k, { ...drafts.get(k), ...fields }); },
    prepare() { return drafts.get('reply-root'); }
  };
  const requests = [];
  const saved = ['https://db.example/old-1.webp', 'https://db.example/old-2.webp'];
  drafts.set('reply-root', { text: 'draft text', anonymous: false, attachments: saved });

  const document = { addEventListener() {} };
  const textarea = { value: 'draft text' };
  const checkbox = { checked: false };
  const preview = { children: [], replaceChildren() { this.children = []; }, appendChild(el) { this.children.push(el); } };
  const input = { files: [], value: '' };
  const elements = {
    'reply-box-root': {
      style: {}, querySelector(sel) {
        if (sel === 'textarea') return textarea;
        if (sel === 'input[type=checkbox]') return checkbox;
        if (sel === '.comment-submit-btn') return { textContent: '' };
        return {};
      },
      querySelectorAll: () => []
    },
    'preview-root': preview, 'imageUpload-root': input, 'anonymous-root': checkbox,
    'replyInput-root': textarea, 'mainCommentInput': textarea
  };
  document.getElementById = id => elements[id] || null;
  document.querySelector = sel => {
    const match = /^#reply-box-([^ ]+) (.+)$/.exec(sel);
    return match ? elements['reply-box-' + match[1]]?.querySelector(match[2]) : null;
  };
  document.querySelectorAll = () => [];
  document.createElement = tag => ({ tag, className: '', style: {}, set src(v) { this._src = v; }, get src() { return this._src; } });

  const api = runPageScript('details.js', {
    document,
    URL: { ...URL, createObjectURL: () => 'blob:new', revokeObjectURL() {} },
    ForumDrafts: draft,
    ForumUI: {
      escapeHtml: s => String(s), parseMessageContent: () => ({}), renderMessageAvatars() {},
      notify() {}, uploadFiles: async files => files.map((_, i) => `https://db.example/new-${i}.webp`)
    },
    RootedVoxAuth: { getSession: async () => ({ authenticated: true, user: { id: 'u1' } }), handleLogin() {} },
    request: async (path, init) => { requests.push({ path, body: JSON.parse(init.body) }); return { ok: true, status: 201 }; }
  }, {
    replace: {
      authReady: Promise.resolve(),
      currentUser: { id: 'u1' },
      mainMsgId: 'root'
    },
    expose: ['previewImages', 'submitComment', 'renderPreviews', 'replyImages', 'closeAllCommentBoxes', 'bindReplyDraft']
  });

  // Reopen a saved reply, reject an oversized file, then add a valid one.
  const box = elements['reply-box-root'];
  api.bindReplyDraft('root', box);
  input.files = [{ type: 'image/png', size: 6 * 1024 * 1024 }];
  api.previewImages('root');
  assert.equal(preview.children.length, 2);
  assert.deepEqual(drafts.get('reply-root').attachments, saved);

  // User picks one more file.
  input.files = [{ file: true, type: 'image/webp', name: 'new.webp' }];
  api.previewImages('root');
  assert.equal(preview.children.length, 3, 'the new image is appended, not replacing the old ones');
  assert.deepEqual(drafts.get('reply-root').attachments, saved, 'draft keeps the uploaded URLs');

  // Changing target rebuilds the editor. The pending file is still available.
  api.closeAllCommentBoxes();
  const otherCancel = {};
  api.bindReplyDraft('other', { querySelector: selector => selector === '.cancel-comment-btn' ? otherCancel : { value: '' } });
  otherCancel.onclick();
  api.bindReplyDraft('root', box);
  assert.equal(preview.children.length, 3);

  // Submit: only the new file is uploaded; both old images stay in the payload.
  await api.submitComment('root', 'main');
  assert.equal(requests.length, 1);
  assert.deepEqual(requests[0].body.imageUrls, [
    'https://db.example/old-1.webp',
    'https://db.example/old-2.webp',
    'https://db.example/new-0.webp'
  ]);
});

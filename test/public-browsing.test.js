import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const messages = readFileSync(new URL('../messages.html', import.meta.url), 'utf8');
const details = readFileSync(new URL('../details.html', import.meta.url), 'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));
function node() {
  return { value: '', textContent: '', innerHTML: '', disabled: false, style: {}, options: [],
    setAttribute() {}, listeners: {}, addEventListener(type, callback) { this.listeners[type] = callback; } };
}

test('public feed and scrolling initialize while authentication is pending; profile failure leaves menus usable', async () => {
  const nodes = new Map();
  const get = id => { if (!nodes.has(id)) nodes.set(id, node()); return nodes.get(id); };
  let initialize, finishAuth, feedCalls = 0, status = '';
  const context = vm.createContext({
    document: { getElementById: get, addEventListener(type, callback) { if (type === 'DOMContentLoaded') initialize = callback; } },
    location: { search: '' }, URLSearchParams,
    initAuth: () => new Promise(resolve => { finishAuth = resolve; }),
    loadMainMessages() { feedCalls++; return new Promise(() => {}); },
    initUserExtra: async () => { throw new Error('offline'); },
    initNicknameSelect() {}, currentUserEmail: 'test@example.invalid',
    showFormStatus(message) { status = message; }, saveProfileNickname() {}, closeProfileModal() {}
  });
  const start = messages.indexOf("        document.addEventListener('DOMContentLoaded'");
  vm.runInContext(messages.slice(start, messages.indexOf("        window.addEventListener('beforeunload'", start)), context);
  const ready = initialize();
  assert.equal(feedCalls, 1);
  assert.equal(typeof get('messageSearch').listeners.input, 'function');
  assert.equal(typeof get('messageFeed').listeners.scroll, 'function');
  assert.equal(get('submitBtn').disabled, true);
  finishAuth(true);
  await ready;
  await tick();
  assert.match(status, /个人资料/);
  assert.equal(typeof get('logoutBtn').onclick, 'function');
  get('avatarBtn').onclick({ stopPropagation() {} });
  assert.equal(get('avatarDropdown').style.display, 'block');
  assert.equal(get('submitBtn').disabled, false);
});

function threadHarness(read) {
  const main = node(), comments = node();
  let renders = 0, jumps = 0, observations = 0, initialize;
  const context = vm.createContext({
    window: { RootedVoxPublicData: {} }, RootedVoxPublicData: { getThread: read },
    document: { getElementById: id => id === 'mainMessageCard' ? main : comments,
      addEventListener(_type, callback) { initialize = callback; } },
    getMsgIdFromUrl: () => '1', location: { replace() {} },
    renderMainMessage() { renders++; main.innerHTML = 'loaded'; },
    loadAllComments() { comments.innerHTML = 'comments'; }, autoJumpFromUrl() { jumps++; },
    observeMoreComments() { observations++; },
    initAuth: () => new Promise(() => {})
  });
  const start = details.indexOf('async function loadMainMessage()');
  vm.runInContext('let mainMsgId, allMessages, authReady;\n' + details.slice(start, details.indexOf('function renderMainMessage(', start)) + '\nglobalThis.retry = retryThread;', context);
  const init = details.indexOf("document.addEventListener('DOMContentLoaded'");
  vm.runInContext(details.slice(init, details.indexOf('</script>', init)), context);
  return { main, comments, retry: context.retry, initialize: () => initialize(), renders: () => renders, jumps: () => jumps, observations: () => observations };
}

test('thread failure ends both loading indicators and retry recovers', async () => {
  let calls = 0;
  const h = threadHarness(async () => { if (++calls === 1) throw new Error('offline'); return [{ id: '1' }]; });
  await h.retry();
  assert.match(h.main.innerHTML, /重试/);
  assert.doesNotMatch(h.comments.innerHTML, /加载评论中/);
  await h.retry();
  assert.equal(h.renders(), 1);
  assert.equal(h.jumps(), 1);
  assert.equal(h.observations(), 1);
});

test('an absent thread stops loading the main post and comments', async () => {
  const h = threadHarness(async () => []);
  await h.retry();
  assert.match(h.main.innerHTML, /不存在/);
  assert.match(h.comments.innerHTML, /暂无/);
  assert.equal(h.jumps(), 0);
});

test('thread content renders without waiting for authentication', async () => {
  const h = threadHarness(async () => [{ id: '1' }]);
  h.initialize();
  await tick();
  assert.equal(h.renders(), 1);
});

function commentHarness(upload = async () => ['https://example.invalid/picture.webp']) {
  const button = { disabled: false, textContent: '发布评论' };
  const input = { value: '保留的评论' }, file = { files: [{}], value: 'picture.png' };
  const alerts = [], writes = [];
  let clears = 0, closes = 0;
  const context = vm.createContext({
    authReady: Promise.resolve(), currentUser: { id: 'test' }, location: { search: '?id=1' },
    document: { querySelector: () => button, getElementById(id) {
      if (id === 'mainCommentInput') return input;
      if (id === 'imageUpload-1') return file;
      if (id === 'preview-1') return { replaceChildren() { clears++; } };
      return null;
    } },
    uploadImages: upload,
    request: () => new Promise((resolve, reject) => writes.push({ resolve, reject })),
    alert(message) { alerts.push(message); }, closeAllCommentBoxes() { closes++; }, loadAllComments() {}
  });
  const start = details.indexOf('let commentSubmitting =');
  vm.runInContext(details.slice(start, details.indexOf('// ==================== 跳转', start)) + '\nglobalThis.submit = submitComment;', context);
  return { button, input, file, writes, alerts, submit: context.submit, clears: () => clears, closes: () => closes };
}

test('double-clicking a comment sends one write; network failure preserves draft and unlocks retry', async () => {
  const h = commentHarness();
  const first = h.submit('1', 'main');
  await h.submit('1', 'main');
  await tick();
  assert.equal(h.writes.length, 1);
  assert.equal(h.button.disabled, true);
  h.writes[0].reject(new Error('offline'));
  await first;
  assert.equal(h.input.value, '保留的评论');
  assert.equal(h.file.value, 'picture.png');
  assert.equal(h.clears(), 0);
  assert.equal(h.button.disabled, false);
  assert.match(h.alerts[0], /发布失败/);
  const retry = h.submit('1', 'main');
  await tick();
  h.writes[1].resolve({ ok: true, status: 201 });
  await retry;
  assert.equal(h.input.value, '');
  assert.equal(h.file.value, '');
  assert.equal(h.clears(), 1);
  assert.equal(h.closes(), 1);
});

test('upload failure reports an error and releases the comment submit button', async () => {
  const h = commentHarness(async () => { throw new Error('upload_failed'); });
  await h.submit('1', 'main');
  assert.equal(h.writes.length, 0);
  assert.equal(h.button.disabled, false);
  assert.equal(h.button.textContent, '发布评论');
  assert.equal(h.input.value, '保留的评论');
  assert.match(h.alerts[0], /发布失败/);
});

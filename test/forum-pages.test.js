import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import vm from 'node:vm';

const root = new URL('../', import.meta.url);
const read = name => readFileSync(new URL(name, root), 'utf8');
const files = readdirSync(root);
const pages = files.filter(name => name.endsWith('.html'));
const scripts = files.filter(name => name.endsWith('.js'));

test('no page relies on inline scripts or on* attributes, which the Content-Security-Policy blocks', () => {
  for (const name of pages) {
    const html = read(name);
    for (const [tag] of html.matchAll(/<script\b[^>]*>/g)) {
      assert.ok(/\ssrc=/.test(tag) || /type="application\/ld\+json"/.test(tag), `${name}: ${tag}`);
    }
    assert.doesNotMatch(html, /<[^>]+\son[a-z]+\s*=/i, name);
    assert.doesNotMatch(html, /javascript:/i, name);
  }
  // Markup built in scripts is subject to the same rule.
  for (const name of scripts) assert.doesNotMatch(read(name), /<[^>`]+\son[a-z]+=\\?["']/i, name);
});

test('both deployments send a policy that only runs same-origin scripts', () => {
  const policy = read('_headers').match(/^  Content-Security-Policy: (.+)$/m)[1];
  const directives = Object.fromEntries(policy.split(';').map(part => {
    const [name, ...values] = part.trim().split(/\s+/);
    return [name, values];
  }));
  assert.deepEqual(directives['script-src'], ["'self'"]);
  assert.deepEqual(directives['default-src'], ["'self'"]);
  assert.deepEqual(directives['object-src'], ["'none'"]);
  assert.deepEqual(directives['frame-ancestors'], ["'none'"]);
  assert.deepEqual(directives['base-uri'], ["'self'"]);
  // The failover client calls the paired deployment directly.
  for (const peer of ['https://rv.celestivast.com', 'https://rv-vc.celestivast.com']) {
    assert.ok(directives['connect-src'].includes(peer), peer);
  }
});

test('every browser script is syntax-checked by npm run check', () => {
  const check = JSON.parse(read('package.json')).scripts.check;
  for (const name of scripts) assert.ok(check.includes(`node --check ${name}`), name);
});

test('the forum pages load their own stylesheet and script as cacheable files', () => {
  for (const name of ['messages', 'details']) {
    const html = read(`${name}.html`);
    assert.match(html, new RegExp(`<link rel="stylesheet" href="\\./${name}\\.css">`));
    assert.match(html, new RegExp(`<script src="\\./${name}\\.js"></script>`));
    assert.doesNotMatch(html, /<style/);
  }
});

function feed(overflowY, { bottom = 0, clientHeight = 600, scrollHeight = 1200 } = {}) {
  const page = read('messages.js');
  const loader = page.slice(page.indexOf('        async function loadMainMessages('), page.indexOf('        function showNoMoreTip()'));
  const calls = [], frames = [];
  const box = { scrollTop: 0, clientHeight, scrollHeight, getBoundingClientRect: () => ({ bottom }) };
  const container = { innerHTML: '', append() {}, insertAdjacentHTML(_where, html) { this.innerHTML += html; } };
  const context = vm.createContext({
    document: {
      createElement: () => ({}), querySelector: () => null,
      getElementById: id => id === 'messageContainer' ? container : id === 'messageFeed' ? box : null
    },
    AbortController, requestAnimationFrame: callback => frames.push(callback),
    getComputedStyle: () => ({ overflowY }),
    window: { innerHeight: 800, RootedVoxPublicData: {} },
    RootedVoxPublicData: { listMessages: options => new Promise(resolve => calls.push({ options, resolve })) },
    parseMessageContent: () => ({ zone: '日常分享', text: '留言' }),
    escapeHtml: value => value || '', renderMessageAvatars() {}, showNoMoreTip() {}
  });
  vm.runInContext(`let currentPage=0, PAGE_SIZE=20, hasMore=true, isLoadingMore=false, abortController=null, activeSearch='', activeSort='newest', activeZone='all', feedCursor=null;\n${loader}\nglobalThis.load=loadMainMessages;`, context);
  return { calls, frames, container, load: context.load };
}
const post = { id: '1', username: '测试', content: '留言', created_at: '2026-01-01T00:00:00Z', pic_url: ['https://db.example/a.webp'] };

test('a feed that scrolls with the page loads the next page only while its end is on screen', async () => {
  for (const [bottom, expected] of [[500, 2], [2400, 1]]) {
    const h = feed('visible', { bottom });
    const first = h.load();
    h.calls[0].resolve({ messages: [post], hasMore: true, nextCursor: 'next' });
    await first;
    h.frames.forEach(frame => frame());
    assert.equal(h.calls.length, expected, `bottom=${bottom}`);
  }
});

test('a feed in its own scroll box still fills a short first page', async () => {
  for (const [scrollHeight, expected] of [[400, 2], [1200, 1]]) {
    const h = feed('auto', { bottom: 5000, scrollHeight });
    const first = h.load();
    h.calls[0].resolve({ messages: [post], hasMore: true, nextCursor: 'next' });
    await first;
    h.frames.forEach(frame => frame());
    assert.equal(h.calls.length, expected, `scrollHeight=${scrollHeight}`);
  }
});

test('posts link to their thread and thumbnails are keyboard-reachable viewer targets', async () => {
  const h = feed('auto');
  const first = h.load();
  h.calls[0].resolve({ messages: [post], hasMore: false });
  await first;
  assert.match(h.container.innerHTML, /<a class="detail-btn" href="details\.html\?id=1">/);
  assert.match(h.container.innerHTML, /<img src="https:\/\/db\.example\/a\.webp" class="message-image" alt="测试 发布的图片" loading="lazy" tabindex="0">/);
  assert.match(h.container.innerHTML, /2026\/1\/1 \d{2}:\d{2}</);
});

test('the image viewer opens the clicked thumbnail in a dialog and closes on click', () => {
  const listeners = {}, appended = [];
  const element = tag => ({
    tag, children: [], listeners: {}, open: false,
    setAttribute() {}, append(...nodes) { this.children.push(...nodes); },
    addEventListener(type, callback) { this.listeners[type] = callback; },
    querySelector(name) { return this.children.find(child => child.tag === name); },
    showModal() { this.open = true; }, close() { this.open = false; }
  });
  const document = {
    createElement: element, body: { append: node => appended.push(node) },
    addEventListener(type, callback) { listeners[type] = callback; }, querySelectorAll: () => []
  };
  const window = {};
  vm.runInNewContext(read('forum-ui.js'), { window, document, Date });
  const thumbnail = { src: 'https://db.example/a.webp', alt: '图片', closest: selector => selector === 'img.message-image' ? thumbnail : null };
  listeners.click({ target: { closest: () => null } });
  assert.equal(appended.length, 0);
  listeners.click({ target: thumbnail });
  listeners.click({ target: thumbnail });
  assert.equal(appended.length, 1);
  const [dialog] = appended;
  assert.equal(dialog.open, true);
  assert.equal(dialog.querySelector('img').src, thumbnail.src);
  assert.equal(dialog.querySelector('img').alt, '图片');
  dialog.listeners.click();
  assert.equal(dialog.open, false);
});

test('the compose form is foldable on phones and guests get a sign-in button', () => {
  const html = read('messages.html');
  assert.match(html, /<button type="button" class="compose-toggle" id="composeToggle" aria-expanded="false" aria-controls="composeFields">/);
  const css = read('messages.css');
  const phone = css.slice(css.lastIndexOf('@media (max-width: 768px)'));
  assert.match(phone, /\.compose-toggle:not\(\[aria-expanded="true"\]\) \+ \.compose-fields \{ display:none; \}/);
  assert.match(phone, /\.message-feed \{ overflow:visible;/);
  // Outside the phone layout the toggle is hidden, so the form is always open.
  assert.match(css.slice(0, css.lastIndexOf('@media (max-width: 768px)')), /\.compose-toggle \{ display:none;/);
});

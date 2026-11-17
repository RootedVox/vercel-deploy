import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { runPageScript } from './page-script.js';

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

test('both deployments send a policy that only runs same-origin scripts and the Cloudflare analytics beacon', () => {
  const policy = read('_headers').match(/^  Content-Security-Policy: (.+)$/m)[1];
  const directives = Object.fromEntries(policy.split(';').map(part => {
    const [name, ...values] = part.trim().split(/\s+/);
    return [name, values];
  }));
  // WebAssembly for the avatar WebP encoder; JavaScript eval stays blocked.
  // Cloudflare Web Analytics injects its beacon from static.cloudflareinsights.com.
  assert.deepEqual(directives['script-src'], ["'self'", "'wasm-unsafe-eval'", 'https://static.cloudflareinsights.com']);
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
  // scripts/check-syntax.mjs finds every .js/.mjs itself, apart from the folders it skips.
  assert.equal(JSON.parse(read('package.json')).scripts.check, 'node scripts/check-syntax.mjs');
  const skipped = read('scripts/check-syntax.mjs').match(/const skipped = new Set\(\[(.*)\]\)/)[1];
  for (const name of scripts) {
    assert.ok(!skipped.includes(`'${name.split('/')[0]}'`), name);
  }
});

test('the forum pages load their own stylesheet and script as cacheable files', () => {
  for (const name of ['messages', 'details']) {
    const html = read(`${name}.html`);
    assert.match(html, new RegExp(`<link rel="stylesheet" href="\\./${name}\\.css\\?v=[0-9a-f]{10}">`));
    assert.match(html, new RegExp(`<script src="\\./${name}\\.js\\?v=[0-9a-f]{10}"></script>`));
    assert.doesNotMatch(html, /<style/);
  }
});

function feed(overflowY, { bottom = 0, clientHeight = 600, scrollHeight = 1200 } = {}) {
  const calls = [], frames = [];
  const box = { scrollTop: 0, clientHeight, scrollHeight, getBoundingClientRect: () => ({ bottom }) };
  const container = { innerHTML: '', append() {}, insertAdjacentHTML(_where, html) { this.innerHTML += html; } };
  const { loadMainMessages } = runPageScript('messages.js', {
    document: {
      createElement: () => ({}), querySelector: () => null,
      getElementById: id => id === 'messageContainer' ? container : id === 'messageFeed' ? box : null
    },
    AbortController, requestAnimationFrame: callback => frames.push(callback),
    getComputedStyle: () => ({ overflowY }),
    window: { innerHeight: 800, RootedVoxPublicData: {} },
    RootedVoxPublicData: { listMessages: options => new Promise(resolve => calls.push({ options, resolve })) },
    ForumUI: { parseMessageContent: () => ({ zone: '日常分享', text: '留言' }), escapeHtml: value => value || '', renderMessageAvatars() {} }
  }, { replace: { showNoMoreTip() {} }, expose: ['loadMainMessages'] });
  const context = { load: loadMainMessages };
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
  assert.match(h.container.innerHTML, /<a class="detail-btn comment-link" href="details\.html\?id=1"><span aria-hidden="true">💬<\/span> 查看评论<\/a>/);
  assert.doesNotMatch(h.container.innerHTML, /查看详情/);
  assert.match(h.container.innerHTML, /<img src="https:\/\/db\.example\/a\.webp" class="message-image" alt="测试 发布的图片" loading="lazy" decoding="async" tabindex="0">/);
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

test('every page carries the current shared header and footer', () => {
  // Fails when header.html, header-checker.html or footer.html changed without a sync.
  execFileSync(process.execPath, [fileURLToPath(new URL('scripts/sync-layout.mjs', root)), '--check'], { stdio: 'pipe' });
  for (const name of ['main.html', 'messages.html', 'details.html', 'notice.html']) {
    assert.match(read(name), /<div id="headerBox"><header class="header" id="siteHeader">[\s\S]+<!--\/headerBox--><\/div>/, name);
    assert.match(read(name), /<div id="footerBox"><footer class="footer">[\s\S]+<!--\/footerBox--><\/div>/, name);
  }
  assert.match(read('checker-pending.html'), /<header id="checkHeader"><header class="header">[\s\S]+<!--\/checkHeader--><\/header>/);
});

test('the English table is requested only for English, without a flash of untranslated text', () => {
  for (const name of pages) assert.doesNotMatch(read(name), /english\.js/, name);
  function load(saved) {
    const written = [], appended = [];
    const document = {
      documentElement: { dataset: {} }, addEventListener() {}, write: html => written.push(html),
      createElement: () => ({}), head: { append: node => appended.push(node.src) }
    };
    vm.runInNewContext(read('preferences.js'), {
      document, window: {}, Node: {}, WeakMap,
      matchMedia: () => ({ matches: false, addEventListener() {} }),
      localStorage: { getItem: key => key === 'rv-language' ? saved : null, setItem() {} }
    });
    return { written, appended, lang: document.documentElement.lang };
  }
  assert.deepEqual(load(null).written, []);
  const english = load('en');
  assert.equal(english.lang, 'en');
  // Written while the parser is blocked, so the table is ready before the first paint.
  assert.equal(english.written.length, 1);
  assert.match(english.written[0], /^<script src="\/english\.js\?v=[0-9a-f]{10}"><\/script>$/);
});

test('on phones a button takes over after two automatic pages so the footer stays reachable', async () => {
  const nodes = new Map();
  const get = id => {
    if (!nodes.has(id)) nodes.set(id, { value: '', textContent: '', style: {}, options: [], hidden: true, setAttribute() {}, addEventListener() {}, getBoundingClientRect: () => ({ bottom: 0 }) });
    return nodes.get(id);
  };
  let initialize, scroll, loads = 0;
  runPageScript('messages.js', {
    document: { getElementById: get, querySelector: () => null, addEventListener(type, callback) { if (type === 'DOMContentLoaded') initialize = callback; } },
    window: { innerHeight: 800, addEventListener(type, callback) { if (type === 'scroll') scroll = callback; } },
    getComputedStyle: () => ({ overflowY: 'visible' }), setTimeout: callback => callback(), clearTimeout() {}
  }, { replace: { initAuth: async () => false, loadMainMessages: async () => { loads++; } } });
  await initialize();
  assert.equal(loads, 1);
  scroll(); scroll();
  assert.equal(loads, 3);
  assert.equal(get('feedMore').hidden, true);
  scroll();
  assert.equal(loads, 3, 'the third page waits for the button');
  assert.equal(get('feedMore').hidden, false);
  await get('feedMore').onclick();
  assert.equal(loads, 4);
  assert.equal(get('feedMore').hidden, true);
  scroll();
  assert.equal(loads, 5, 'pressing the button allows automatic pages again');
});

test('status messages appear in the page and are announced, instead of alert()', () => {
  for (const name of ['messages.js', 'details.js']) assert.doesNotMatch(read(name), /\b(?:alert|confirm)\(/, name);
  const appended = [];
  const window = {};
  vm.runInNewContext(read('forum-ui.js'), {
    window, Date, setTimeout: () => 1, clearTimeout() {},
    document: {
      addEventListener() {}, body: { append: node => appended.push(node) },
      createElement: () => ({ attributes: {}, setAttribute(name, value) { this.attributes[name] = value; } })
    }
  });
  window.ForumUI.notify('发布失败', 'error');
  window.ForumUI.notify('发布成功', 'success');
  assert.equal(appended.length, 1);
  assert.equal(appended[0].textContent, '发布成功');
  assert.equal(appended[0].attributes.role, 'status');
  assert.equal(appended[0].className, 'forum-toast show success');
});

test('menu items and reply links are buttons, and dialogs take and return focus', () => {
  const html = read('messages.html');
  assert.match(html, /<div class="avatar-dropdown" id="avatarDropdown" role="menu"/);
  assert.match(html, /<button type="button" role="menuitem" id="openProfile">/);
  assert.match(html, /<button type="button" role="menuitem" id="openNotifications">/);
  assert.match(read('details.js'), /<button type="button" class="reply-info" data-action="jump"/);

  const focused = [];
  const control = name => ({ focus: () => focused.push(name) });
  const modal = { style: {} };
  const { showModal, hideModal } = runPageScript('messages.js', {}, { expose: ['showModal', 'hideModal'] });
  showModal(modal, control('close button'), control('menu button'));
  assert.equal(modal.style.display, 'flex');
  showModal(modal, control('again'), control('other'));
  hideModal(modal);
  hideModal(modal);
  assert.equal(modal.style.display, 'none');
  assert.deepEqual(focused, ['close button', 'menu button']);
});

test('Cloudflare serves every static file without invoking Functions', t => {
  // Vercel serves static files from its CDN without running functions, so it has no list.
  if (!files.includes('_routes.json')) return t.skip('Cloudflare only');
  // Each Functions request counts toward the daily request quota. With a root
  // _middleware.js and no _routes.json, every script, stylesheet and image counted.
  const routes = JSON.parse(read('_routes.json'));
  assert.equal(routes.version, 1);
  assert.deepEqual(routes.include, ['/*']);
  assert.ok(routes.include.length + routes.exclude.length <= 100, 'Cloudflare allows at most 100 rules');
  for (const rule of routes.exclude) assert.ok(rule.startsWith('/') && rule.length <= 100, rule);
  const excluded = new Set(routes.exclude);
  for (const name of [...scripts, ...files.filter(name => name.endsWith('.css'))]) assert.ok(excluded.has('/' + name), `${name} is missing from _routes.json`);
  for (const rule of ['/images/*', '/vendor/*', '/favicon.ico']) assert.ok(excluded.has(rule), rule);
  // Pages, the APIs, and anything the middleware keeps private still go through it.
  for (const rule of routes.exclude) {
    assert.doesNotMatch(rule, /^\/(?:api|auth|functions|docs|supabase|test|scripts|migrations)(?:\/|$)|\.(?:md|sql|jsonc?|toml|ya?ml)$|^\/\*$/, rule);
    if (rule.endsWith('.html')) assert.match(rule, /^\/(?:header|header-checker|footer)\.html$/, rule);
  }
});

test('every script and stylesheet URL carries the hash of the current file', () => {
  // Cloudflare keeps static files at the edge for days, so a changed file under an
  // unchanged URL was served stale after a release. Fails when a file changed without
  // running scripts/sync-asset-versions.mjs.
  execFileSync(process.execPath, [fileURLToPath(new URL('scripts/sync-asset-versions.mjs', root)), '--check'], { stdio: 'pipe' });
  const hash = name => createHash('sha256').update(readFileSync(new URL(name, root))).digest('hex').slice(0, 10);
  let checked = 0;
  for (const name of [...pages, 'messages.js', 'avatar-editor.js', 'preferences.js']) {
    for (const [, path, version] of read(name).matchAll(/["'`](?:\.\/|\/)?((?:vendor\/(?:webp\/)?)?[A-Za-z0-9_.-]+\.(?:js|css))(?:\?v=([^"'`]*))?["'`]/g)) {
      if (!files.includes(path) && !path.startsWith('vendor/')) continue;
      assert.equal(version, hash(path), `${name} -> ${path}`);
      checked++;
    }
  }
  assert.ok(checked > 100, `only ${checked} references found`);
});

test('the comment link shows the reply count when the server sends one', async () => {
  for (const [count, label] of [[3, '3 条评论'], [0, '发表评论'], [undefined, '查看评论']]) {
    const h = feed('auto');
    const first = h.load();
    h.calls[0].resolve({ messages: [{ ...post, reply_count: count }], hasMore: false });
    await first;
    assert.match(h.container.innerHTML, new RegExp(`<span aria-hidden="true">💬</span> ${label}</a>`), String(count));
  }
});

test('a click anywhere on a post card opens it, except on links, images and selected text', () => {
  const { openCard } = runPageScript('messages.js', {
    document: { createElement: () => ({}), querySelector: () => null, getElementById: () => null },
    window: { RootedVoxPublicData: {}, getSelection: () => selection },
    ForumUI: {}
  }, { expose: ['openCard'] });
  let selection = '', opened = 0;
  const link = { click: () => { opened++; } };
  const card = { querySelector: selector => selector === 'a.detail-btn' ? link : null };
  const target = interactive => ({ closest: selector => selector === '.message-item' ? card : interactive });
  const click = (interactive = null, extra = {}) => openCard({ button: 0, target: target(interactive), ...extra });
  click();
  assert.equal(opened, 1);
  click({ tagName: 'IMG' });
  click({ tagName: 'A' });
  click(null, { metaKey: true });
  click(null, { button: 1 });
  click(null, { defaultPrevented: true });
  selection = '复制这段文字';
  click();
  assert.equal(opened, 1);
});

test('the desktop feed keeps its own scroll box and cards do not lift on hover', () => {
  const css = read('messages.css');
  const desktop = css.slice(0, css.lastIndexOf('@media (max-width: 768px)'));
  // The feed scrolls inside its own box beside the form; the page itself stays put.
  assert.match(desktop, /\.message-feed \{[^}]*overflow-y:auto/);
  assert.match(desktop, /\.message-list-inner \{[^}]*position:absolute/);
  assert.doesNotMatch(desktop, /\.message-form-section \{ position:sticky;/);
  assert.doesNotMatch(css, /\.message-item:hover \{[^}]*transform/);
  assert.match(css, /#messageContainer > \.message-item \{ content-visibility:auto;/);
  assert.match(read('messages.html'), /id="messageFeed"[^>]*tabindex="0"/);
});

test('phones drop the guest compose card and the live header blur', () => {
  const css = read('messages.css');
  const phone = css.slice(css.lastIndexOf('@media (max-width: 768px)'));
  assert.match(phone, /\.is-guest \.message-form-section \{ display:none; \}/);
  assert.match(phone, /\.message-form-section \{ position:static;/);
  assert.match(read('common.css'), /@media\(max-width:860px\)\{\.header,\.header\.scrolled\{backdrop-filter:none;/);
});

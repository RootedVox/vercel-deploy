import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { getBusinessSession } from '../functions/_lib/session.js';
import { applyPage, pageResult } from '../functions/_lib/pagination.js';
import { loadLexicon, scanLexicon } from '../functions/_lib/lexicon.js';
import { onRequest } from '../functions/_middleware.js';
import { onRequestPost as scheduledWorker } from '../functions/api/moderation-worker.js';

test('rotating the same session concurrently never clears the winning cookie', async t => {
  let bothReading, reads = 0, rotations = 0;
  const barrier = new Promise(resolve => { bothReading = resolve; });
  t.mock.method(globalThis, 'fetch', async (_, init) => {
    const { operation } = JSON.parse(init.body);
    if (operation === 'rotate_session') return Response.json(++rotations === 1);
    assert.equal(operation, 'read_session');
    if (++reads === 2) bothReading();
    await barrier;
    return Response.json({ user_id: 'user', absolute_expires_at: '2099-01-01', last_seen_at: '2000-01-01' });
  });
  const request = new Request('https://rv.celestivast.com/auth/session', { headers: { Cookie: '__Secure-rv_session=test' } });
  const read = () => getBusinessSession(request, {
    AUTH_STORE: 'supabase', AUTH_STORE_SUPABASE_SECRET_KEY: 'sb_secret_mock', BUSINESS_SUPABASE_URL: 'https://db.example'
  }, { rotateAfter: 1800, sessionTtl: 28000 }, true);
  const results = await Promise.all([read(), read()]);
  assert.ok(results.every(row => row.session?.user_id === 'user'));
  const cookies = results.map(row => row.setCookie).filter(Boolean);
  assert.equal(cookies.length, 1);
  assert.doesNotMatch(cookies[0], /Max-Age=0;/);
});

test('equal-length lexicon changes refresh once and an empty dictionary fails closed', async () => {
  let calls = 0, word = '甲乙';
  const env = { LEXICON_KV: { async get() { calls++; return '#' + 'x'.repeat(60) + '\n' + word; } } };
  const [first] = await Promise.all([loadLexicon(env), loadLexicon(env)]);
  assert.equal(calls, 1);
  first.loadedAt = 0;
  word = '丙丁';
  const second = await loadLexicon(env);
  assert.equal(scanLexicon('丙丁', second).hit, true);
  assert.equal(scanLexicon('甲乙', second).hit, false);
  second.loadedAt = 0;
  word = '';
  assert.equal(await loadLexicon(env), null);
});

test('public cursors preserve timestamp precision and order equal timestamps by ID', () => {
  const time = '2026-11-12T09:12:00.123456+00:00';
  const data = pageResult([{ id: 2, created_at: time }, { id: 1, created_at: time }], 1, 'messages');
  const url = new URL('https://example.com');
  url.searchParams.set('cursor', data.nextCursor);
  const params = new URLSearchParams();
  assert.equal(applyPage(params, url, 4, 1), true);
  assert.equal(params.has('offset'), false);
  assert.equal(params.get('or'), `(created_at.lt.${time},and(created_at.eq.${time},id.lt.2))`);
  url.searchParams.set('cursor', time + '|2),id.eq.5');
  assert.equal(applyPage(params, url, 4, 1), false);
});

test('nickname quotes are escaped inside image and reply attributes', () => {
  const context = { window: {} };
  vm.runInNewContext(readFileSync(new URL('../forum-ui.js', import.meta.url), 'utf8'), context);
  assert.equal(context.window.ForumUI.escapeHtml('X" data-test="1'), 'X&quot; data-test=&quot;1');
});

test('peer preflight allows PATCH, and scheduled work requires a secret', async () => {
  const request = new Request('https://rv.celestivast.com/api/notifications', { method: 'OPTIONS',
    headers: { Origin: 'https://rv-vc.celestivast.com', 'Access-Control-Request-Method': 'PATCH' } });
  const preflight = await onRequest({ request, env: {}, next: () => new Response() });
  assert.match(preflight.headers.get('Access-Control-Allow-Methods'), /PATCH/);
  const denied = await scheduledWorker({ request, env: {} });
  assert.equal(denied.status, 403);
});

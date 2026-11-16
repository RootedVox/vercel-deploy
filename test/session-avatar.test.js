import test from 'node:test';
import assert from 'node:assert/strict';
import { onRequestGet as session } from '../functions/auth/session.js';
import { runPageScript } from './page-script.js';

const uid = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const avatar = `https://db.example/storage/v1/object/public/avatars/business/${uid}.${'a'.repeat(64)}.webp`;

async function environment() {
  const key = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const jwk = await crypto.subtle.exportKey('jwk', key.privateKey);
  const stored = { user_id: uid, display_name: '登录名', last_seen_at: new Date().toISOString() };
  return {
    AUTH_ISSUER: 'https://auth.example', AUTH_CLIENT_ID: 'client', AUTH_REDIRECT_URI: 'https://site.example/auth/callback',
    BUSINESS_SUPABASE_URL: 'https://db.example', BUSINESS_SUPABASE_PUBLISHABLE_KEY: 'public',
    BUSINESS_SUPABASE_SIGNING_JWK: JSON.stringify({ ...jwk, kid: 'test' }), AUTH_STORE: 'd1',
    AUTH_DB: { prepare() { return { bind() { return { first: async () => stored }; } }; } }
  };
}

async function sessionUser(t, reply) {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async input => { const url = new URL(input); calls.push(url); return reply(url); });
  const response = await session({
    env: await environment(),
    request: new Request('https://site.example/auth/session', { headers: { Cookie: '__Secure-rv_session=token' } })
  });
  assert.equal(response.status, 200);
  return { user: (await response.json()).user, calls };
}

test('the session check returns the avatar from the same profile read', async t => {
  const { user, calls } = await sessionUser(t, () => Response.json([{ nickname: '昵称', avatar_url: avatar }]));
  const profile = calls.filter(call => call.pathname === '/rest/v1/business_users');
  assert.equal(profile.length, 1);
  assert.equal(profile[0].searchParams.get('select'), 'nickname,display_name,avatar_url');
  assert.equal(user.name, '昵称');
  assert.equal(user.avatarUrl, avatar);
  t.mock.restoreAll();
  const without = await sessionUser(t, () => Response.json([{ nickname: '昵称', avatar_url: null }]));
  assert.ok(Object.hasOwn(without.user, 'avatarUrl'));
  assert.equal(without.user.avatarUrl, null);
});

test('a failed profile read leaves avatarUrl out so the page asks /api/profile', async t => {
  const { user } = await sessionUser(t, () => new Response('down', { status: 500 }));
  assert.equal(user.name, '登录名');
  assert.ok(!Object.hasOwn(user, 'avatarUrl'));
});

function forumPage(currentUser, profileReply) {
  const elements = new Map();
  const element = id => {
    if (!elements.has(id)) elements.set(id, { id, style: {}, hidden: false, src: '' });
    return elements.get(id);
  };
  const requests = [], dots = [];
  const exposed = runPageScript('messages.js', {
    ForumUI: { getFreshAvatar: url => url, escapeHtml: value => value, notify() {} },
    document: { getElementById: element, addEventListener() {} },
    request: async path => { requests.push(path); return Response.json(profileReply); }
  }, {
    replace: { currentUser, initNicknameSelect: () => {}, refreshNotificationDot: known => dots.push(known) },
    expose: ['initUserExtra']
  });
  return { initUserExtra: exposed.initUserExtra, element, requests, dots };
}

test('the forum page shows the session avatar without asking /api/profile', async () => {
  const page = forumPage({ id: uid, name: '昵称', avatarUrl: avatar, hasUnread: true }, {});
  await page.initUserExtra();
  assert.deepEqual(page.requests, []);
  assert.deepEqual(page.dots, [true]);
  assert.equal(page.element('avatarImg').src, avatar);
  assert.equal(page.element('avatarImg').style.display, 'block');

  const empty = forumPage({ id: uid, name: '昵称', avatarUrl: null }, {});
  await empty.initUserExtra();
  assert.deepEqual(empty.requests, []);
  assert.equal(empty.element('avatarPlaceholder').style.display, 'block');
});

test('without an avatar field in the session the forum page still asks /api/profile', async () => {
  const page = forumPage({ id: uid, name: '昵称' }, { nickname: '昵称', avatarUrl: avatar });
  await page.initUserExtra();
  assert.deepEqual(page.requests, ['/api/profile']);
  assert.equal(page.element('avatarImg').src, avatar);
});

test('the session check also says whether there are unread notifications', async t => {
  const answer = unread => url => url.pathname === '/rest/v1/business_notifications'
    ? Response.json(unread) : Response.json([{ nickname: '昵称' }]);
  const { user, calls } = await sessionUser(t, answer([{ id: 7 }]));
  assert.equal(user.hasUnread, true);
  const read = calls.find(call => call.pathname === '/rest/v1/business_notifications');
  assert.equal(read.searchParams.get('user_id'), 'eq.' + uid);
  assert.equal(read.searchParams.get('read'), 'eq.false');
  assert.equal(read.searchParams.get('limit'), '1');
  t.mock.restoreAll();
  assert.equal((await sessionUser(t, answer([]))).user.hasUnread, false);
  t.mock.restoreAll();
  // A failed notification read is left out and does not affect the profile fields.
  const failed = await sessionUser(t, url => url.pathname === '/rest/v1/business_notifications'
    ? new Response('down', { status: 500 }) : Response.json([{ nickname: '昵称', avatar_url: avatar }]));
  assert.ok(!Object.hasOwn(failed.user, 'hasUnread'));
  assert.equal(failed.user.avatarUrl, avatar);
});

function notificationDots(reply) {
  const notificationDot = { style: {} }, dropdownDot = { style: {} };
  const requests = [];
  const { refreshNotificationDot } = runPageScript('messages.js', {
    ForumUI: {}, notificationDot, dropdownDot,
    document: { getElementById: () => ({ style: {} }), addEventListener() {} },
    request: async path => { requests.push(path); return Response.json(reply); }
  }, { replace: { userId: uid }, expose: ['refreshNotificationDot'] });
  return { refreshNotificationDot, notificationDot, dropdownDot, requests };
}

test('the forum page uses the session unread answer without asking /api/notifications', async () => {
  const shown = notificationDots({});
  await shown.refreshNotificationDot(true);
  assert.deepEqual(shown.requests, []);
  assert.equal(shown.notificationDot.style.display, 'block');
  assert.equal(shown.dropdownDot.style.display, 'inline-block');
  const hidden = notificationDots({});
  await hidden.refreshNotificationDot(false);
  assert.deepEqual(hidden.requests, []);
  assert.equal(hidden.notificationDot.style.display, 'none');
});

test('without a session unread answer the forum page still asks /api/notifications', async () => {
  const page = notificationDots({ hasUnread: true });
  await page.refreshNotificationDot(undefined);
  assert.deepEqual(page.requests, ['/api/notifications?exists=1']);
  assert.equal(page.notificationDot.style.display, 'block');
});

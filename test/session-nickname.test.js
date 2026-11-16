import test from 'node:test';
import assert from 'node:assert/strict';
import { onRequestGet as session } from '../functions/auth/session.js';
import { OFFICIAL_NICKNAME, OFFICIAL_USER_ID } from '../functions/_lib/official-profile.js';

const uid = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
async function environment(row = {}) {
  const key = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const jwk = await crypto.subtle.exportKey('jwk', key.privateKey);
  const stored = { user_id: uid, display_name: '登录时的旧名字', email: 'a@example.invalid', last_seen_at: new Date().toISOString(), ...row };
  return {
    AUTH_ISSUER: 'https://auth.example', AUTH_CLIENT_ID: 'client', AUTH_REDIRECT_URI: 'https://site.example/auth/callback',
    BUSINESS_SUPABASE_URL: 'https://db.example', BUSINESS_SUPABASE_PUBLISHABLE_KEY: 'public',
    BUSINESS_SUPABASE_SIGNING_JWK: JSON.stringify({ ...jwk, kid: 'test' }), AUTH_STORE: 'd1',
    AUTH_DB: { prepare() { return { bind() { return { first: async () => stored }; } }; } }
  };
}
const ask = (cookie = '__Secure-rv_session=token') => new Request('https://site.example/auth/session', { headers: cookie ? { Cookie: cookie } : {} });
async function name(env, reply, t) {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (input, init) => { calls.push(new URL(input)); return reply(init); });
  const response = await session({ request: ask(), env });
  assert.equal(response.status, 200);
  return { name: (await response.json()).user.name, calls };
}

test('the session check answers with the current site nickname, not the sign-in name', async t => {
  const { name: shown, calls } = await name(await environment(), () => Response.json([{ nickname: '新昵称', display_name: '登录时的旧名字' }]), t);
  assert.equal(shown, '新昵称');
  // The unread-notification read runs alongside; only one profile read is made.
  const profile = calls.filter(call => call.pathname === '/rest/v1/business_users');
  assert.equal(profile.length, 1);
  assert.equal(profile[0].searchParams.get('user_id'), 'eq.' + uid);
  assert.equal(profile[0].searchParams.get('select'), 'nickname,display_name,avatar_url');
});

test('without a site nickname the stored display name is used, filtered like /api/profile', async t => {
  assert.equal((await name(await environment(), () => Response.json([{ nickname: null, display_name: '小明' }]), t)).name, '小明');
  t.mock.restoreAll();
  // A reserved name from Keycloak is never shown, as in the profile API.
  assert.equal((await name(await environment(), () => Response.json([{ nickname: null, display_name: 'Jerry' }]), t)).name, '校园用户');
  t.mock.restoreAll();
  assert.equal((await name(await environment({ user_id: OFFICIAL_USER_ID }), () => Response.json([{}]), t)).name, OFFICIAL_NICKNAME);
});

test('a failing or slow nickname read falls back to the sign-in name instead of failing the check', async t => {
  assert.equal((await name(await environment(), () => new Response('down', { status: 500 }), t)).name, '登录时的旧名字');
  t.mock.restoreAll();
  let aborted = false;
  const started = Date.now();
  const slow = await name(await environment(), init => new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(Response.json([{ nickname: '太晚了' }])), 2500);
    init.signal?.addEventListener('abort', () => { aborted = true; clearTimeout(timer); reject(new Error('aborted')); });
  }), t);
  assert.equal(slow.name, '登录时的旧名字');
  assert.equal(aborted, true);
  assert.ok(Date.now() - started < 2400, 'the session check waits at most about 1.5 s for the nickname');
});

test('signed-out visitors cost no database read', async t => {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async input => { calls.push(input); return Response.json([]); });
  const response = await session({ request: ask(null), env: await environment() });
  assert.equal(response.status, 401);
  assert.equal(calls.length, 0);
});

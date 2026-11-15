import test from 'node:test';
import assert from 'node:assert/strict';
import { onRequestPost as postMessage } from '../functions/api/messages.js';
import { onRequestPut as saveProfile } from '../functions/api/profile.js';
import { onRequestPut as saveMealRating } from '../functions/api/meal-ratings.js';
import { onRequestPatch as moderate } from '../functions/api/checker/messages.js';
import { onRequestGet as postLogout } from '../functions/auth/post-logout.js';
import { exchangeCode, fetchUserInfo } from '../functions/_lib/oidc.js';
import { OFFICIAL_NICKNAME, OFFICIAL_USER_ID } from '../functions/_lib/official-profile.js';

const site = 'https://site.example';
const uid = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

async function environment(session = {}) {
  const key = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const jwk = await crypto.subtle.exportKey('jwk', key.privateKey);
  const row = { user_id: uid, last_seen_at: new Date().toISOString(), ...session };
  return {
    AUTH_ISSUER: 'https://auth.example', AUTH_CLIENT_ID: 'client', AUTH_REDIRECT_URI: site + '/auth/callback',
    BUSINESS_SUPABASE_URL: 'https://db.example', BUSINESS_SUPABASE_PUBLISHABLE_KEY: 'public',
    BUSINESS_SUPABASE_SIGNING_JWK: JSON.stringify({ ...jwk, kid: 'test' }),
    AUTH_STORE: 'd1',
    AUTH_DB: { prepare() { return { bind() { return { first: async () => row }; } }; } }
  };
}

function write(path, method, body) {
  return new Request(site + path, {
    method, headers: { Origin: site, Cookie: '__Secure-rv_session=test' },
    body: typeof body === 'string' ? body : JSON.stringify(body)
  });
}

test('a JSON body that is not an object is a 400, not an unhandled exception', async t => {
  const env = await environment();
  t.mock.method(globalThis, 'fetch', async () => Response.json([{ is_checker: true }]));
  for (const body of ['null', '42', '"text"', '[]']) {
    for (const [handler, path, method] of [
      [saveProfile, '/api/profile', 'PUT'],
      [saveMealRating, '/api/meal-ratings', 'PUT'],
      [moderate, '/api/checker/messages', 'PATCH'],
      [postMessage, '/api/messages', 'POST']
    ]) {
      const response = await handler({ request: write(path, method, body), env });
      assert.equal(response.status, 400, `${path} ${body}`);
    }
  }
});

test('a reply whose target cannot be checked answers 503 instead of throwing', async t => {
  const env = await environment();
  t.mock.method(globalThis, 'fetch', async input => {
    if (new URL(input).pathname.endsWith('/approved_messages_public')) return new Response('down', { status: 500 });
    return Response.json([]);
  });
  const response = await postMessage({
    request: write('/api/messages', 'POST', { content: 'reply', anonymous: true, replyTo: '1' }), env
  });
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: 'message_save_failed' });
});

test('a nickname hiding invisible characters inside a reserved name is refused', async t => {
  const env = await environment();
  t.mock.method(globalThis, 'fetch', async (input, init) => Response.json([JSON.parse(init.body)]));
  for (const nickname of ['RootedVox​官方', 'Jer⁠ry', '匿名‍用户', '​']) {
    const response = await saveProfile({ request: write('/api/profile', 'PUT', { nickname }), env });
    assert.equal(response.status, 400, JSON.stringify(nickname));
  }
  const response = await saveProfile({ request: write('/api/profile', 'PUT', { nickname: '小明' }), env });
  assert.equal(response.status, 200);
});

test('token and userinfo requests carry an abort signal so a stalled provider cannot hang login', async t => {
  const signals = [];
  t.mock.method(globalThis, 'fetch', async (input, init) => {
    signals.push(init.signal);
    return Response.json({ id_token: 'a.b.c', sub: 'subject' });
  });
  const discovery = { token_endpoint: 'https://auth.example/token', userinfo_endpoint: 'https://auth.example/userinfo' };
  await exchangeCode(discovery, { clientId: 'client', redirectUri: site + '/auth/callback' }, 'code', 'verifier');
  await fetchUserInfo(discovery, { access_token: 'token' }, 'subject');
  assert.equal(signals.length, 2);
  for (const signal of signals) assert.ok(signal instanceof AbortSignal);
});

test('a provider display name cannot post under the official or a reserved name', async t => {
  const saved = [];
  async function post(session, profile) {
    const env = await environment(session);
    const fetchMock = t.mock.method(globalThis, 'fetch', async (input, init = {}) => {
      const { pathname } = new URL(input);
      if (pathname.endsWith('/business_users')) return Response.json([profile]);
      if (pathname.endsWith('/messages') && init.method === 'POST') {
        saved.push(JSON.parse(init.body).username);
        return Response.json([{ id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' }]);
      }
      return Response.json(null);
    });
    const response = await postMessage({ request: write('/api/messages', 'POST', { content: 'hello' }), env });
    fetchMock.mock.restore();
    assert.equal(response.status, 201);
    return saved.at(-1);
  }
  assert.equal(await post({ display_name: 'RootedVox官方' }, {}), '校园用户');
  assert.equal(await post({}, { display_name: 'rootedvox\u200b官方' }), '校园用户');
  assert.equal(await post({}, { display_name: ' Sam.Li ' }), '校园用户');
  assert.equal(await post({}, { display_name: '匿名用户' }), '校园用户');
  assert.equal(await post({ email: 'jerry@school.example' }, {}), '校园用户');
  assert.equal(await post({}, { display_name: '小明' }), '小明');
  // A stored nickname is the reviewed value and is shown as saved.
  assert.equal(await post({}, { nickname: 'Jerry', display_name: '小明' }), 'Jerry');
  assert.equal(await post({}, { nickname: '自定义昵称', display_name: 'RootedVox官方' }), '自定义昵称');
  assert.equal(await post({ user_id: OFFICIAL_USER_ID }, {}), OFFICIAL_NICKNAME);
});

test('the post-logout landing only redirects and never ends a session', async () => {
  const env = { AUTH_STORE: 'd1', AUTH_DB: { prepare() { throw new Error('session store touched'); } } };
  const request = new Request(site + '/auth/post-logout', { headers: { Cookie: '__Secure-rv_session=live' } });
  const response = await postLogout({ request, env });
  assert.equal(response.status, 302);
  assert.equal(response.headers.get('Location'), 'https://rv.celestivast.com/main');
  assert.equal(response.headers.get('Set-Cookie'), null);
  assert.match(response.headers.get('Cache-Control'), /no-store/);
});

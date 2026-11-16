import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { onRequestPut as saveProfile } from '../functions/api/profile.js';
import { onRequestPost as postMessage } from '../functions/api/messages.js';
import { isReservedNickname, resolveProfileNickname } from '../functions/_lib/official-profile.js';

const JERRY = '1d850588-d352-52f8-99bd-b0d8ae8b9343';
const SAM = 'e1b791d0-5815-5c02-97f2-4d331351d715';
const YZ = 'ce424600-49b0-5fe9-a000-30ece8db38cc';
const OTHER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const site = 'https://site.example';

async function environment(row) {
  const key = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const jwk = await crypto.subtle.exportKey('jwk', key.privateKey);
  const stored = { last_seen_at: new Date().toISOString(), ...row };
  return {
    AUTH_ISSUER: 'https://auth.example', AUTH_CLIENT_ID: 'client', AUTH_REDIRECT_URI: site + '/auth/callback',
    BUSINESS_SUPABASE_URL: 'https://db.example', BUSINESS_SUPABASE_PUBLISHABLE_KEY: 'public',
    BUSINESS_SUPABASE_SIGNING_JWK: JSON.stringify({ ...jwk, kid: 'test' }), AUTH_STORE: 'd1',
    AUTH_DB: { prepare() { return { bind() { return { first: async () => stored }; } }; } }
  };
}
const write = (path, method, body) => new Request(site + path, {
  method, headers: { Origin: site, Cookie: '__Secure-rv_session=test' }, body: JSON.stringify(body)
});

test('a developer name belongs to its owner and to nobody else', () => {
  assert.equal(isReservedNickname('Jerry', JERRY), false);
  assert.equal(isReservedNickname(' JERRY ', JERRY), false);
  assert.equal(isReservedNickname('Jerry', SAM), true);
  assert.equal(isReservedNickname('Jerry', OTHER), true);
  assert.equal(isReservedNickname('Jerry'), true);
  assert.equal(isReservedNickname('Jer⁠ry', OTHER), true);
  assert.equal(isReservedNickname('yzxzyz', YZ), false);
  assert.equal(isReservedNickname('yzxzyz', OTHER), true);
  // Jerry also owns his full name; "匿名用户" stays closed to everyone.
  assert.equal(isReservedNickname('曹颢喆 Jerry', JERRY), false);
  assert.equal(isReservedNickname('曹颢喆  jerry', JERRY), false);
  assert.equal(isReservedNickname('曹颢喆 Jerry', SAM), true);
  assert.equal(isReservedNickname('曹颢喆 Jerry', OTHER), true);
  for (const id of [JERRY, OTHER, null]) assert.equal(isReservedNickname('匿名用户', id), true);
  assert.equal(isReservedNickname('小明', OTHER), false);
});

test('the owner can save their own name as a nickname; others still cannot', async t => {
  t.mock.method(globalThis, 'fetch', async (input, init) => Response.json([JSON.parse(init.body)]));
  for (const [user, nickname, status] of [
    [JERRY, 'Jerry', 200], [SAM, 'Sam.Li', 200], [YZ, 'yzxzyz', 200],
    [JERRY, '曹颢喆 Jerry', 200], [OTHER, '曹颢喆 Jerry', 400],
    [SAM, 'Jerry', 400], [OTHER, 'Jerry', 400], [OTHER, 'yzxzyz', 400], [JERRY, '匿名用户', 400]
  ]) {
    const response = await saveProfile({ request: write('/api/profile', 'PUT', { nickname }), env: await environment({ user_id: user }) });
    assert.equal(response.status, status, `${user} -> ${nickname}`);
  }
});

test('a developer whose name comes from Keycloak keeps it; anyone else with that name does not', async t => {
  assert.equal(resolveProfileNickname(JERRY, null, 'Jerry'), 'Jerry');
  assert.equal(resolveProfileNickname(OTHER, null, 'Jerry'), '校园用户');
  const saved = [];
  t.mock.method(globalThis, 'fetch', async (input, init = {}) => {
    const { pathname } = new URL(input);
    if (pathname.endsWith('/business_users')) return Response.json([{ display_name: 'Sam.Li' }]);
    if (pathname.endsWith('/messages') && init.method === 'POST') {
      saved.push(JSON.parse(init.body).username);
      return Response.json([{ id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' }]);
    }
    return Response.json(null);
  });
  for (const user of [SAM, OTHER]) {
    const response = await postMessage({ request: write('/api/messages', 'POST', { content: 'hello' }), env: await environment({ user_id: user }) });
    assert.equal(response.status, 201);
  }
  assert.deepEqual(saved, ['Sam.Li', '校园用户']);
});

test('every name with an owner also gets the Dev badge in the forum UI', () => {
  const source = readFileSync(new URL('../functions/_lib/official-profile.js', import.meta.url), 'utf8');
  const owned = [...source.matchAll(/\['([^']+)', '[0-9a-f-]{36}'\]/g)].map(match => match[1]);
  assert.deepEqual(owned.sort(), ['bychhh', 'jerry', 'maod1e', 'sam.li', 'yzxzyz', '曹颢喆 jerry']);
  const badge = readFileSync(new URL('../forum-ui.js', import.meta.url), 'utf8').match(/DEVELOPER_NICKNAMES = \[([\s\S]*?)\]/)[1];
  const names = [...badge.matchAll(/"([^"]+)"/g)].map(match => match[1].toLowerCase());
  for (const name of owned) assert.ok(names.includes(name), name);
});

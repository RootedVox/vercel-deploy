import test from 'node:test';
import assert from 'node:assert/strict';
import { onRequestGet } from '../functions/api/messages.js';
import { onRequestPatch } from '../functions/api/notifications.js';

const site = 'https://forum.example';
const env = {
  AUTH_ISSUER: 'https://auth.example', AUTH_CLIENT_ID: 'forum', AUTH_REDIRECT_URI: site + '/auth/callback',
  BUSINESS_SUPABASE_URL: 'https://db.example', BUSINESS_SUPABASE_PUBLISHABLE_KEY: 'public'
};
const missingRpc = () => Response.json({ code: 'PGRST202' }, { status: 404 });
const messages = query => onRequestGet({ request: new Request(site + '/api/messages?' + query), env });

test('homepage reads two approved root posts per zone when the overview RPC is missing', async t => {
  const zones = [];
  t.mock.method(globalThis, 'fetch', async url => {
    const { pathname, searchParams } = new URL(url);
    if (pathname.endsWith('/rpc/public_forum_overview')) return missingRpc();
    assert.ok(pathname.endsWith('/approved_messages_public'));
    assert.equal(searchParams.get('reply_to'), 'is.null');
    assert.equal(searchParams.get('limit'), '2');
    assert.equal(searchParams.get('order'), 'created_at.desc,id.desc');
    const zone = searchParams.get('zone');
    zones.push(zone);
    return Response.json([{ id: zone, zone: zone.startsWith('in.') ? '校园生活' : zone.slice(3) }]);
  });
  const response = await messages('overview=1');
  assert.equal(response.status, 200);
  assert.deepEqual(new Set(zones), new Set(['in.(日常分享,校园生活)', 'eq.学习互助', 'eq.活动社团', 'eq.失物招领']));
  assert.deepEqual((await response.json()).messages.map(row => row.zone).sort(), ['日常分享', '学习互助', '活动社团', '失物招领'].sort());
});

test('temporary errors do not start legacy overview, list or full-thread queries', async t => {
  const fetch = t.mock.method(globalThis, 'fetch', async () => new Response(null, { status: 503 }));
  for (const query of ['overview=1', 'limit=20', 'thread=11111111-1111-4111-8111-111111111111&batch=21']) {
    fetch.mock.resetCalls();
    assert.equal((await messages(query)).status, 503);
    assert.equal(fetch.mock.callCount(), 1, query);
  }
});

test('feed falls back to the old projection when optional columns are missing', async t => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async url => {
    calls++;
    if (new URL(url).searchParams.get('select').includes('avatar_url')) {
      return Response.json({ code: '42703' }, { status: 400 });
    }
    return Response.json([{ id: 1, zone: '校园生活' }]);
  });
  const result = await messages('limit=2');
  assert.equal(result.status, 200);
  assert.deepEqual((await result.json()).messages, [{ id: 1, zone: '日常分享' }]);
  assert.equal(calls, 3);
});

async function markNotifications(t, rpcResponse) {
  const keys = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const jwk = await crypto.subtle.exportKey('jwk', keys.privateKey);
  const userId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    const { pathname, searchParams } = new URL(url);
    if (pathname.endsWith('/isa_auth_store')) return Response.json({ user_id: userId });
    if (pathname.endsWith('/rpc/read_forum_notifications')) return rpcResponse;
    calls.push({ method: init.method || 'GET', searchParams });
    return init.method === 'PATCH' ? new Response(null, { status: 204 }) : Response.json([{ id: 11 }]);
  });
  const response = await onRequestPatch({
    request: new Request(site + '/api/notifications?through=10', {
      method: 'PATCH', headers: { Origin: site, Cookie: '__Secure-rv_session=test' }
    }),
    env: { ...env, AUTH_STORE: 'supabase', AUTH_STORE_SUPABASE_SECRET_KEY: 'sb_secret_test',
      BUSINESS_SUPABASE_SIGNING_JWK: JSON.stringify({ ...jwk, kid: 'test' }) }
  });
  return { response, calls, userId };
}

test('old database marks only notifications through the displayed ID and reports remaining unread', async t => {
  const { response, calls, userId } = await markNotifications(t, missingRpc());
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, hasUnread: true });
  assert.deepEqual(calls.map(call => call.method), ['PATCH', 'GET']);
  const [write, read] = calls;
  for (const call of calls) {
    assert.equal(call.searchParams.get('user_id'), 'eq.' + userId);
    assert.equal(call.searchParams.get('read'), 'eq.false');
  }
  assert.equal(write.searchParams.get('id'), 'lte.10');
  assert.equal(read.searchParams.has('id'), false);
  assert.equal(read.searchParams.get('limit'), '1');
});

test('temporary mark-read failure never sends another write', async t => {
  const { response, calls } = await markNotifications(t, new Response(null, { status: 503 }));
  assert.equal(response.status, 503);
  assert.deepEqual(calls, []);
});

const rootId = '11111111-1111-4111-8111-111111111111';
const parentId = '22222222-2222-4222-8222-222222222222';
const replyId = '33333333-3333-4333-8333-333333333333';
const threadRows = [
  { id: rootId, reply_to: null, username: '主帖', zone: '校园生活' },
  { id: parentId, reply_to: rootId, username: '家长' },
  { id: replyId, reply_to: parentId, username: '学生' }
];

test('reply lookup uses one scoped RPC and returns only the root and target', async t => {
  const fetch = t.mock.method(globalThis, 'fetch', async input => {
    const url = new URL(input);
    assert.equal(url.pathname, '/rest/v1/rpc/public_forum_reply');
    assert.equal(url.searchParams.get('root_id'), rootId);
    assert.equal(url.searchParams.get('target_id'), replyId);
    return Response.json({ messages: [threadRows[0], threadRows[2]], parentName: '家长' });
  });
  const result = await messages('thread=' + rootId + '&reply=' + replyId);
  const body = await result.json();
  assert.equal(result.status, 200);
  assert.equal(fetch.mock.callCount(), 1);
  assert.deepEqual(body.messages.map(row => row.id), [rootId, replyId]);
  assert.equal(body.messages[0].zone, '日常分享');
  assert.equal(body.parentName, '家长');
});

test('legacy reply lookup keeps unrelated rows out of the response and preserves parent attribution', async t => {
  t.mock.method(globalThis, 'fetch', async url =>
    new URL(url).pathname.endsWith('/public_forum_reply') ? missingRpc() : Response.json(threadRows));
  for (const [target, expected] of [[replyId, [rootId, replyId]], [rootId.replace(/^1/, '4'), [rootId]]]) {
    const result = await messages('thread=' + rootId + '&reply=' + target);
    const body = await result.json();
    assert.deepEqual(body.messages.map(row => row.id), expected);
    assert.equal(body.parentName, target === replyId ? '家长' : null);
  }
});

test('reply lookup rejects malformed IDs before reading and keeps temporary failures bounded', async t => {
  const fetch = t.mock.method(globalThis, 'fetch', async () => new Response(null, { status: 503 }));
  assert.equal((await messages('thread=' + rootId + '&reply=bad')).status, 400);
  assert.equal(fetch.mock.callCount(), 0);
  assert.equal((await messages('thread=' + rootId + '&reply=' + replyId)).status, 503);
  assert.equal(fetch.mock.callCount(), 1);
});

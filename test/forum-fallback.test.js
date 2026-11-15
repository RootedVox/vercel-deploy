import test from 'node:test';
import assert from 'node:assert/strict';
import { moderationQueueAvailable } from '../functions/_lib/moderation-worker.js';
import { onRequestGet } from '../functions/api/messages.js';

const env = {
  BUSINESS_SUPABASE_URL: 'https://db.example',
  BUSINESS_SUPABASE_PUBLISHABLE_KEY: 'publishable',
  AUTH_STORE_SUPABASE_SECRET_KEY: 'sb_secret_mock'
};

test('queue probe reports unavailable before the migration runs', async t => {
  t.mock.method(globalThis, 'fetch', async () => new Response('{"code":"PGRST202"}', { status: 404 }));
  assert.equal(await moderationQueueAvailable(env), false);
});

test('queue probe reports available once the review RPC exists', async t => {
  t.mock.method(globalThis, 'fetch', async () => Response.json(null));
  assert.equal(await moderationQueueAvailable(env), true);
});

test('thread reads fall back to the full-thread RPC before the migration runs', async t => {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async url => {
    calls.push(String(url));
    if (String(url).includes('public_forum_thread_page')) {
      return new Response('{"code":"PGRST202"}', { status: 404 });
    }
    assert.match(String(url), /rpc\/public_forum_thread\?/);
    return Response.json([{
      id: '11111111-1111-4111-8111-111111111111',
      username: 'a', content: 'b', zone: '日常分享',
      created_at: '2026-11-13T00:00:00Z', reply_to: null
    }]);
  });
  const request = new Request('https://rv.celestivast.com/api/messages?thread=11111111-1111-4111-8111-111111111111&batch=21');
  const response = await onRequestGet({ request, env });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.messages.length, 1);
  assert.equal(body.nextCursor, undefined);
  assert.ok(calls.some(call => call.includes('public_forum_thread_page')));
  assert.ok(calls.some(call => call.includes('public_forum_thread?root_id=')));
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { processModerationBatch } from '../functions/_lib/moderation-worker.js';
import { onRequestGet } from '../functions/api/messages.js';

const env = {
  BUSINESS_SUPABASE_URL: 'https://db.example',
  BUSINESS_SUPABASE_PUBLISHABLE_KEY: 'publishable',
  AUTH_STORE_SUPABASE_SECRET_KEY: 'sb_secret_mock'
};

test('an idle review queue costs the scheduled worker one database call', async t => {
  const fetch = t.mock.method(globalThis, 'fetch', async () => Response.json(null));
  assert.equal(await processModerationBatch(env), 0);
  assert.equal(fetch.mock.callCount(), 1);
});

test('a waiting review queue is still worked four posts at a time', async t => {
  let waiting = 6, finished = 0;
  t.mock.method(globalThis, 'fetch', async url => {
    if (String(url).endsWith('/claim_forum_review')) {
      return Response.json(waiting-- > 0 ? { id: 'post', lease: 'lease', content: 'hello' } : null);
    }
    assert.ok(String(url).endsWith('/finish_forum_review'));
    finished++;
    return Response.json(null);
  });
  // No word list is bound here, so every post is handed to a human without a model call.
  assert.equal(await processModerationBatch(env), 4);
  assert.equal(finished, 4);
});

const feedEnv = { BUSINESS_SUPABASE_URL: 'https://db.example', BUSINESS_SUPABASE_PUBLISHABLE_KEY: 'publishable' };
const feed = query => onRequestGet({ request: new Request('https://rv.celestivast.com/api/messages?' + query), env: feedEnv });
const feedRows = () => Response.json([{ id: '11111111-1111-4111-8111-111111111111', username: 'a', content: 'b', zone: '日常分享', created_at: '2026-11-13T00:00:00Z', reply_to: null }]);

test('the next feed and overview reads include a newly approved post', async t => {
  let approved = [];
  t.mock.method(globalThis, 'fetch', async () => Response.json(approved));
  for (const query of ['limit=20&page=0&sort=newest', 'overview=1', 'zone=学习互助']) {
    approved = [];
    assert.deepEqual((await (await feed(query)).json()).messages, []);
    approved = [{ id: '123', content: '刚通过审核', zone: '学习互助' }];
    const response = await feed(query);
    assert.match(response.headers.get('Cache-Control'), /no-store/);
    assert.equal((await response.json()).messages[0].id, '123');
  }
});

test('searches, later pages, threads and failed reads are never kept', async t => {
  let fail = false;
  const fetch = t.mock.method(globalThis, 'fetch', async () => fail ? new Response(null, { status: 503 }) : feedRows());
  for (const query of ['limit=20&search=x', 'limit=20&page=1', 'limit=20&cursor=2026-11-13T00:00:00Z|11111111-1111-4111-8111-111111111111', 'thread=11111111-1111-4111-8111-111111111111']) {
    await feed(query);
    const calls = fetch.mock.callCount();
    await feed(query);
    assert.ok(fetch.mock.callCount() > calls, query);
  }
  fail = true;
  assert.equal((await feed('limit=5')).status, 503);
  fail = false;
  assert.equal((await feed('limit=5')).status, 200);
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

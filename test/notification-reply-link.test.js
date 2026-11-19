import test from 'node:test';
import assert from 'node:assert/strict';
import { onRequestGet } from '../functions/api/messages.js';

const site = 'https://site.example';
const env = {
  BUSINESS_SUPABASE_URL: 'https://db.example',
  BUSINESS_SUPABASE_PUBLISHABLE_KEY: 'public',
  BUSINESS_SUPABASE_SIGNING_JWK: '{}',
  AUTH_ISSUER: 'https://auth.example',
  AUTH_CLIENT_ID: 'client',
  AUTH_REDIRECT_URI: site + '/auth/callback'
};
const replyId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

function get(path) {
  return onRequestGet({ request: new Request(site + path), env });
}

// A reply notification only carries the reply id. The thread is resolved on click, so the
// endpoint must pass the visible root through unchanged and report a pending reply as null
// rather than opening an unrelated thread.
test('replyRoot resolves the thread a reply belongs to', async t => {
  t.mock.method(globalThis, 'fetch', async () => Response.json('root-1'));
  const response = await get(`/api/messages?replyRoot=${replyId}`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { rootId: 'root-1' });
});

test('a reply that is not public resolves to null instead of a wrong thread', async t => {
  t.mock.method(globalThis, 'fetch', async () => Response.json(null));
  const response = await get(`/api/messages?replyRoot=${replyId}`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { rootId: null });
});

test('replyRoot rejects a malformed id before touching the database', async t => {
  const fetch = t.mock.method(globalThis, 'fetch', async () => Response.json('root-1'));
  const response = await get('/api/messages?replyRoot=not-an-id');
  assert.equal(response.status, 400);
  assert.equal(fetch.mock.callCount(), 0);
});

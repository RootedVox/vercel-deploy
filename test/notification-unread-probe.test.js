import test from 'node:test';
import assert from 'node:assert/strict';
import { onRequestGet } from '../functions/api/notifications.js';

// Regression: the unread probe used to reuse the list query params after
// applyPage() had injected offset/cursor filters, so a user with unread
// notifications could be told they had none.
test('unread probe ignores page and cursor filters', async t => {
  const site = 'https://forum.example';
  const userId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const keys = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const jwk = await crypto.subtle.exportKey('jwk', keys.privateKey);
  const env = {
    AUTH_STORE: 'supabase', AUTH_STORE_SUPABASE_SECRET_KEY: 'sb_secret_mock',
    AUTH_ISSUER: 'https://auth.example', AUTH_CLIENT_ID: 'forum', AUTH_REDIRECT_URI: site + '/auth/callback',
    BUSINESS_SUPABASE_URL: 'https://db.example', BUSINESS_SUPABASE_PUBLISHABLE_KEY: 'pub',
    BUSINESS_SUPABASE_SIGNING_JWK: JSON.stringify({ ...jwk, kid: 'test' })
  };
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (input, init = {}) => {
    const { pathname, searchParams } = new URL(input);
    if (pathname.endsWith('/isa_auth_store')) return Response.json({ user_id: userId });
    assert.ok(pathname.endsWith('/business_notifications'), pathname);
    calls.push(searchParams);
    return Response.json([{ id: 1 }]);
  });

  const cursor = '2026-11-17T09:00:00.000Z|11111111-1111-4111-8111-111111111111';
  for (const query of [
    'exists=1&page=3&limit=10',
    'exists=1&page=3&cursor=' + encodeURIComponent(cursor),
    'exists=1&unread=1'
  ]) {
    const response = await onRequestGet({
      env,
      request: new Request(site + '/api/notifications?' + query, {
        headers: { Cookie: '__Secure-rv_session=test' }
      })
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { hasUnread: true });
  }

  assert.equal(calls.length, 3);
  for (const params of calls) {
    assert.equal(params.get('user_id'), 'eq.' + userId);
    assert.equal(params.get('read'), 'eq.false', 'probe must filter unread itself');
    assert.equal(params.get('limit'), '1');
    assert.equal(params.get('select'), 'id');
    assert.equal(params.has('offset'), false, 'no page offset in the unread probe');
    assert.equal(params.has('or'), false, 'no cursor filter in the unread probe');
  }
});

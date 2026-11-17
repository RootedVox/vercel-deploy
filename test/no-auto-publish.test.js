import test from 'node:test';
import assert from 'node:assert/strict';
import { onRequestPost } from '../functions/api/messages.js';

// A regression guard for the removed synchronous-review fallback. If that branch
// ever returns, this test fails: with the queue probe down and the model saying
// "safe", the old code wrote flag=1 straight from the signed-in user's request.
test('a post is always stored pending, even when the queue probe fails and the model says safe', async t => {
  const site = 'https://forum.example';
  const user = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const keys = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const jwk = await crypto.subtle.exportKey('jwk', keys.privateKey);
  const env = {
    AUTH_STORE: 'supabase',
    AUTH_STORE_SUPABASE_SECRET_KEY: 'sb_secret_mock',
    AUTH_ISSUER: 'https://auth.example',
    AUTH_CLIENT_ID: 'forum',
    AUTH_REDIRECT_URI: site + '/auth/callback',
    BUSINESS_SUPABASE_URL: 'https://db.example',
    BUSINESS_SUPABASE_PUBLISHABLE_KEY: 'pub',
    BUSINESS_SUPABASE_SIGNING_JWK: JSON.stringify({ ...jwk, kid: 'test' }),
    NVAPI_KEY: 'nvapi-mock',
    LEXICON_KV: { async get() { return '敏感词\n另一个词'; } }
  };
  let inserted = null, modelCalls = 0;
  t.mock.method(globalThis, 'fetch', async (input, init = {}) => {
    const url = new URL(input);
    const { pathname } = url;
    if (pathname.endsWith('/isa_auth_store')) return Response.json({ user_id: user });
    if (pathname.endsWith('/claim_forum_review')) {
      return new Response('{"code":"PGRST202"}', { status: 404 });
    }
    if (url.hostname === 'integrate.api.nvidia.com') {
      modelCalls++;
      return Response.json({ choices: [{ message: { content: 'user safety: safe' } }] });
    }
    if (pathname.endsWith('/messages') && init.method === 'POST') {
      inserted = JSON.parse(init.body);
      return Response.json([{ id: 'new' }]);
    }
    throw new Error('unexpected fetch: ' + input);
  });

  const response = await onRequestPost({
    env,
    request: new Request(site + '/api/messages', {
      method: 'POST',
      headers: { Origin: site, Cookie: '__Secure-rv_session=test' },
      body: JSON.stringify({ content: 'hello', anonymous: true })
    })
  });

  assert.equal(response.status, 201);
  assert.deepEqual(inserted, {
    business_user_id: user,
    username: '匿名用户',
    content: 'hello',
    zone: '校园生活',
    pic_url: null,
    contact_email: null,
    flag: 0,
    reply_to: null
  });
  assert.equal(modelCalls, 0, 'the site must not run synchronous AI review on the request path');
});

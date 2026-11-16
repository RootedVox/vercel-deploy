import test from 'node:test';
import assert from 'node:assert/strict';
import { onRequestGet } from '../functions/api/messages.js';

const env = { BUSINESS_SUPABASE_URL: 'https://db.test', BUSINESS_SUPABASE_PUBLISHABLE_KEY: 'pub', AUTH_STORE_SUPABASE_SECRET_KEY: 'sb_secret_fixture' };
const raw = 'https://db.test/storage/v1/object/public/message-pics/business/owner/image.png';
const get = query => onRequestGet({ env, request: new Request('https://forum.test/api/messages?' + query) });

test('both raw legacy feeds and migrated views expose only post-scoped anonymous image URLs', async t => {
  let url = raw;
  t.mock.method(globalThis, 'fetch', async () => Response.json([
    { id: 1, username:'匿名用户', pic_url:[url] }, { id: 2, username:'Auditor', pic_url:[raw] }
  ]));
  for (url of [raw, '/api/messages?media=1&slot=0']) {
    const { messages } = await (await get('limit=2')).json();
    assert.deepEqual(messages[0].pic_url, ['/api/messages?media=1&slot=0']);
    assert.deepEqual(messages[1].pic_url, [raw]);
  }
});

test('anonymous image reads recheck approval and proxy only image bytes from the forum bucket', async t => {
  let visible = true, object = raw, count = 0;
  t.mock.method(globalThis, 'fetch', async (input, init) => {
    const url = new URL(input);
    if (url.pathname === '/rest/v1/messages') {
      assert.equal(url.searchParams.get('id'), 'eq.1');
      assert.equal(url.searchParams.get('flag'), 'eq.1');
      assert.equal(url.searchParams.get('username'), 'eq.匿名用户');
      return Response.json(visible ? [{pic_url:[object]}] : []);
    }
    assert.equal(url.href, raw);
    assert.equal(init.redirect, 'error');
    assert.equal(init.headers, undefined);
    count++;
    return new Response(new Uint8Array([1,2]), { headers:{'Content-Type':'image/png', 'x-object-name':'private'} });
  });
  const shown = await get('media=1&slot=0');
  assert.equal(shown.status, 200);
  assert.equal(shown.headers.get('x-object-name'), null);
  assert.match(shown.headers.get('cache-control'), /no-store/);
  assert.deepEqual([...new Uint8Array(await shown.arrayBuffer())], [1,2]);
  visible = false;
  assert.equal((await get('media=1&slot=0')).status,404);
  visible = true;
  object = 'https://other.test/image.png';
  assert.equal((await get('media=1&slot=0')).status,404);
  assert.equal((await get('media=1&slot=1')).status,404);
  assert.equal(count,1);
});

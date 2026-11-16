import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { onRequestPost as upload } from '../functions/api/uploads.js';
import { onRequestGet as messages } from '../functions/api/messages.js';
import { cleanExpiredMedia } from '../functions/_lib/moderation-worker.js';

const uid = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const jpeg = size => new File([new Uint8Array([0xff, 0xd8, 0xff, ...new Uint8Array(size - 3)])], 'thumb.jpg', { type: 'image/jpeg' });
const photo = (byte = 1) => new File([new Uint8Array(2000).fill(byte)], 'photo.jpg', { type: 'image/jpeg' });

async function uploads(t, { failThumb = false } = {}) {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const jwk = await crypto.subtle.exportKey('jwk', pair.privateKey); jwk.kid = 'test';
  const env = { AUTH_ISSUER: 'https://auth.example.com', AUTH_CLIENT_ID: 'client', AUTH_REDIRECT_URI: 'https://site.example/auth/callback',
    BUSINESS_SUPABASE_URL: 'https://db.example', BUSINESS_SUPABASE_PUBLISHABLE_KEY: 'public', BUSINESS_SUPABASE_SIGNING_JWK: JSON.stringify(jwk),
    AUTH_DB: { prepare() { return { bind() { return { first: async () => ({ user_id: uid, last_seen_at: new Date().toISOString() }) }; } }; } } };
  const stored = new Map();
  t.mock.method(globalThis, 'fetch', async (input, init) => {
    const { pathname } = new URL(input);
    if (pathname === '/rest/v1/rpc/prepare_forum_media') return Response.json(true);
    const key = pathname.split('/message-pics/')[1];
    assert.ok(key, pathname);
    if (failThumb && key.endsWith('.thumb.jpg')) return new Response('down', { status: 500 });
    if (stored.has(key)) return Response.json({ error: 'Duplicate', message: 'The resource already exists' }, { status: 409 });
    stored.set(key, init.headers['Content-Type']);
    return Response.json({});
  });
  async function send(files, thumbs = []) {
    const form = new FormData();
    form.append('kind', 'message');
    files.forEach(file => form.append('files', file));
    thumbs.forEach((thumb, index) => thumb && form.append('thumb' + index, thumb));
    const response = await upload({ env, request: new Request('https://site.example/api/uploads', {
      method: 'POST', headers: { Origin: 'https://site.example', Cookie: '__Secure-rv_session=mock' }, body: form }) });
    return { status: response.status, body: await response.json() };
  }
  return { send, stored };
}

test('a new image is stored with its device-made thumbnail beside it', async t => {
  const h = await uploads(t);
  const { status, body } = await h.send([photo(1), photo(2)], [jpeg(5000), null]);
  assert.equal(status, 201);
  assert.equal(body.urls.length, 2);
  const [first, second] = body.urls.map(url => url.split('/message-pics/')[1]);
  assert.equal(h.stored.get(first.replace(/\.jpg$/, '.thumb.jpg')), 'image/jpeg');
  assert.ok(!h.stored.has(second.replace(/\.jpg$/, '.thumb.jpg')), 'no thumbnail was sent for the second image');
  assert.equal(h.stored.size, 3);
});

test('an image that already existed never gets a thumbnail added afterwards', async t => {
  // It may already be in an approved post, and a later thumbnail would skip review.
  const h = await uploads(t);
  await h.send([photo(1)]);
  assert.equal(h.stored.size, 1);
  const again = await h.send([photo(1)], [jpeg(5000)]);
  assert.equal(again.status, 201);
  assert.equal(h.stored.size, 1);
});

test('bad thumbnails are skipped and a failed thumbnail upload keeps the image', async t => {
  const h = await uploads(t);
  const png = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], 't.png', { type: 'image/png' });
  const fake = new File([new Uint8Array(100)], 't.jpg', { type: 'image/jpeg' });
  const { status } = await h.send([photo(1), photo(2), photo(3)], [png, jpeg(300 * 1024), fake]);
  assert.equal(status, 201);
  assert.equal(h.stored.size, 3);
  assert.ok([...h.stored.keys()].every(key => !key.includes('.thumb.')));
  t.mock.restoreAll();
  const failing = await uploads(t, { failThumb: true });
  const result = await failing.send([photo(4)], [jpeg(5000)]);
  assert.equal(result.status, 201);
  assert.equal(result.body.urls.length, 1);
});

test('pages show the thumbnail, open the original and fall back when there is none', () => {
  const listeners = {};
  const window = {};
  vm.runInNewContext(readFileSync(new URL('../forum-ui.js', import.meta.url), 'utf8'), {
    window, document: { addEventListener: (type, fn) => { listeners[type] = fn; } }
  });
  const { messageImage, thumbnailUrl } = window.ForumUI;
  const original = `https://db.example/storage/v1/object/public/message-pics/business/${uid}/${'a'.repeat(64)}.webp`;
  assert.equal(thumbnailUrl(original), original.replace('.webp', '.thumb.jpg'));
  assert.equal(thumbnailUrl('/api/messages?media=5&slot=1'), '/api/messages?media=5&slot=1&thumb=1');
  assert.equal(thumbnailUrl('https://db.example/storage/v1/object/public/message-pics/business/owner/image.png'), null);
  const html = messageImage(original, 'x 发布的图片');
  assert.match(html, new RegExp(`src="${original.replace('.webp', '.thumb.jpg').replace(/[.?]/g, '\\$&')}"`));
  assert.match(html, new RegExp(`data-full="${original.replace(/[.?]/g, '\\$&')}"`));

  const image = { dataset: { full: original }, src: 'thumb', getAttribute: () => 'thumb', matches: () => true };
  listeners.error({ target: image });
  assert.equal(image.src, original);
});

test('anonymous posts serve thumbnails through the media proxy', async t => {
  const env = { BUSINESS_SUPABASE_URL: 'https://db.test', BUSINESS_SUPABASE_PUBLISHABLE_KEY: 'pub', AUTH_STORE_SUPABASE_SECRET_KEY: 'sb_secret_fixture' };
  const raw = `https://db.test/storage/v1/object/public/message-pics/business/${uid}/${'b'.repeat(64)}.png`;
  const fetched = [];
  t.mock.method(globalThis, 'fetch', async input => {
    const url = new URL(input);
    if (url.pathname === '/rest/v1/messages') return Response.json([{ pic_url: [raw] }]);
    fetched.push(url.pathname);
    return url.pathname.endsWith('.thumb.jpg')
      ? new Response(new Uint8Array([1]), { headers: { 'Content-Type': 'image/jpeg' } })
      : new Response(new Uint8Array([1]), { headers: { 'Content-Type': 'image/png' } });
  });
  const get = query => messages({ env, request: new Request('https://forum.test/api/messages?' + query) });
  assert.equal((await get('media=1&slot=0&thumb=1')).headers.get('content-type'), 'image/jpeg');
  assert.equal((await get('media=1&slot=0')).headers.get('content-type'), 'image/png');
  assert.deepEqual(fetched, [new URL(raw).pathname.replace('.png', '.thumb.jpg'), new URL(raw).pathname]);
});

test('media cleanup removes thumbnails together with their images', async t => {
  const removed = [];
  const name = `business/${uid}/${'c'.repeat(64)}.webp`;
  t.mock.method(globalThis, 'fetch', async (input, init) => {
    const { pathname } = new URL(input);
    if (pathname.endsWith('/claim_forum_media_cleanup')) return Response.json([{ object_name: name }]);
    if (pathname === '/storage/v1/object/message-pics') { removed.push(...JSON.parse(init.body).prefixes); return Response.json([]); }
    if (pathname.endsWith('/finish_forum_media_cleanup')) {
      assert.deepEqual(JSON.parse(init.body).names, [name]);
      return Response.json(null);
    }
    throw new Error('unexpected ' + pathname);
  });
  await cleanExpiredMedia({ BUSINESS_SUPABASE_URL: 'https://db.test', AUTH_STORE_SUPABASE_SECRET_KEY: 'sb_secret_x' });
  assert.deepEqual(removed, [name, name.replace('.webp', '.thumb.jpg')]);
});

test('reviewers see the thumbnail next to the original', () => {
  const ui = readFileSync(new URL('../forum-ui.js', import.meta.url), 'utf8');
  const checker = readFileSync(new URL('../checker-ui.js', import.meta.url), 'utf8');
  // Both pages must find the same thumbnail, or a reviewer could miss what the feed shows.
  const pattern = /\/\\\/storage\\\/v1\\\/object\\\/public\\\/message-pics\\\/business\\\/\[0-9a-f-\]\+\\\/\[0-9a-f\]\{64\}\\\.\(\?:png\|jpg\|gif\|webp\)\$\//;
  assert.match(ui, pattern);
  assert.match(checker, pattern);
  assert.match(checker, /data-thumb/);
});

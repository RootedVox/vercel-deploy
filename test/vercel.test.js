import test from 'node:test';
import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import { createVercelFunction } from '../vercel/adapter.js';

const frontend = 'https://rv.celestivast.com';
await import('../scripts/build-vercel.mjs');

test('Vercel adapter dispatches every HTTP method and defaults to the Supabase auth store', async () => {
  const fn = createVercelFunction({
    async onRequestPatch({ env }) {
      return Response.json({ store: env.AUTH_STORE });
    }
  }, {
    route: '/api/profile',
    environment: () => ({ BUSINESS_FRONTEND_URL: frontend })
  });

  const response = await fn.fetch(new Request('https://rv-vc.celestivast.com/api/profile', {
    method: 'PATCH',
    headers: { Origin: frontend }
  }));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { store: 'supabase' });
  assert.equal(response.headers.get('Access-Control-Allow-Origin'), frontend);
  assert.equal(response.headers.get('Access-Control-Allow-Credentials'), 'true');
});

test('Vercel preflight accepts the real frontend and rejects unrelated origins', async () => {
  const fn = createVercelFunction({}, {
    route: '/api/messages',
    environment: () => ({ BUSINESS_FRONTEND_URL: frontend })
  });
  const allowed = await fn.fetch(new Request('https://rv-vc.celestivast.com/api/messages', {
    method: 'OPTIONS', headers: { Origin: frontend }
  }));
  assert.equal(allowed.status, 204);
  assert.match(allowed.headers.get('Access-Control-Allow-Methods'), /PATCH/);

  const rejected = await fn.fetch(new Request('https://rv-vc.celestivast.com/api/messages', {
    method: 'OPTIONS', headers: { Origin: 'https://evil.example' }
  }));
  assert.equal(rejected.status, 403);
  assert.equal(rejected.headers.get('Access-Control-Allow-Origin'), null);
});

test('Vercel callback returns the browser to the primary frontend without leaking tokens', async () => {
  const fn = createVercelFunction({
    async onRequestGet() {
      return new Response(null, { status: 303, headers: { Location: '/messages?login=ok' } });
    }
  }, {
    route: '/auth/callback',
    environment: () => ({ BUSINESS_FRONTEND_URL: frontend })
  });
  const response = await fn.fetch(new Request('https://rv-vc.celestivast.com/auth/callback'));
  assert.equal(response.headers.get('Location'), `${frontend}/messages?login=ok`);
});

test('Vercel build output contains public pages but excludes server source and configuration', async () => {
  await access(new URL('../vercel-public/index.html', import.meta.url));
  await access(new URL('../vercel-public/images/logo.png', import.meta.url));
  await assert.rejects(access(new URL('../vercel-public/functions/_lib/config.js', import.meta.url)));
  await assert.rejects(access(new URL('../vercel-public/vercel.json', import.meta.url)));
  const page = await readFile(new URL('../vercel-public/messages.html', import.meta.url), 'utf8');
  assert.match(page, /id="openProfile">个人资料/);
});


test('Vercel output includes the lazy-loaded editor and its local Cropper assets', async () => {
  for (const path of ['avatar-editor.js', 'avatar-editor.css', 'vendor/cropper.min.js', 'vendor/cropper.min.css', 'vendor/Cropper-LICENSE', 'vendor/webp/webp_enc.js', 'vendor/webp/webp_enc.wasm', 'vendor/webp/LICENSE-libwebp.md']) {
    assert.deepEqual(await readFile(new URL('../vercel-public/' + path, import.meta.url)), await readFile(new URL('../' + path, import.meta.url)), path);
  }
});

test('Vercel sends the same security headers as the Cloudflare _headers file', async () => {
  const vercel = JSON.parse(await readFile(new URL('../vercel.json', import.meta.url), 'utf8'));
  const sent = Object.fromEntries(vercel.headers.find(rule => rule.source === '/(.*)').headers.map(h => [h.key, h.value]));
  const cloudflare = (await readFile(new URL('../_headers', import.meta.url), 'utf8')).split('\n/*.html')[0];
  for (const name of ['Referrer-Policy', 'Permissions-Policy', 'Content-Security-Policy', 'Strict-Transport-Security', 'X-Content-Type-Options', 'X-Frame-Options']) {
    const expected = cloudflare.match(new RegExp(`^  ${name}: (.+)$`, 'm'))?.[1];
    assert.ok(expected, name);
    assert.equal(sent[name], expected, name);
  }
});

// Vercel serves static files with max-age=0, so every page view asked again for each
// script and stylesheet. Pages load them as ?v=<content hash> (sync-asset-versions.mjs):
// such a URL never changes its content and may be kept for good. A request without
// ?v= gets no rule and is still revalidated.
test('versioned scripts and styles are cached for good, unversioned ones are not', async () => {
  const vercel = JSON.parse(await readFile(new URL('../vercel.json', import.meta.url), 'utf8'));
  const rule = vercel.headers.find(entry => entry.headers.some(h => h.key === 'Cache-Control' && h.value.includes('immutable') && h.value.includes('31536000')));
  assert.deepEqual(rule.has, [{ type: 'query', key: 'v' }]);
  const pattern = new RegExp('^' + rule.source + '$');
  for (const path of ['/messages.js', '/common.css', '/vendor/webp/webp_enc.js']) assert.match(path, pattern);
  for (const path of ['/messages', '/api/messages', '/auth/session', '/images/logo.png']) assert.doesNotMatch(path, pattern);
  const images = vercel.headers.find(entry => entry.source === '/images/(.*)');
  assert.match(images.headers[0].value, /max-age=604800/);
});

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
  for (const path of ['avatar-editor.js', 'avatar-editor.css', 'vendor/cropper.min.js', 'vendor/cropper.min.css', 'vendor/Cropper-LICENSE']) {
    assert.deepEqual(await readFile(new URL('../vercel-public/' + path, import.meta.url)), await readFile(new URL('../' + path, import.meta.url)), path);
  }
});

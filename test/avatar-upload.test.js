import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { onRequestPost as upload } from '../functions/api/uploads.js';
import { validateAvatar } from '../functions/_lib/avatar.js';
const pixels = await readFile(new URL('./fixtures/avatar.png', import.meta.url));
const uid='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
async function fixture(t, items = [], conflictStatus = 409, storageReply) {
  const pair=await crypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},true,['sign','verify']);
  const jwk=await crypto.subtle.exportKey('jwk',pair.privateKey);jwk.kid='test-key';
  const env={AUTH_ISSUER:'https://auth.example.com',AUTH_CLIENT_ID:'client',AUTH_REDIRECT_URI:'https://site.example/auth/callback',BUSINESS_SUPABASE_URL:'https://db.example',BUSINESS_SUPABASE_PUBLISHABLE_KEY:'public',BUSINESS_SUPABASE_SIGNING_JWK:JSON.stringify(jwk),AUTH_DB:{prepare(){return {bind(){return {first:async()=>({user_id:uid,identity_provider:'https://auth.example.com',identity_subject:'user',last_seen_at:new Date().toISOString()})}}}}}};
  const objects = new Map(), deletes = [], current = `https://db.example/storage/v1/object/public/avatars/business/${uid}.old.png`;
  const original = globalThis.fetch;
  globalThis.fetch = async (url,init) => {
    const u = new URL(url);
    const override = storageReply?.(u.pathname, init);
    if (override) return override;
    if (u.pathname === '/storage/v1/object/list/avatars') return Response.json(items);
    if (u.pathname === '/storage/v1/object/avatars') { deletes.push(...JSON.parse(init.body).prefixes); return Response.json([]); }
    if (u.pathname.startsWith('/storage/v1/object/avatars/')) {
      const key = u.pathname.split('/avatars/')[1]; assert.equal(init.headers['x-upsert'], 'false');
      if (objects.has(key)) return Response.json({ error: 'Duplicate', message: 'The resource already exists' },{status:conflictStatus}); objects.set(key, await init.body.arrayBuffer()); return Response.json({});
    }
    if (u.pathname === '/rest/v1/business_users') return Response.json([{avatar_url:current}]);
    throw Error('unexpected request');
  };
  t.after(()=>{globalThis.fetch=original;});
  async function send(file = new File([pixels],'avatar.png',{type:'image/png'})) {
    const form=new FormData();form.append('kind','avatar');form.append('files',file);
    return upload({request:new Request('https://site.example/api/uploads',{method:'POST',headers:{Origin:'https://site.example',Cookie:'__Secure-rv_session=mock'},body:form}),env});
  }
  return {send,objects,deletes,current};
}
test('identical avatar retries reuse one immutable storage object', async t => {
  const h=await fixture(t);const a=await h.send(), b=await h.send();
  assert.equal(a.status,201);assert.equal(b.status,201);assert.deepEqual(await a.json(),await b.json());assert.equal(h.objects.size,1);
});
test('cleanup keeps current/recent/foreign avatars and only removes expired unreferenced objects', async t => {
  const old='2000-01-01T00:00:00.000Z';
  const h=await fixture(t,[{name:uid+'.old.png',created_at:old},{name:uid+'.retired.png',created_at:old},{name:uid+'.new.png',created_at:new Date().toISOString()},{name:'someone-else.old.png',created_at:old}]);
  assert.equal((await h.send()).status,201);assert.deepEqual(h.deletes,['business/'+uid+'.retired.png']);
});
test('quota refuses new uploads rather than growing storage without bound', async t => {
  const h=await fixture(t,Array.from({length:64},(_,i)=>({name:uid+'.'+i+'.png',created_at:new Date().toISOString()})));
  assert.equal((await h.send()).status,429);assert.equal(h.objects.size,0);
});
test('declared MIME cannot turn non-images or corrupt PNGs into an avatar', async t => {
  const h=await fixture(t);
  assert.equal((await h.send(new File(['not an image'],'bad.png',{type:'image/png'}))).status,400);
  const corrupt = Buffer.from(pixels);corrupt[50]^=1;
  assert.equal((await h.send(new File([corrupt],'bad.png',{type:'image/png'}))).status,400);
  assert.equal((await h.send(new File([],'empty.png',{type:'image/png'}))).status,400);
  assert.equal(h.objects.size,0);
});
test('the server validates the entire PNG payload and exact 256px dimensions', async () => {
  assert.match(await validateAvatar(new File([pixels],'avatar.png',{type:'image/png'})),/^[a-f0-9]{64}$/);
  await assert.rejects(validateAvatar(new File([pixels.subarray(0,pixels.length-12)],'truncated.png',{type:'image/png'})));
  await assert.rejects(validateAvatar(new File([pixels],'fake.webp',{type:'image/webp'})));
});


test('legacy 400 duplicate responses also preserve idempotent retries', async t => {
  const h=await fixture(t,[],400);
  assert.equal((await h.send()).status,201);assert.equal((await h.send()).status,201);assert.equal(h.objects.size,1);
});

test('an expired avatar cleanup failure only blocks an upload at quota', async t => {
  const old = {name: uid + '.old-unused.png', created_at: '2000-01-01'};
  const failDelete = path => path === '/storage/v1/object/avatars'
    ? Response.json({code:'AccessDenied'}, {status:403}) : null;
  const h = await fixture(t, [old], 409, failDelete);
  assert.equal((await h.send()).status, 201);
});

test('a silent zero-row cleanup cannot free quota', async t => {
  const items = Array.from({length:64}, (_, i) => ({name:uid+'.'+i+'.png',created_at:'2000-01-01'}));
  const h = await fixture(t, items);
  const result = await h.send();
  assert.equal(result.status,429);
  assert.equal(h.objects.size,0);
});

test('a non-duplicate conflict never publishes a nonexistent upload', async t => {
  const h = await fixture(t, [], 409, path => path.startsWith('/storage/v1/object/avatars/')
    ? Response.json({code:'ResourceLocked'}, {status:409}) : null);
  const result = await h.send();
  assert.equal(result.status,503);
  assert.equal((await result.json()).error,'avatar_storage_unavailable');
});

test('the upload API distinguishes a missing bucket from lack of write permission', async t => {
  for (const [code, expected] of [['NoSuchBucket','avatar_bucket_missing'], ['AccessDenied','avatar_storage_denied']]) {
    await t.test(code, async t => {
      const h = await fixture(t, [], 409, path => path.startsWith('/storage/v1/object/avatars/')
        ? Response.json({code}, {status:400}) : null);
      const result = await h.send();
      assert.equal(result.status,503);
      assert.deepEqual(await result.json(),{error:expected});
    });
  }
});

test('Storage errors reported inside an HTTP 400 body are classified by their real cause', async t => {
  for (const [body, expected] of [
    [{statusCode:'404', error:'Bucket not found', message:'Bucket not found'}, 'avatar_bucket_missing'],
    [{statusCode:'403', error:'Unauthorized', message:'new row violates row-level security policy'}, 'avatar_storage_denied'],
    [{statusCode:'403', error:'Unauthorized', message:'invalid signature'}, 'avatar_storage_auth_failed'],
    [{statusCode:'400', error:'InvalidJWT', message:'jwt expired'}, 'avatar_storage_auth_failed'],
    [{statusCode:'500', error:'internal', message:'boom'}, 'avatar_storage_unavailable']
  ]) {
    await t.test(body.message, async t => {
      const h = await fixture(t, [], 409, path => path.startsWith('/storage/v1/object/avatars/')
        ? Response.json(body, {status:400}) : null);
      const result = await h.send();
      assert.equal(result.status,503);
      assert.deepEqual(await result.json(),{error:expected});
    });
  }
});

test('a Storage listing failure inside an HTTP 400 body names the missing bucket', async t => {
  const h = await fixture(t, [], 409, path => path.startsWith('/storage/v1/object/list/avatars')
    ? Response.json({statusCode:'404', error:'Bucket not found', message:'Bucket not found'}, {status:400}) : null);
  const result = await h.send();
  assert.equal(result.status,503);
  assert.deepEqual(await result.json(),{error:'avatar_bucket_missing'});
});

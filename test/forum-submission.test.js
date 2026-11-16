import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { onRequestPost } from '../functions/api/messages.js';

test('tab drafts isolate owners and targets, and retain the receipt only for the same intent', () => {
  const storage = new Map();
  const context = { crypto, window: {}, sessionStorage: {
    getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value),
    removeItem: key => storage.delete(key)
  } };
  function open(owner) {
    vm.runInNewContext(readFileSync(new URL('../forum-drafts.js', import.meta.url), 'utf8'), context);
    const draft = context.window.ForumDrafts;
    draft.bind(owner);
    return draft;
  }
  const body = { content: 'text', anonymous: true, imageUrls: ['stored'] };
  let d = open('a');
  d.save('reply-1', { text: 'text', anonymous: true, attachments: ['stored'] });
  const id = d.submission('reply-1', body);
  d = open('a');
  assert.equal(d.get('reply-1').anonymous, true);
  assert.deepEqual([...d.get('reply-1').attachments], ['stored']);
  assert.equal(d.submission('reply-1', body), id);
  assert.ok(!d.get('reply-2'));
  assert.notEqual(d.submission('reply-1', { ...body, content: 'edited' }), id);
  d.clear('reply-1');
  assert.notEqual(d.submission('reply-1', body), id);
  assert.ok(!open('b').get('reply-1'));
  assert.ok(!open('a').get('reply-1'));
});

test('lost response, concurrent submissions, edited payload, separate accounts and intentional repost', async t => {
  let user = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const site = 'https://forum.example', rows = new Map();
  const keys = await crypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'}, true, ['sign','verify']);
  const jwk = await crypto.subtle.exportKey('jwk', keys.privateKey);
  const env = { AUTH_STORE: 'supabase', AUTH_STORE_SUPABASE_SECRET_KEY: 'sb_secret_mock',
    AUTH_ISSUER:'https://auth.example', AUTH_CLIENT_ID:'forum', AUTH_REDIRECT_URI:site+'/auth/callback',
    BUSINESS_SUPABASE_URL:'https://db.example', BUSINESS_SUPABASE_PUBLISHABLE_KEY:'pub',
    BUSINESS_SUPABASE_SIGNING_JWK:JSON.stringify({...jwk,kid:'test'}) };
  let lose = true;
  t.mock.method(globalThis, 'fetch', async (input, init) => {
    const { pathname, searchParams } = new URL(input);
    if (pathname.endsWith('/isa_auth_store')) return Response.json({user_id:user});
    if (pathname.endsWith('/claim_forum_review')) return Response.json(null);
    if (pathname.endsWith('/approved_messages_public')) return Response.json([{id:'1'}]);
    assert.ok(pathname.endsWith('/messages'));
    if (init.method === 'POST') {
      const row = JSON.parse(init.body);
      if (rows.has(row.id)) return Response.json({code:'23505'}, {status:409});
      if (row.is_featured && row.content === 'over quota') return Response.json({code:'P0001',message:'featured_daily_limit'}, {status:400});
      rows.set(row.id,row);
      if (lose) { lose = false; throw new Error('response lost'); }
      return Response.json([{id:row.id}]);
    }
    const saved = rows.get(searchParams.get('id').slice(3));
    assert.equal(searchParams.get('business_user_id'), 'eq.' + saved.business_user_id);
    return Response.json([saved]);
  });
  const receipt = crypto.randomUUID();
  async function post(id = receipt, text = 'same', extras = {}) {
    const request = new Request(site + '/api/messages', { method:'POST',
      headers:{Origin:site,Cookie:'__Secure-rv_session=test'},
      body:JSON.stringify({content:text,anonymous:true,submissionId:id,...extras}) });
    return onRequestPost({ request,env });
  }
  assert.equal((await post()).status,503);
  assert.equal((await post(receipt,'same',{retry:true})).status,200);
  assert.equal(rows.size,1);
  assert.equal((await post(receipt,'different')).status,409);
  const newId=crypto.randomUUID();
  const pair=await Promise.all([post(newId,'reply',{replyTo:'1'}), post(newId,'reply',{replyTo:'1'})]);
  assert.deepEqual(pair.map(r=>r.status).sort(),[200,201]);
  assert.equal(rows.size,2);
  assert.equal((await post(crypto.randomUUID())).status,201);
  user='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  assert.equal((await post()).status,201);
  assert.equal(rows.size,4);
  assert.equal((await post(crypto.randomUUID(),'featured',{featured:true})).status,201);
  assert.ok([...rows.values()].some(row => row.is_featured && row.flag === 0 && row.reply_to === null));
  assert.equal((await post(crypto.randomUUID(),'over quota',{featured:true})).status,429);
  assert.equal((await post(crypto.randomUUID(),'featured reply',{featured:true,replyTo:'1'})).status,400);
  const long = await post(crypto.randomUUID(), '文'.repeat(1001));
  assert.equal(long.status, 400);
  assert.equal((await long.json()).error, 'content_too_long');
  assert.equal((await post(crypto.randomUUID(), '文'.repeat(1000))).status, 201);
  assert.equal((await post('broken')).status,400);
});

test('a reply reads the profile and its target together and reports failures in the old order', { timeout: 2000 }, async t => {
  const site = 'https://forum.example';
  const keys = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const jwk = await crypto.subtle.exportKey('jwk', keys.privateKey);
  const env = { AUTH_STORE: 'supabase', AUTH_STORE_SUPABASE_SECRET_KEY: 'sb_secret_mock',
    AUTH_ISSUER: 'https://auth.example', AUTH_CLIENT_ID: 'forum', AUTH_REDIRECT_URI: site + '/auth/callback',
    BUSINESS_SUPABASE_URL: 'https://db.example', BUSINESS_SUPABASE_PUBLISHABLE_KEY: 'pub',
    BUSINESS_SUPABASE_SIGNING_JWK: JSON.stringify({ ...jwk, kid: 'test' }) };
  let profile, target, firstRead, inserts = 0;
  t.mock.method(globalThis, 'fetch', async (input, init = {}) => {
    const { pathname } = new URL(input);
    if (pathname.endsWith('/isa_auth_store')) return Response.json({ user_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' });
    if (pathname.endsWith('/claim_forum_review')) return Response.json(null);
    if (pathname.endsWith('/messages') && init.method === 'POST') { inserts++; return Response.json([{ id: 'new' }]); }
    const reply = pathname.endsWith('/approved_messages_public');
    assert.ok(reply || pathname.endsWith('/business_users'));
    if (firstRead) {
      const release = firstRead;
      firstRead = null;
      release();
    } else {
      await new Promise(resolve => { firstRead = resolve; });
    }
    const answer = reply ? target : profile;
    return answer === 'fail' ? Response.json({ code: 'XX000' }, { status: 500 }) : Response.json(answer);
  });
  async function post() {
    const response = await onRequestPost({ env, request: new Request(site + '/api/messages', {
      method: 'POST', headers: { Origin: site, Cookie: '__Secure-rv_session=test' },
      body: JSON.stringify({ content: 'reply', anonymous: false, replyTo: '1' })
    }) });
    return [response.status, (await response.json()).error];
  }
  [profile, target] = [[{ nickname: 'n' }], []];
  assert.deepEqual(await post(), [404, 'reply_target_not_found']);
  [profile, target] = ['fail', []];
  assert.deepEqual(await post(), [503, 'profile_unavailable']);
  [profile, target] = [[{ nickname: 'n' }], 'fail'];
  assert.deepEqual(await post(), [503, 'message_save_failed']);
  assert.equal(inserts, 0);
  [profile, target] = [[{ nickname: 'n' }], [{ id: '1' }]];
  assert.deepEqual(await post(), [201, undefined]);
  assert.equal(inserts, 1);
});

test('an edit during upload or submission retains the newer draft', () => {
  const context = { window: {}, crypto, sessionStorage: { getItem() {}, setItem() {}, removeItem() {} } };
  vm.runInNewContext(readFileSync(new URL('../forum-drafts.js', import.meta.url), 'utf8'), context);
  const drafts = context.window.ForumDrafts;
  drafts.bind('account');
  drafts.save('post', { text: 'first' });
  const original = drafts.get('post');
  const payload = { content: 'first', anonymous: false, imageUrls: [] };
  drafts.save('post', { text: 'updated while uploading' });
  assert.equal(drafts.prepare('post', original, { ...payload }), null);
  assert.equal(drafts.get('post').text, 'updated while uploading');
  const current = drafts.get('post');
  const submitted = drafts.prepare('post', current, { ...payload, content: current.text });
  assert.equal(drafts.get('post'), submitted);
  drafts.save('post', { text: 'updated while posting' });
  assert.notEqual(drafts.get('post'), submitted);
});

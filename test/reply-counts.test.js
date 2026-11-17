import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const env = { BUSINESS_SUPABASE_URL: 'https://db.test', BUSINESS_SUPABASE_PUBLISHABLE_KEY: 'pub' };
const a = '11111111-1111-4111-8111-111111111111', b = '22222222-2222-4222-8222-222222222222';
const rows = [{ id: a, username: 'A', content: 'x', created_at: '2026-11-16T00:00:02Z' }, { id: b, username: 'B', content: 'y', created_at: '2026-11-16T00:00:01Z' }];

// A fresh module per test: the "not migrated" state is remembered per server instance.
const load = () => import('../functions/api/messages.js?' + Math.random()).then(module => module.onRequestGet);
const get = (handler, query = 'limit=20') => handler({ env, request: new Request('https://forum.test/api/messages?' + query) });

test('the feed carries each post reply count from one database read', async t => {
  const asked = [];
  t.mock.method(globalThis, 'fetch', async (input, init) => {
    const { pathname } = new URL(input);
    if (pathname.endsWith('/public_forum_feed')) return Response.json(rows);
    assert.ok(pathname.endsWith('/public_forum_reply_counts'));
    asked.push(JSON.parse(init.body).p_ids);
    return Response.json([{ id: a, replies: 4 }, { id: b, replies: 0 }]);
  });
  const { messages } = await (await get(await load())).json();
  assert.deepEqual(asked, [[a, b]]);
  assert.deepEqual(messages.map(m => m.reply_count), [4, 0]);
});

test('before the migration the feed works without counts and stops asking for a while', async t => {
  let tries = 0;
  t.mock.method(globalThis, 'fetch', async input => {
    const { pathname } = new URL(input);
    if (pathname.endsWith('/public_forum_feed')) return Response.json(rows);
    tries++;
    return Response.json({ code: 'PGRST202', message: 'not found' }, { status: 404 });
  });
  const handler = await load();
  for (let i = 0; i < 3; i++) {
    const response = await get(handler);
    assert.equal(response.status, 200);
    assert.ok((await response.json()).messages.every(m => !('reply_count' in m)));
  }
  assert.equal(tries, 1);
});

test('a failing count read never breaks the feed', async t => {
  t.mock.method(globalThis, 'fetch', async input => new URL(input).pathname.endsWith('/public_forum_feed')
    ? Response.json(rows) : new Response('down', { status: 500 }));
  const response = await get(await load());
  assert.equal(response.status, 200);
  assert.equal((await response.json()).messages.length, 2);
});

test('the count migration follows the thread visibility rules', () => {
  const sql = readFileSync(new URL('../supabase/20261116_forum_reply_counts.sql', import.meta.url), 'utf8');
  assert.match(sql, /with recursive/);
  assert.match(sql, /m\.flag = 1 and m\.reply_to is null/);
  assert.match(sql, /r\.reply_to = t\.id and r\.flag = 1/);
  assert.match(sql, /p_ids\[1:50\]/);
  assert.match(sql, /grant execute on function public\.public_forum_reply_counts\(uuid\[\]\) to anon, authenticated/);
});

test('featured-first pagination crosses groups without losing the normal-post cursor', async t => {
  const featured = { ...rows[0], is_featured: true };
  const normal = { ...rows[1], is_featured: false };
  const groups = [];
  t.mock.method(globalThis, 'fetch', async input => {
    const { pathname, searchParams } = new URL(input);
    if (pathname.endsWith('/public_forum_reply_counts')) return Response.json([]);
    const group = searchParams.get('is_featured');
    groups.push([group, searchParams.has('or')]);
    assert.equal(searchParams.get('order'), 'created_at.asc,id.asc');
    const row = group === 'eq.true' ? featured : normal;
    return Response.json(searchParams.has('or') ? [] : [row]);
  });
  const handler = await load();
  const first = await (await get(handler, 'featuredFirst=1&sort=oldest&limit=1')).json();
  assert.deepEqual(first.messages.map(row => row.id), [featured.id]);
  assert.match(first.nextCursor, /^f:/);
  const second = await (await get(handler, 'featuredFirst=1&sort=oldest&limit=1&cursor=' + encodeURIComponent(first.nextCursor))).json();
  assert.deepEqual(second.messages.map(row => row.id), [normal.id]);
  assert.equal(second.hasMore, false);
  assert.deepEqual(groups, [['eq.true', false], ['eq.false', false], ['eq.true', true], ['eq.false', false]]);
});

test('featured cursors need a position after the section prefix', async () => {
  const handler = await load();
  for (const cursor of ['f:', 'n:']) {
    const response = await get(handler, 'featuredFirst=1&cursor=' + cursor);
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error, 'invalid_cursor');
  }
});

test('featured searches use a literal case-insensitive pattern', async t => {
  const filters = [];
  t.mock.method(globalThis, 'fetch', async input => {
    filters.push(new URL(input).searchParams.get('content'));
    return Response.json([]);
  });
  await get(await load(), 'featuredFirst=1&search=' + encodeURIComponent('A(B)*_50%'));
  assert.deepEqual(filters, Array(2).fill(String.raw`imatch.A\(B\)\*_50%`));
});

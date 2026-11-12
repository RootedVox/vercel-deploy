import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { onRequestGet as listMessagesApi } from '../functions/api/messages.js';

const source = await readFile(new URL('../public-data.js', import.meta.url), 'utf8');

function loadClient(fetch) {
  const window = {};
  vm.runInNewContext(source, { window, fetch, URLSearchParams });
  return window.RootedVoxPublicData;
}

test('public messages use the site API directly', async () => {
  const requests = [];
  const client = loadClient(async (url, init) => {
    requests.push({ url: String(url), init });
    return {
      ok: true,
      async json() {
        return { messages: [{ id: 'message-1' }], hasMore: false, page: 2 };
      }
    };
  });

  const result = await client.listMessages({ page: 2, limit: 10, sort: 'oldest', zone: '学习互助', search: '数学' });

  assert.deepEqual(result, { messages: [{ id: 'message-1' }], hasMore: false, page: 2 });
  assert.equal(requests.length, 1);
  assert.match(requests[0].url, /^\/api\/messages\?/);
  const apiUrl = new URL(`https://business.example${requests[0].url}`);
  assert.equal(apiUrl.searchParams.get('page'), '2');
  assert.equal(apiUrl.searchParams.get('limit'), '10');
  assert.equal(apiUrl.searchParams.get('sort'), 'oldest');
  assert.equal(apiUrl.searchParams.get('zone'), '学习互助');
  assert.equal(apiUrl.searchParams.get('search'), '数学');
  assert.equal(requests[0].init.cache, 'no-store');
});

test('thread reads use the site API directly', async () => {
  const id = '5726b173-8f21-4aaf-b828-410635bfe6b8';
  const requests = [];
  const client = loadClient(async url => {
    requests.push(String(url));
    return { ok: true, async json() { return { messages: [{ id }] }; } };
  });

  assert.deepEqual(await client.getThread(id), [{ id }]);
  assert.equal(requests.length, 1);
  assert.equal(new URL(`https://business.example${requests[0]}`).searchParams.get('thread'), id);
});

test('the same-origin API accepts the UUID identifiers used by the messages table', async t => {
  const id = '5726b173-8f21-4aaf-b828-410635bfe6b8';
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async input => {
    const url = new URL(String(input));
    assert.equal(url.pathname, '/rest/v1/approved_messages_public');
    assert.equal(url.searchParams.get('select'), 'id,username,content,zone,pic_url,created_at,reply_to,avatar_url,is_official');
    return Response.json([{ id, username: 'ISAer', content: '测试', zone: '校园生活', pic_url: null, created_at: new Date().toISOString(), reply_to: null, avatar_url: null }]);
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  const response = await listMessagesApi({
    request: new Request(`https://business.example/api/messages?thread=${id}`),
    env: {
      BUSINESS_SUPABASE_URL: 'https://business.supabase.co',
      BUSINESS_SUPABASE_PUBLISHABLE_KEY: 'publishable-test'
    }
  });

  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).messages.map(({ id, zone }) => ({ id, zone })), [{ id, zone: '日常分享' }]);
});

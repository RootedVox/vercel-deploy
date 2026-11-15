(() => {
  async function readMessages(params, signal) {
    const response = await (window.request || fetch)(`/api/messages?${params}`, {
      headers: { Accept: 'application/json' },
      cache: 'no-store',
      signal
    });
    if (params.has('thread') && response.status === 404) return { messages: [] };
    if (response.status === 409 && params.has('thread')) throw new Error('stale_cursor');
    if (!response.ok) throw new Error('public_data_unavailable');
    return response.json();
  }

  async function listMessages({ page = 0, limit = 20, sort = 'newest', search = '', zone = 'all', cursor, signal } = {}) {
    const params = new URLSearchParams({ page, limit, sort });
    if (cursor) params.set('cursor', cursor);
    if (zone !== 'all') params.set('zone', zone);
    if (search.trim()) params.set('search', search.trim());
    return readMessages(params, signal);
  }

  async function getThread(id, signal) {
    const result = await readMessages(new URLSearchParams({ thread: String(id) }), signal);
    return result.messages || [];
  }

  function threadPage(id, after, reply) {
    const params = new URLSearchParams({ thread: id, batch: '21' });
    if (reply) params.set('reply', reply);
    if (after) params.set('after', after);
    return readMessages(params);
  }

  window.RootedVoxPublicData = { listMessages, getThread, threadPage, overview: () => readMessages(new URLSearchParams({ overview: '1' })) };
})();

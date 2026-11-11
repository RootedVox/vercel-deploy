(() => {
  async function readMessages(params, signal) {
    const response = await (window.request || fetch)(`/api/messages?${params}`, {
      headers: { Accept: 'application/json' },
      cache: 'no-store',
      signal
    });
    if (!response.ok) throw new Error('public_data_unavailable');
    return response.json();
  }

  async function listMessages({ page = 0, limit = 20, sort = 'newest', search = '', zone = 'all', signal } = {}) {
    const params = new URLSearchParams({ page, limit, sort });
    if (zone !== 'all') params.set('zone', zone);
    if (search.trim()) params.set('search', search.trim());
    return readMessages(params, signal);
  }

  async function getThread(id, signal) {
    const result = await readMessages(new URLSearchParams({ thread: String(id) }), signal);
    return result.messages || [];
  }

  window.RootedVoxPublicData = { listMessages, getThread };
})();

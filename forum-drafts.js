// Keep text and retry receipts in this tab. Bind them only after the session identifies its owner.
(() => {
  const key = 'rootedvox.forum.drafts.v1';
  let owner = null;
  let entries = {};
  function persist() {
    try {
      if (Object.keys(entries).length) sessionStorage.setItem(key, JSON.stringify({ owner, entries }));
      else sessionStorage.removeItem(key);
    } catch { /* Private browsing and quota limits can leave only the in-memory draft. */ }
  }
  function bind(userId) {
    if (!userId || userId === owner) return;
    owner = userId;
    entries = {};
    try {
      const saved = JSON.parse(sessionStorage.getItem(key));
      if (saved?.owner === owner && saved.entries) entries = saved.entries;
      else sessionStorage.removeItem(key);
    } catch {}
  }
  function get(target) { return owner ? entries[target] : null; }
  function clear(target) {
    delete entries[target];
    persist();
  }
  function save(target, fields) {
    if (!owner) return;
    const next = { ...get(target), ...fields };
    if (!next.text && !next.attachments?.length) return clear(target);
    entries[target] = next;
    persist();
  }
  function submission(target, body) {
    const signature = JSON.stringify(body);
    const previous = get(target);
    if (previous?.signature === signature) return previous.submissionId;
    const submissionId = crypto.randomUUID();
    save(target, { text: body.content, signature, submissionId });
    return submissionId;
  }
  function logout() { entries = {}; owner = null; persist(); }
  window.ForumDrafts = { bind, get, save, clear, submission, logout };
})();

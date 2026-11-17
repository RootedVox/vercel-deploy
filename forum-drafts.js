// Keep text and retry receipts in this tab. Bind them only after the session identifies its owner.
(() => {
  const key = 'rootedvox.forum.drafts.v1';
  let owner = null;
  let entries = {};
  const generations = new Map();
  function persist() {
    try {
      if (Object.keys(entries).length) sessionStorage.setItem(key, JSON.stringify({ owner, entries }));
      else sessionStorage.removeItem(key);
    } catch { /* Private browsing and quota limits can leave only the in-memory draft. */ }
  }
  function bind(userId) {
    if (!userId || userId === owner) return;
    generations.clear();
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
    generations.delete(target);
    delete entries[target];
    persist();
  }
  function save(target, fields) {
    if (!owner) return;
    const next = { ...generations.get(target)?.receipt, ...get(target), ...fields };
    if (!next.text && !next.attachments?.length) {
      delete entries[target];
      persist();
      return;
    }
    if (next.signature) {
      generation(target).receipt = { signature: next.signature, submissionId: next.submissionId };
    }
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
  // Draft edits replace the entry. Compare the captured object before writing a
  // receipt, and again on success before clearing the editor.
  // A cleared or switched-account editor must never inherit an in-flight receipt.
  function generation(target) {
    if (!generations.has(target)) generations.set(target, {});
    return generations.get(target);
  }
  function prepare(target, original, payload, started = generation(target)) {
    const sameEditor = generations.get(target) === started;
    if (!sameEditor || get(target) !== original) {
      const signature = JSON.stringify(payload);
      const replay = original?.signature === signature;
      payload.submissionId = replay ? original.submissionId : crypto.randomUUID();
      payload.retry = replay;
      if (sameEditor) {
        started.receipt = { signature, submissionId: payload.submissionId };
        if (get(target)) save(target, started.receipt);
      }
      return null;
    }
    const previousId = original?.submissionId;
    save(target, { text: payload.content, anonymous: payload.anonymous, attachments: payload.imageUrls });
    payload.submissionId = submission(target, payload);
    payload.retry = payload.submissionId === previousId;
    return get(target);
  }
  function logout() { generations.clear(); entries = {}; owner = null; persist(); }
  window.ForumDrafts = { bind, get, save, clear, submission, generation, prepare, logout };
})();

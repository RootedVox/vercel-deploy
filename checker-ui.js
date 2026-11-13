(function () {
  'use strict';
  const status = document.body.dataset.status;
  const list = document.getElementById('list');
  let selectedId = null;
  let selectedAction = null;

  function escapeHtml(value) {
    const node = document.createElement('div');
    node.textContent = value || '';
    return node.innerHTML.replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function login() {
    const returnTo = location.pathname + location.search;
    location.replace(`/auth/login?return_to=${encodeURIComponent(returnTo)}`);
  }

  async function api(url, options = {}) {
    const response = await request(url, { credentials: 'include', cache: 'no-store', ...options });
    if (response.status === 401) {
      login();
      throw new Error('authentication_required');
    }
    if (response.status === 403) {
      location.replace('/login-messageschecker?error=forbidden');
      throw new Error('forbidden');
    }
    if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || 'request_failed');
    return response.json();
  }

  function imageMarkup(values) {
    if (!Array.isArray(values) || !values.length) return '';
    return `<div class="message-images">${values.map(url => `<img src="${escapeHtml(url)}" class="message-image" alt="留言图片" loading="lazy">`).join('')}</div>`;
  }

  function actionMarkup(id) {
    if (status === 'pending') return `<button class="btn btn-approve" data-action="approve" data-id="${id}">通过</button><button class="btn btn-danger" data-action="reject" data-id="${id}">拒绝</button><button class="btn btn-danger btn-delete" data-action="delete" data-id="${id}">删除</button>`;
    if (status === 'approved') return `<button class="btn btn-danger" data-action="delete" data-id="${id}">删除</button>`;
    return `<button class="btn btn-approve" data-action="restore" data-id="${id}">恢复</button>`;
  }

  let cursor = null;
  let busy = false;
  const more = document.createElement('button');
  more.type = 'button';
  more.className = 'btn';
  more.textContent = '加载更多';
  more.hidden = true;
  list.after(more);
  more.addEventListener('click', () => load(true));

  async function load(append = false) {
    if (busy) return;
    busy = true;
    more.disabled = true;
    if (!append) list.textContent = '加载中…';
    try {
      const params = new URLSearchParams({ status });
      if (append && cursor) params.set('cursor', cursor);
      const data = await api('/api/checker/messages?' + params);
      cursor = data.nextCursor;
      more.hidden = !data.hasMore;
      if (!append) list.replaceChildren();
      if (!data.messages.length && !list.children.length) list.textContent = '当前没有留言';
      const cards = data.messages.map(message => `
        <article class="item">
          <div class="item-header"><strong>${escapeHtml(message.username)}</strong><time>${new Date(message.created_at).toLocaleString('zh-CN')}</time></div>
          <div class="zone">${escapeHtml(message.zone && message.zone !== '校园生活' ? message.zone : '日常分享')}</div>
          <div class="item-content">${escapeHtml(message.content).replace(/\n/g, '<br>')}</div>
          ${imageMarkup(message.pic_url)}
          <div class="meta">账号邮箱：${escapeHtml(message.contact_email || '未提供')}</div>
          ${status === 'deleted' ? `<div class="reason">原因：${escapeHtml(message.reject_reason || '未填写')}</div>` : ''}
          <div class="item-actions">${actionMarkup(message.id)}</div>
        </article>`).join('');
      list.insertAdjacentHTML('beforeend', cards);
    } catch (error) {
      if (!['authentication_required', 'forbidden'].includes(error.message)) {
        if (!append) list.textContent = '审核服务暂时不可用';
        else alert('下一页加载失败，请重试');
      }
    } finally {
      busy = false;
      more.disabled = false;
    }
  }

  async function moderate(id, nextAction, reason = '') {
    await api('/api/checker/messages', {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, action: nextAction, reason })
    });
    list.querySelector(`[data-id="${id}"]`)?.closest('article')?.remove();
    if (!list.children.length) {
      if (cursor) await load(true);
      else list.textContent = '当前没有留言';
    }
  }

  list.addEventListener('click', async event => {
    const image = event.target.closest('.message-image');
    if (image) return window.open(image.src, '_blank', 'noopener');
    const button = event.target.closest('button[data-action]');
    if (!button) return;
    const nextAction = button.dataset.action;
    if (nextAction === 'reject' || nextAction === 'delete') {
      selectedId = button.dataset.id;
      selectedAction = nextAction;
      const deleting = nextAction === 'delete';
      document.querySelector('#reasonModal h2').textContent = deleting ? '删除原因' : '拒绝原因';
      document.querySelector('#reasonModal p').textContent = deleting ? '帖子将移入已删除列表，原因会发送给发布者。' : '原因将发送给发布者。';
      document.getElementById('reasonInput').placeholder = deleting ? '请填写删除原因' : '请填写拒绝原因';
      document.getElementById('confirmReason').textContent = deleting ? '确认删除' : '确认拒绝';
      document.getElementById('reasonModal').style.display = 'flex';
      document.getElementById('reasonInput').focus();
      return;
    }
    button.disabled = true;
    try { await moderate(button.dataset.id, nextAction); } catch (error) { if (!['authentication_required', 'forbidden'].includes(error.message)) alert('操作失败，请重试'); } finally { button.disabled = false; }
  });

  document.getElementById('cancelReason')?.addEventListener('click', () => {
    selectedId = null;
    selectedAction = null;
    document.getElementById('reasonModal').style.display = 'none';
  });
  document.getElementById('confirmReason')?.addEventListener('click', async event => {
    const reason = document.getElementById('reasonInput').value.trim();
    if (!reason || !selectedId || !selectedAction) return alert('请填写原因');
    event.target.disabled = true;
    try {
      await moderate(selectedId, selectedAction, reason);
      selectedId = null;
      selectedAction = null;
      document.getElementById('reasonInput').value = '';
      document.getElementById('reasonModal').style.display = 'none';
    } catch (error) {
      if (!['authentication_required', 'forbidden'].includes(error.message)) alert('操作失败，请刷新后重试');
    } finally { event.target.disabled = false; }
  });
  document.getElementById('logoutBtn').addEventListener('click', () => RootedVoxAuth.logout('/main'));

  (async () => {
    const session = await RootedVoxAuth.getSession().catch(() => null);
    if (!session?.authenticated) return login();
    if (!session.user?.checker) return location.replace('/login-messageschecker?error=forbidden');
    await load();
  })();
})();

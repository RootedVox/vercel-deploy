// ===================== 开发者昵称白名单，与messages.html保持同步 =====================
const { escapeHtml, parseMessageContent, renderMessageAvatars } = ForumUI;
// Identity and data writes are handled by the business backend.
let mainMsgId = null;
let currentUser = null;
let authReady;
let userId = '';
let currentUserRealName = '';
let currentUserEmail = '';
let allMessages = [];
let userMap = Object.create(null);
const COMMENT_BATCH_SIZE = 20;
let orderedComments = [];
let threadCursor = null;
let pageLoading = false;
let renderedComments = 0;
function getMsgIdFromUrl() {
    const params = new URLSearchParams(window.location.search);
    return params.get('id')?.toLowerCase();
}
// ==================== 登录验证 ====================
async function initAuth() {
    try {
        const session = await RootedVoxAuth.getSession();
        if (!session?.authenticated) return false;
        currentUser = session.user;
        userId = session.user.id;
        ForumDrafts.bind(userId);
        currentUserEmail = session.user.email || '';
        currentUserRealName = session.user.name || session.user.email?.split('@')[0] || '用户';
        return true;
    } catch {
        return false;
    }
}
// ==================== 图片上传【改造：先压缩再上传】 ====================
const uploadImages = files => ForumUI.uploadFiles(files);
const previewUrls = new Map();
function releasePreviews(id) {
    for (const url of previewUrls.get(id) || []) URL.revokeObjectURL(url);
    previewUrls.delete(id);
}
function previewImages(id) {
    const input = document.getElementById(`imageUpload-${id}`);
    const text = document.querySelector(`#reply-box-${id} textarea`)?.value || '';
    ForumDrafts.save('reply-' + id, { text, attachments: [] });
    const box = document.getElementById(`preview-${id}`);
    releasePreviews(id);
    box.replaceChildren();
    const files = Array.from(input.files);
    if (files.length > 5 || files.some(file => !file.type.startsWith('image/') || file.size > 5 * 1024 * 1024)) {
        input.value = '';
        alert('最多选择 5 张图片，每张不超过 5MB');
        return;
    }
    const urls = files.map(file => URL.createObjectURL(file));
    previewUrls.set(id, urls);
    for (const url of urls) {
        const image = document.createElement('img');
        image.className = 'preview-image-item';
        image.src = url;
        box.appendChild(image);
    }
}
// ==================== 加载内容 ====================
const messageIdPattern = /^(?:\d+|[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i;
const linkedId = new URLSearchParams(location.search).get('replyId')?.toLowerCase();
const replyId = linkedId === getMsgIdFromUrl() ? null : linkedId;
let replyParentName = null;
async function loadMainMessage() {
    mainMsgId = getMsgIdFromUrl();
    if (!messageIdPattern.test(mainMsgId || '')) return location.replace('/messages.html');
    try {
        if (!window.RootedVoxPublicData) throw new Error('public_data_unavailable');
        const target = messageIdPattern.test(replyId || '') ? replyId : null;
        const page = await RootedVoxPublicData.threadPage(mainMsgId, null, target);
        replyParentName = page.parentName;
        allMessages = page.messages;
        threadCursor = page.nextCursor;
    } catch {
        document.getElementById('mainMessageCard').innerHTML = '<div class="loading">留言暂时无法加载。<button class="comment-btn" data-action="retry">重试</button></div>';
        document.getElementById('commentContainer').innerHTML = '<div class="empty-comment">评论暂时无法加载，请重试。</div>';
        return false;
    }
    const main = allMessages.find(message => String(message.id) === String(mainMsgId));
    if (!main) {
        document.getElementById('mainMessageCard').innerHTML = '<div class="loading">留言不存在或暂不可用</div>';
        document.getElementById('commentContainer').innerHTML = '<div class="empty-comment">暂无可显示的评论</div>';
        return false;
    }
    renderMainMessage(main);
    loadAllComments();
    return true;
}
async function retryThread() {
    document.getElementById('mainMessageCard').innerHTML = '<div class="loading">加载主楼内容中...</div>';
    document.getElementById('commentContainer').innerHTML = '<div class="loading">加载评论中...</div>';
    if (await loadMainMessage()) {
        if (replyId) jumpToComment(replyId);
        observeMoreComments();
        const target = new URLSearchParams(location.search).get('compose');
        if (target && await authReady && ForumDrafts.get('reply-' + target) && document.getElementById('reply-box-' + target)) {
            if (target === mainMsgId) showMainCommentBox(target);
            else showReplyBox(target);
        }
    }
}
function renderMainMessage(msg) {
    const parsedContent = parseMessageContent(msg.content, msg.zone);
    const t = new Date(msg.created_at).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' });
    const imgs = msg.pic_url ? msg.pic_url.map(u => `<img src="${escapeHtml(u)}" class="message-image" alt="${escapeHtml(msg.username)} 发布的图片" tabindex="0">`).join('') : '';
    document.getElementById('mainMessageCard').innerHTML = `
    <div class="message-item" id="msg-${msg.id}" data-avatar-url="${escapeHtml(msg.avatar_url || '')}" data-official="${msg.is_official === true}">
        <div class="message-avatar-box"></div>
        <div style="flex:1">
            <div class="message-header">
                <span class="message-author">${escapeHtml(msg.username)}</span>
                <span class="message-time">${t}</span>
            </div>
            <span class="message-zone">${escapeHtml(parsedContent.zone)}</span>
            <div class="message-content">${escapeHtml(parsedContent.text).replace(/\n/g, '<br>')}</div>
            <div class="message-images">${imgs}</div>
            <button class="comment-btn" data-action="comment" data-id="${escapeHtml(msg.id)}">💬 评论</button>
            <div id="reply-box-${msg.id}" class="comment-input-container"></div>
        </div>
    </div>`;
    renderMessageAvatars();
}
function loadAllComments() {
    const container = document.getElementById('commentContainer');
    const more = document.getElementById('moreComments');
    orderedComments = allMessages.filter(message => message.reply_to != null);
    const focused = Boolean(replyId);
    if (focused) {
        document.getElementById('commentHeading').textContent = '链接指向的回复';
        const link = document.getElementById('allCommentsLink');
        link.href = '?id=' + encodeURIComponent(mainMsgId);
        link.hidden = false;
        orderedComments = orderedComments.filter(row => String(row.id) === replyId);
        threadCursor = null;
    }
    renderedComments = 0;
    userMap = Object.create(null);
    for (const message of allMessages) userMap[message.id] = message.username;

    container.classList.remove('loading');
    if (!orderedComments.length) {
        more.hidden = true;
        container.innerHTML = focused
            ? '<div class="empty-comment">这条回复已不可见或不属于当前主帖。</div>'
            : '<div class="empty-comment">暂无评论</div>';
        return;
    }
    container.replaceChildren();
    more.onclick = loadMoreComments;
    appendCommentBatch();
}

function renderComment(r) {
    const nested = String(r.reply_to) !== String(mainMsgId);
    const parentName = escapeHtml(userMap[r.reply_to] || replyParentName || '用户');
    const parentInfo = replyId
        ? `<a class="reply-info" href="?id=${encodeURIComponent(mainMsgId)}&amp;replyId=${encodeURIComponent(r.reply_to)}">↳ 回复 @${parentName}</a>`
        : `<div class="reply-info" data-action="jump" data-id="${escapeHtml(r.reply_to)}">↳ 回复 @${parentName}</div>`;
    return `
        <div class="message-item ${nested ? 'level-2' : 'level-1'}" id="msg-${r.id}" data-avatar-url="${escapeHtml(r.avatar_url || '')}" data-official="${r.is_official === true}">
            <div class="message-avatar-box"></div>
            <div style="flex:1">
                <div class="message-header">
                    <span class="message-author">${escapeHtml(r.username)}</span>
                    <span class="message-time">${new Date(r.created_at).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' })}</span>
                </div>
                ${nested ? parentInfo : ''}
                <div class="message-content">${escapeHtml(r.content).replace(/\n/g, '<br>')}</div>
                <div class="message-images">${r.pic_url ? r.pic_url.map(u => `<img loading="lazy" src="${escapeHtml(u)}" class="message-image" alt="${escapeHtml(r.username)} 发布的图片" tabindex="0">`).join('') : ''}</div>
                <button class="reply-btn" data-action="reply" data-id="${escapeHtml(r.id)}">💬 回复</button>
                <div id="reply-box-${r.id}" class="comment-input-container"></div>
            </div>
        </div>`;
}

function appendCommentBatch() {
    const container = document.getElementById('commentContainer');
    const batch = orderedComments.slice(renderedComments, renderedComments + COMMENT_BATCH_SIZE);
    const template = document.createElement('template');
    template.innerHTML = batch.map(renderComment).join('');
    const items = [...template.content.children];
    container.append(template.content);
    renderMessageAvatars(items);
    renderedComments += batch.length;
    document.getElementById('moreComments').hidden = !threadCursor && renderedComments >= orderedComments.length;
}

async function loadMoreComments() {
    if (pageLoading) return false;
    pageLoading = true;
    const more = document.getElementById('moreComments');
    more.disabled = true;
    try {
        if (renderedComments >= orderedComments.length && threadCursor) {
            const page = await RootedVoxPublicData.threadPage(mainMsgId, threadCursor);
            for (const message of page.messages) {
                if (Object.hasOwn(userMap, message.id)) continue;
                userMap[message.id] = message.username;
                orderedComments.push(message);
            }
            threadCursor = page.nextCursor;
        }
        appendCommentBatch();
        more.textContent = '加载更多评论';
        return true;
    } catch (error) {
        if (error.message === 'stale_cursor') {
            more.textContent = '评论已更新，重新加载';
            more.onclick = retryThread;
        } else {
            more.textContent = '加载失败，点击重试';
        }
        return false;
    } finally {
        more.disabled = false;
        pageLoading = false;
    }
}

let commentObserver;
function observeMoreComments() {
    commentObserver?.disconnect();
    const more = document.getElementById('moreComments');
    if (!('IntersectionObserver' in window) || more.hidden) return;
    commentObserver = new IntersectionObserver(async ([entry]) => {
        if (!entry.isIntersecting || pageLoading) return;
        const loaded = await loadMoreComments();
        if (!loaded || more.hidden) commentObserver.disconnect();
    });
    commentObserver.observe(more);
}
// ==================== 评论框 ====================
function closeAllCommentBoxes() {
    for (const id of previewUrls.keys()) releasePreviews(id);
    document.querySelectorAll('.comment-input-container').forEach(e => e.style.display = 'none');
}
function bindReplyDraft(tid, box) {
    const key = 'reply-' + tid;
    const text = box.querySelector('textarea');
    const anon = box.querySelector('input[type=checkbox]');
    const draft = ForumDrafts.get(key);
    if (draft) {
        text.value = draft.text;
        anon.checked = draft.anonymous === true;
        const preview = document.getElementById('preview-' + tid);
        for (const src of draft.attachments || []) {
            const img = document.createElement('img');
            img.className = 'preview-image-item';
            img.src = src;
            img.alt = '已上传的图片';
            preview.append(img);
        }
    }
    const save = () => ForumDrafts.save(key, { text: text.value, anonymous: anon.checked });
    text.oninput = save;
    anon.onchange = save;
    box.querySelector('.cancel-comment-btn').onclick = () => {
        ForumDrafts.clear(key);
        closeAllCommentBoxes();
    };
}
function showMainCommentBox(tid) {
    closeAllCommentBoxes();
    const b = document.getElementById(`reply-box-${tid}`);
    if (!b) return;
    b.style.display = 'block';
    b.innerHTML = `
    <textarea class="comment-input" id="mainCommentInput" placeholder="写下你的评论..."></textarea>
    <div class="image-upload-container" data-action="pick" data-id="${tid}">
        <div class="image-upload-text">🖼️ 点击选择图片（可选）</div>
        <input type="file" id="imageUpload-${tid}" class="image-upload-input" accept="image/*" multiple data-id="${tid}">
    </div>
    <div id="preview-${tid}" class="preview-images"></div>
    <div class="anonymous-checkbox-container">
        <input type="checkbox" id="anonymous-${tid}" class="anonymous-checkbox">
        <label for="anonymous-${tid}" class="anonymous-label">匿名发布</label>
    </div>
    <div>
        <button class="comment-submit-btn" data-action="submit" data-id="${tid}" data-kind="main">发布评论</button>
        <button class="cancel-comment-btn" >取消</button>
    </div>`;
    bindReplyDraft(tid, b);
}
function showReplyBox(tid) {
    closeAllCommentBoxes();
    const b = document.getElementById(`reply-box-${tid}`);
    if (!b) return;
    const name = userMap[tid] || '用户';
    b.style.display = 'block';
    b.innerHTML = `
    <textarea class="comment-input" id="replyInput-${tid}" placeholder="回复 @${escapeHtml(name)}"></textarea>
    <div class="image-upload-container" data-action="pick" data-id="${tid}">
        <div class="image-upload-text">🖼️ 点击选择图片（可选）</div>
        <input type="file" id="imageUpload-${tid}" class="image-upload-input" accept="image/*" multiple data-id="${tid}">
    </div>
    <div id="preview-${tid}" class="preview-images"></div>
    <div class="anonymous-checkbox-container">
        <input type="checkbox" id="anonymous-${tid}" class="anonymous-checkbox">
        <label for="anonymous-${tid}" class="anonymous-label">匿名发布</label>
    </div>
    <div>
        <button class="comment-submit-btn" data-action="submit" data-id="${tid}" data-kind="reply">发布回复</button>
        <button class="cancel-comment-btn" >取消</button>
    </div>`;
    bindReplyDraft(tid, b);
}
// ==================== 提交评论 ====================
let commentSubmitting = false;
async function submitComment(rid, type) {
    if (commentSubmitting) return;
    commentSubmitting = true;
    const button = document.querySelector(`#reply-box-${rid} .comment-submit-btn`);
    const originalLabel = button?.textContent;
    if (button) { button.disabled = true; button.textContent = '发布中…'; }
    try {
        await authReady;
        if (!currentUser || !currentUser.id) return RootedVoxAuth.handleLogin('/details' + location.search);
        const el = type === 'main'
            ? document.getElementById('mainCommentInput')
            : document.getElementById(`replyInput-${rid}`);
        const content = el?.value.trim();
        if (!content) { alert('内容不能为空'); return; }
        const ano = document.getElementById(`anonymous-${rid}`)?.checked || false;
        const files = document.getElementById(`imageUpload-${rid}`)?.files;
        const key = 'reply-' + rid;
        const urls = files?.length ? await uploadImages(files, rid) : ForumDrafts.get(key)?.attachments || [];
        ForumDrafts.save(key, { text: content, anonymous: ano, attachments: urls });
        const payload = { content, anonymous: ano, imageUrls: urls, replyTo: rid };
        const lastSubmission = ForumDrafts.get(key)?.submissionId;
        payload.submissionId = ForumDrafts.submission(key, payload);
        payload.retry = payload.submissionId === lastSubmission;
        const response = await request('/api/messages', {
            method: 'POST', credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        if (response.status === 401) throw new Error('login_required');
        if (!response.ok) throw new Error('comment_failed');
        ForumDrafts.clear(key);
        el.value = '';
        const input = document.getElementById(`imageUpload-${rid}`);
        if (input) input.value = '';
        document.getElementById(`preview-${rid}`)?.replaceChildren();
        alert('发布成功！等待审核');
        closeAllCommentBoxes();
    } catch (error) {
        if (error.message === 'login_required') {
            const url = new URL('/details', location.origin);
            url.searchParams.set('id', mainMsgId);
            url.searchParams.set('compose', rid);
            if (rid !== mainMsgId) url.searchParams.set('replyId', rid);
            return RootedVoxAuth.handleLogin(url.pathname + url.search);
        }
        alert('发布失败，请检查网络后重试。内容和图片已保留。');
    } finally {
        commentSubmitting = false;
        if (button) { button.disabled = false; button.textContent = originalLabel; }
    }
}
// ==================== 跳转 + 高亮 ====================
function jumpToComment(targetId) {
    const el = document.getElementById(`msg-${targetId}`);
    if (!el) return;
    el.scrollIntoView({ behavior: 'smooth' });
    el.classList.add('highlight');
    setTimeout(() => el.classList.remove('highlight'), 2000);
}
// ==================== 事件委托 ====================
// The Content-Security-Policy blocks on* attributes, so each rendered control names an
// action and this one listener dispatches it.
const actions = {
    retry: () => retryThread(),
    comment: id => showMainCommentBox(id),
    reply: id => showReplyBox(id),
    jump: id => jumpToComment(id),
    // The hidden file input sits inside the container, so its own click bubbles back here.
    pick: (id, kind, event) => { if (!event.target.closest('input')) document.getElementById(`imageUpload-${id}`)?.click(); },
    submit: (id, kind) => submitComment(id, kind)
};
document.addEventListener('click', event => {
    const control = event.target.closest('[data-action]');
    if (control && Object.hasOwn(actions, control.dataset.action)) actions[control.dataset.action](control.dataset.id, control.dataset.kind, event);
});
document.addEventListener('change', event => {
    if (event.target.matches('.image-upload-input')) previewImages(event.target.dataset.id);
});
// ==================== 初始化 ====================
document.addEventListener('DOMContentLoaded', () => {
    authReady = initAuth();
    retryThread();
});

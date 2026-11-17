// ===================== 开发者昵称白名单，与messages.html保持同步 =====================
const { escapeHtml, parseMessageContent, renderMessageAvatars, notify } = ForumUI;
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
function uploadImages(files) { return ForumUI.uploadFiles(files); }
// Per reply: one entry per image. Restored drafts carry {url}; a freshly picked
// local file carries {file, preview} and gets its url only after upload.
const replyImages = new Map();
function releasePreviews(id) {
    for (const image of replyImages.get(id) || []) {
        if (image.preview) URL.revokeObjectURL(image.preview);
    }
    replyImages.delete(id);
}
function renderPreviews(id) {
    const box = document.getElementById(`preview-${id}`);
    if (!box) return;
    box.replaceChildren();
    for (const image of replyImages.get(id) || []) {
        const img = document.createElement('img');
        img.className = 'preview-image-item';
        img.src = image.preview || image.url;
        img.alt = '回复图片';
        box.appendChild(img);
        if (image.needsReplacement) {
            const remove = document.createElement('button');
            remove.type = 'button';
            remove.textContent = '移除这张图片';
            remove.onclick = () => {
                replyImages.set(id, replyImages.get(id).filter(item => item !== image));
                renderPreviews(id);
                saveReplyImageDraft(id);
            };
            box.appendChild(remove);
        }
    }
}
function saveReplyImageDraft(id) {
    const text = document.querySelector(`#reply-box-${id} textarea`)?.value || '';
    const anon = document.querySelector(`#reply-box-${id} input[type=checkbox]`)?.checked || false;
    ForumDrafts.save('reply-' + id, {
        text, anonymous: anon,
        attachments: (replyImages.get(id) || []).map(image => image.url).filter(Boolean)
    });
}
function previewImages(id) {
    const input = document.getElementById(`imageUpload-${id}`);
    const selected = Array.from(input.files);
    input.value = '';
    if (!selected.length) return;
    const images = replyImages.get(id) || [];
    const originalLength = images.length;
    const errors = [];
    for (const file of selected) {
        if (!file.type.startsWith('image/')) errors.push('仅支持图片文件');
        else if (file.size > 5 * 1024 * 1024) errors.push('每张图片不超过 5MB');
        else if (images.length >= 5) errors.push('最多选择 5 张图片');
        else images.push({ file, preview: URL.createObjectURL(file) });
    }
    if (images.length !== originalLength) {
        replyImages.set(id, images);
        renderPreviews(id);
        saveReplyImageDraft(id);
    }
    if (errors.length) notify(errors[0], 'error');
}
// ==================== 加载内容 ====================
const messageIdPattern = /^(?:\d+|[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i;
const linkedId = new URLSearchParams(location.search).get('replyId')?.toLowerCase();
const replyId = linkedId !== getMsgIdFromUrl() && messageIdPattern.test(linkedId || '') ? linkedId : null;
let replyParentName = null;
async function loadMainMessage() {
    mainMsgId = getMsgIdFromUrl();
    if (!messageIdPattern.test(mainMsgId || '')) return location.replace('/messages.html');
    try {
        if (!window.RootedVoxPublicData) throw new Error('public_data_unavailable');
        const page = await RootedVoxPublicData.threadPage(mainMsgId, null, replyId);
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
    const more = document.getElementById('moreComments');
    if (more) more.hidden = true;
    commentObserver?.disconnect();
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
    const t = ForumUI.postTimeHtml?.(msg.created_at)
        ?? `<span class="message-time">${new Date(msg.created_at).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' })}</span>`;
    const imgs = msg.pic_url ? msg.pic_url.map(u => `<img src="${escapeHtml(u)}" class="message-image" alt="${escapeHtml(msg.username)} 发布的图片" decoding="async" tabindex="0">`).join('') : '';
    document.getElementById('mainMessageCard').innerHTML = `
    <div class="message-item" id="msg-${msg.id}" data-avatar-url="${escapeHtml(msg.avatar_url || '')}" data-official="${msg.is_official === true}" data-developer="${msg.is_developer === true}">
        <div class="message-avatar-box"></div>
        <div style="flex:1">
            <div class="message-header">
                <span class="message-author">${escapeHtml(msg.username)}</span>
                ${t}
            </div>
            <span class="message-zone">${escapeHtml(parsedContent.zone)}</span>
            <div class="message-content">${escapeHtml(parsedContent.text).replace(/\n/g, '<br>')}</div>
            ${msg.is_featured === true ? '<div class="thread-featured"><span class="featured-stamp"><img src="/images/rootedvox.svg" alt="">精华</span></div>' : ''}
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
    more.textContent = '加载更多评论';
    more.onclick = loadMoreComments;
    appendCommentBatch();
}

function renderComment(r) {
    const nested = String(r.reply_to) !== String(mainMsgId);
    const parentName = escapeHtml(userMap[r.reply_to] || replyParentName || '用户');
    const parentInfo = replyId
        ? `<a class="reply-info" href="?id=${encodeURIComponent(mainMsgId)}&amp;replyId=${encodeURIComponent(r.reply_to)}">↳ 回复 @${parentName}</a>`
        : `<button type="button" class="reply-info" data-action="jump" data-id="${escapeHtml(r.reply_to)}">↳ 回复 @${parentName}</button>`;
    return `
        <div class="message-item ${nested ? 'level-2' : 'level-1'}" id="msg-${r.id}" data-avatar-url="${escapeHtml(r.avatar_url || '')}" data-official="${r.is_official === true}" data-developer="${r.is_developer === true}">
            <div class="message-avatar-box"></div>
            <div style="flex:1">
                <div class="message-header">
                    <span class="message-author">${escapeHtml(r.username)}</span>
                    ${ForumUI.postTimeHtml?.(r.created_at) ?? `<span class="message-time">${new Date(r.created_at).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' })}</span>`}
                </div>
                ${nested ? parentInfo : ''}
                <div class="message-content">${escapeHtml(r.content).replace(/\n/g, '<br>')}</div>
                <div class="message-images">${r.pic_url ? r.pic_url.map(u => `<img loading="lazy" decoding="async" src="${escapeHtml(u)}" class="message-image" alt="${escapeHtml(r.username)} 发布的图片" tabindex="0">`).join('') : ''}</div>
                <button class="reply-btn" data-action="reply" data-id="${escapeHtml(r.id)}">💬 回复</button>
                <a class="copy-reply" data-action="copy" href="?id=${encodeURIComponent(mainMsgId)}&amp;replyId=${encodeURIComponent(r.id)}">复制回复链接</a>
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
        if (!replyImages.has(tid) && draft.attachments?.length) {
            replyImages.set(tid, draft.attachments.map(url => ({ url })));
        }
    }
    renderPreviews(tid);
    const save = () => saveReplyImageDraft(tid);
    const counter = box.querySelector('.reply-count');
    const updateCount = () => { counter.textContent = text.value.length + ' / 1000'; };
    updateCount();
    text.oninput = () => { updateCount(); save(); };
    anon.onchange = save;
    box.querySelector('.cancel-comment-btn').onclick = () => {
        ForumDrafts.clear(key);
        releasePreviews(tid);
        closeAllCommentBoxes();
    };
}
function showMainCommentBox(tid) {
    closeAllCommentBoxes();
    const b = document.getElementById(`reply-box-${tid}`);
    if (!b) return;
    b.style.display = 'block';
    b.innerHTML = `
    <textarea maxlength="1000" class="comment-input" id="mainCommentInput" placeholder="写下你的评论..."></textarea>
    <small class="reply-count"></small>
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
    <textarea maxlength="1000" class="comment-input" id="replyInput-${tid}" placeholder="回复 @${escapeHtml(name)}"></textarea>
    <small class="reply-count"></small>
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
        const editorId = type === 'main' ? 'mainCommentInput' : `replyInput-${rid}`;
        const el = document.getElementById(editorId);
        const content = el?.value.trim();
        if (!content) { notify('内容不能为空', 'error'); el?.focus(); return; }
        if (content.length > 1000) { notify('回复最多 1000 字，请缩短后再发布。', 'error'); el.focus(); return; }
        const ano = document.getElementById(`anonymous-${rid}`)?.checked || false;
        const key = 'reply-' + rid;
        const started = ForumDrafts.generation(key);
        const original = ForumDrafts.get(key);
        const images = (replyImages.get(rid) || []).slice();
        const pending = images.filter(image => !image.url);
        const uploaded = pending.length ? await uploadImages(pending.map(image => image.file)) : [];
        pending.forEach((image, index) => { image.url = uploaded[index]; });
        const urls = images.map(image => image.url).filter(Boolean);
        const payload = { content, anonymous: ano, imageUrls: urls, replyTo: rid };
        const submitted = ForumDrafts.prepare(key, original, payload, started);
        const response = await request('/api/messages', {
            method: 'POST', credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        if (response.status === 401) throw new Error('login_required');
        if (response.status === 409 && (await response.json()).error === 'draft_media_expired') {
            notify(ForumUI.recoverDraftImages(images), 'error');
            renderPreviews(rid);
            return;
        }
        if (!response.ok) throw new Error('comment_failed');
        notify('发布成功，审核通过后会公开。', 'success');
        // Text replies are reviewed by the AI right after the save; watch for publication.
        const result = (await response.json?.().catch(() => ({}))) ?? {};
        if (result.id && result.published !== true && !urls.length) watchReplyPublication(result.id);
        if (!submitted || ForumDrafts.get(key) !== submitted) return;
        ForumDrafts.clear(key);
        releasePreviews(rid);
        const editor = document.getElementById(editorId);
        if (!editor) return;
        editor.value = '';
        const input = document.getElementById(`imageUpload-${rid}`);
        if (input) input.value = '';
        document.getElementById(`preview-${rid}`)?.replaceChildren();
        document.getElementById('reply-box-' + rid).style.display = 'none';
    } catch (error) {
        if (error.message === 'login_required') {
            const url = new URL('/details', location.origin);
            url.searchParams.set('id', mainMsgId);
            url.searchParams.set('compose', rid);
            if (rid !== mainMsgId) url.searchParams.set('replyId', rid);
            return RootedVoxAuth.handleLogin(url.pathname + url.search);
        }
        notify('发布失败，请检查网络后重试。内容和图片已保留。', 'error');
    } finally {
        commentSubmitting = false;
        if (button) { button.disabled = false; button.textContent = originalLabel; }
    }
}
// A text reply is saved as pending and the AI review publishes it a few seconds later.
// The page asks for that reply in this thread a few times and, once it is public, adds it
// to the end of the list (replies are listed oldest first) without reloading. Replies with
// images wait for a human, so they are not watched. At most four small reads per reply.
const PUBLISH_CHECKS = [3000, 6000, 12000, 24000];
function watchReplyPublication(id) {
    let attempt = 0;
    const check = async () => {
        try {
            const page = await RootedVoxPublicData.threadPage(mainMsgId, null, id);
            const reply = page?.messages?.find(message => String(message.id) === String(id));
            if (reply) return showPublishedReply(reply);
        } catch { /* A failed read is simply tried again at the next step. */ }
        if (++attempt < PUBLISH_CHECKS.length) setTimeout(check, PUBLISH_CHECKS[attempt]);
    };
    setTimeout(check, PUBLISH_CHECKS[0]);
}

function showPublishedReply(reply) {
    notify('你的回复已通过审核并公开。', 'success');
    if (document.getElementById(`msg-${reply.id}`) || Object.hasOwn(userMap, reply.id)) return;
    // Added only when the whole thread is already on the page, so the newest reply really is
    // last; otherwise it shows up in place when the remaining comments are loaded. A page
    // that shows a single linked reply is left as it is.
    if (replyId || threadCursor || renderedComments < orderedComments.length) return;
    const container = document.getElementById('commentContainer');
    if (!container) return;
    container.querySelector('.empty-comment')?.remove();
    userMap[reply.id] = reply.username;
    orderedComments.push(reply);
    renderedComments += 1;
    const template = document.createElement('template');
    template.innerHTML = renderComment(reply);
    const items = [...template.content.children];
    container.append(template.content);
    renderMessageAvatars(items);
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
function configureFeedReturn() {
    let saved = window.history?.state?.forumReturn;
    try {
        if (location.hash?.startsWith('#feed-')) {
            saved = JSON.parse(sessionStorage.getItem('rootedvox.feed.return'));
            if (!saved || location.hash !== '#feed-' + saved.token) return;
            if (saved.id !== getMsgIdFromUrl()) return;
            // Keep the list context in this history entry. The address is shareable.
            history.replaceState({ ...history.state, forumReturn: saved }, '', location.pathname + location.search);
        }
        if (!saved || saved.id !== getMsgIdFromUrl()) return;
        const link = document.getElementById('backToFeed');
        const back = new URL('/messages', location.origin);
        back.search = saved.search;
        back.hash = 'feed-' + saved.token;
        link.href = back.href;
        link.addEventListener('click', event => {
            // Prefer the original list entry, including its browser-cached DOM.
            const nav = window.navigation;
            const previous = nav?.entries()[nav.currentEntry.index - 1];
            if (!event.ctrlKey && !event.metaKey && !event.shiftKey && !event.altKey &&
                previous?.url && new URL(previous.url).hash === back.hash &&
                /^\/messages(?:\.html)?\/?$/.test(new URL(previous.url).pathname)) {
                event.preventDefault();
                history.back();
            } else {
                try { sessionStorage.setItem('rootedvox.feed.return', JSON.stringify(saved)); } catch {}
            }
        });
    } catch { /* Shared links and private browsing use the default forum link. */ }
}

async function copyReplyLink(link) {
    try {
        await navigator.clipboard.writeText(link.href);
        notify('已复制回复链接', 'success');
    } catch {
        let field = link.parentElement.querySelector('.reply-link-field');
        if (!field) {
            field = document.createElement('input');
            field.className = 'reply-link-field';
            field.readOnly = true;
            field.setAttribute('aria-label', '回复链接');
            link.after(field);
        }
        field.value = link.href;
        field.focus();
        field.select();
        notify('已选中回复链接，可手动复制');
    }
}

const actions = {
    retry: () => retryThread(),
    comment: id => showMainCommentBox(id),
    reply: id => showReplyBox(id),
    copy: (_id, _kind, event) => {
        if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
        event.preventDefault();
        copyReplyLink(event.target.closest('a'));
    },
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
    configureFeedReturn();
    authReady = initAuth();
    retryThread();
});

        const { escapeHtml, parseMessageContent, getFreshAvatar, renderMessageAvatars, notify } = ForumUI;
        let currentPage = 0;
        const PAGE_SIZE = 20;
        let hasMore = true;
        let isLoadingMore = false;
        let scrollTimeout = null;
        let abortController = null;
        let activeSearch = '';
        let activeSort = 'newest';
        let activeZone = 'all';
        let searchTimer = null;
        let notifyPage = 0;
        let notifyCursor = null;
        const NOTIFY_PAGE_SIZE = 10;
        let notifyHasMore = true;
        let notifyLoading = false;
        const MAX_IMAGES = 5;
        const MAX_SIZE = 5 * 1024 * 1024;
        const SCROLL_THRESHOLD = 350;
        let feedCursor = null;
        const PAGE_AUTO_LOADS = 2;
        let pageAutoLoads = 0;
        let currentUser = null;
        let currentUserEmail = '';
        let currentUserRealName = '';
        let userId = '';

        async function refreshNotificationDot() {
            if (!userId) return;
            const response = await request('/api/notifications?exists=1', { credentials: 'include', cache: 'no-store' });
            if (!response.ok) return;
            const { hasUnread } = await response.json();
            notificationDot.style.display = hasUnread ? "block" : "none";
            dropdownDot.style.display = hasUnread ? "inline-block" : "none";
        }

        // Dialog focus: move it inside on open, keep Tab inside, and return it on close.
        let modalOpener = null;
        function showModal(modal, focusTarget, opener = document.activeElement) {
            if (modal.style.display === 'flex') return;
            modalOpener = opener;
            modal.style.display = 'flex';
            focusTarget?.focus();
        }

        function hideModal(modal) {
            if (modal.style.display !== 'flex') return;
            modal.style.display = 'none';
            modalOpener?.focus?.();
            modalOpener = null;
        }

        function trapModalFocus(event) {
            const modal = [...document.querySelectorAll('.notification-modal')].find(node => node.style.display === 'flex');
            if (!modal) return;
            const items = [...modal.querySelectorAll('button, input, select, textarea, a[href]')]
                .filter(node => !node.disabled && node.offsetParent !== null);
            if (!items.length) return;
            const first = items[0], last = items.at(-1);
            const inside = modal.contains(document.activeElement);
            if (event.shiftKey && (!inside || document.activeElement === first)) { event.preventDefault(); last.focus(); }
            else if (!event.shiftKey && (!inside || document.activeElement === last)) { event.preventDefault(); first.focus(); }
        }

        async function openNotifications(append = false) {
            const modal = document.getElementById("notificationModal");
            // The menu item that opened it is hidden again, so focus returns to the menu button.
            showModal(modal, document.getElementById('closeModal'), document.getElementById('avatarBtn'));
            const listEl = document.getElementById("notificationList");
            if (notifyLoading) return;
            notifyLoading = true;
            const retry = document.getElementById('notificationRetry');
            retry.hidden = true;

            if (!append) {
                notifyPage = 0;
                notifyCursor = null;
                notifyHasMore = true;
                listEl.innerHTML = '<div style="text-align:center;padding:20px 0;color:var(--muted);">加载通知中...</div>';
            }

            try {
                const response = await request(`/api/notifications?page=${notifyPage}&limit=${NOTIFY_PAGE_SIZE}&cursor=${encodeURIComponent(notifyCursor || '')}`, { credentials: 'include', cache: 'no-store' });
                if (!response.ok) throw new Error('通知服务暂时不可用');
                const result = await response.json();
                const notes = result.notifications || [];

                const loadingTip = listEl.querySelector('div[style*="text-align:center;padding:20px 0"]');
                if (loadingTip && !append) loadingTip.remove();

                if (!notes || notes.length === 0) {
                    notifyHasMore = false;
                    if (!append) {
                        listEl.innerHTML = `<div style='text-align:center;padding:30px;color:var(--muted);'>暂无通知</div>`;
                    } else {
                        listEl.insertAdjacentHTML('beforeend', `<div style="text-align:center;padding:15px 0;color:var(--muted);font-size:13px;">没有更多通知了</div>`);
                    }
                    notifyLoading = false;
                    return;
                }

                const htmlFragment = document.createDocumentFragment();
                notes.forEach(n => {
                    const itemDiv = document.createElement("div");
                    itemDiv.className = `notification-item ${n.type === 'rejected' ? 'rejected' : ''}`;
                    itemDiv.innerHTML = `
                      <h4>${escapeHtml(n.title)}</h4>
                      <p>${escapeHtml(n.content)}</p>
                      <p style='font-size:12px;color:var(--muted);margin:5px 0 0 0;'>${new Date(n.created_at).toLocaleString()}</p>
                    `;
                    htmlFragment.appendChild(itemDiv);
                });

                if (!append) listEl.innerHTML = "";
                listEl.appendChild(htmlFragment);

                notifyCursor = result.nextCursor;
                notifyHasMore = result.hasMore === true;

                notifyPage++;
                if (!append) {
                    // Keep the fetched notifications visible when marking them read fails.
                    const marked = await request(`/api/notifications?through=${encodeURIComponent(notes[0].id)}`, { method: 'PATCH', credentials: 'include' }).catch(() => null);
                    if (marked?.ok) {
                        const { hasUnread } = await marked.json().catch(() => ({}));
                        if (typeof hasUnread !== 'boolean') return;
                        notificationDot.style.display = hasUnread ? 'block' : 'none';
                        dropdownDot.style.display = hasUnread ? 'inline-block' : 'none';
                    }
                }

            } catch {
                if (!append) listEl.textContent = '通知暂时无法加载。';
                retry.textContent = append ? '下一页加载失败，点击重试' : '重新加载通知';
                retry.onclick = () => openNotifications(append);
                retry.hidden = false;
            } finally {
                notifyLoading = false;
            }
        }

        async function initUserExtra() {
            const response = await request('/api/profile', { credentials: 'include', cache: 'no-store' });
            const data = response.ok ? await response.json() : {};
            const url = data.avatarUrl;

            if (data.nickname) {
                currentUserRealName = data.nickname;
                initNicknameSelect();
            }

            if (url) {
                document.getElementById("avatarImg").src = getFreshAvatar(url);
                document.getElementById("avatarImg").style.display = "block";
                document.getElementById("avatarPlaceholder").style.display = "none";
                document.getElementById('profileAvatarPreview').src = getFreshAvatar(url);
                document.getElementById('profileAvatarPreview').hidden = false;
                document.getElementById('profileAvatarFallback').hidden = true;
            } else {
                document.getElementById("avatarImg").style.display = "none";
                document.getElementById("avatarPlaceholder").style.display = "block";
                document.getElementById('profileAvatarPreview').hidden = true;
                document.getElementById('profileAvatarFallback').hidden = false;
            }

            refreshNotificationDot();
        }

        const pendingAvatarUploads = new WeakMap();
        async function avatarRequest(path, options, stage) {
            let response;
            try {
                response = await request(path, options);
            } catch {
                throw new Error(stage + '：网络连接中断或请求超时，请再次保存');
            }
            const result = await response.json().catch(() => null);
            if (response.ok && result) return result;
            const messages = {
                authentication_required: '登录已过期，请重新登录',
                invalid_origin: '当前站点未获准提交，请从论坛主页重新进入',
                invalid_request: '服务器未能读取提交的数据',
                invalid_avatar: '账号与头像地址不匹配，请重新上传',
                invalid_upload: '服务器未能读取上传文件',
                invalid_avatar_image: '服务器未能验证裁切后的 WebP 图片',
                avatar_storage_limit: '头像存储数量已达上限，请稍后再试',
                avatar_storage_denied: '头像存储权限不足，请联系管理员',
                avatar_bucket_missing: '头像存储桶不存在，请联系管理员',
                avatar_storage_auth_failed: '头像存储认证失败，请联系管理员',
                avatar_storage_unavailable: '头像存储服务暂不可用',
                avatar_type_rejected: '头像存储桶不接受这种图片格式，请联系管理员',
                avatar_too_large: '头像超过存储桶的大小上限，请联系管理员',
                configuration_error: '论坛服务配置不完整，请联系管理员',
                session_unavailable: '登录服务暂不可用',
                avatar_object_missing: '已上传的头像不可用，请再次保存以重新上传',
                profile_not_updated: '账号资料未更新，请重新登录后再试',
                profile_save_failed: '账号资料写入失败'
            };
            const reason = Object.hasOwn(messages, result?.error) ? messages[result.error] : '服务未能完成请求';
            // The server names the step that failed and what Storage answered.
            const detail = result?.detail;
            const cause = detail ? [detail.stage, detail.status, detail.code, detail.reason].filter(Boolean).join(' · ') : '';
            const error = new Error(stage + '：' + reason + '（HTTP ' + response.status + (cause ? '；' + cause : '') + '）');
            error.code = result?.error;
            throw error;
        }

        async function persistAvatar(file) {
            let publicUrl = pendingAvatarUploads.get(file);
            if (!publicUrl) {
                const form = new FormData();
                form.append('kind', 'avatar');
                form.append('files', file, file.name);
                const result = await avatarRequest('/api/uploads', { method: 'POST', credentials: 'include', body: form }, '上传头像');
                publicUrl = result.urls?.[0];
                if (typeof publicUrl !== 'string' || !publicUrl) throw new Error('服务器未返回头像地址');
                pendingAvatarUploads.set(file, publicUrl);
            }
            const result = await avatarRequest('/api/profile', { method: 'PUT', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ avatarUrl: publicUrl }) }, '保存账号资料');
            if (result.avatarUrl !== publicUrl) throw new Error('头像保存结果不一致');
            return publicUrl;
        }

        async function uploadAvatar(file) {
            let publicUrl;
            for (let attempt = 0; attempt < 2; attempt++) {
                try {
                    publicUrl = await persistAvatar(file);
                    break;
                } catch (error) {
                    if (error.code !== 'avatar_object_missing' && error.code !== 'invalid_avatar') throw error;
                    pendingAvatarUploads.delete(file);
                    if (attempt === 1) throw error;
                }
            }
            avatarImg.src = publicUrl;
            avatarImg.style.display = 'block';
            avatarPlaceholder.style.display = 'none';
            const preview = document.getElementById('profileAvatarPreview');
            preview.src = publicUrl; preview.hidden = false;
            document.getElementById('profileAvatarFallback').hidden = true;
            showProfileStatus('头像更新成功。', 'success');
        }

        // The editor and Cropper are only fetched when someone changes their avatar.
        let avatarAssetsPromise;
        function loadAvatarAssets() {
            if (avatarAssetsPromise) return avatarAssetsPromise;
            const assets = [
                ['link', './vendor/cropper.min.css?v=23679f552c'], ['link', './avatar-editor.css?v=617471711d'],
                ['script', './vendor/cropper.min.js?v=6290a3fa58'], ['script', './avatar-editor.js?v=80ad5bdfa7']
            ];
            const elements = [];
            const loads = assets.map(([tag, url]) => new Promise((resolve, reject) => {
                const element = document.createElement(tag);
                elements.push(element);
                if (tag === 'link') { element.rel = 'stylesheet'; element.href = url; }
                else element.src = url;
                element.onload = resolve;
                element.onerror = reject;
                document.head.append(element);
            }));
            let timer;
            const timeout = new Promise((_, reject) => { timer = setTimeout(reject, 15000); });
            avatarAssetsPromise = Promise.race([Promise.all(loads), timeout]).then(() => {
                if (!window.Cropper || !window.RootedVoxAvatarEditor) throw new Error('加载失败');
            }).catch(() => {
                elements.forEach(element => element.remove());
                avatarAssetsPromise = null;
                throw new Error('头像组件加载失败，请重试');
            }).finally(() => clearTimeout(timer));
            return avatarAssetsPromise;
        }

        function showProfileStatus(message, type = '') {
            const node = document.getElementById('profileStatus');
            node.textContent = message;
            node.className = `profile-status ${type}`.trim();
        }

        function closeProfileModal() {
            hideModal(document.getElementById('profileModal'));
            showProfileStatus('');
        }

        async function saveProfileNickname() {
            const input = document.getElementById('profileNickname');
            const nickname = input.value.normalize('NFKC').replace(/\s+/g, ' ').trim();
            if (!nickname || nickname.length > 40) {
                showProfileStatus('昵称应为 1–40 个字符。', 'error');
                input.focus();
                return;
            }
            const button = document.getElementById('saveProfile');
            button.disabled = true;
            showProfileStatus('正在保存…');
            try {
                const response = await request('/api/profile', {
                    method: 'PUT', credentials: 'include',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ nickname })
                });
                const result = await response.json().catch(() => ({}));
                if (!response.ok) {
                    throw new Error(result.error === 'invalid_nickname' ? '该昵称不可使用，请换一个' : '保存失败');
                }
                currentUserRealName = result.nickname || nickname;
                input.value = currentUserRealName;
                initNicknameSelect();
                showProfileStatus('昵称已更新，之后发布的留言会使用新昵称。', 'success');
            } catch (error) {
                showProfileStatus(error.message || '保存失败', 'error');
            } finally {
                button.disabled = false;
            }
        }

        async function initAuth() {
            try {
                const session = await RootedVoxAuth.getSession();
                if (!session?.authenticated) return false;
                currentUser = session.user;
                userId = session.user.id;
                currentUserEmail = session.user.email || '';
                currentUserRealName = session.user.name || session.user.email?.split('@')[0] || '用户';
                return true;
            } catch {
                return false;
            }
        }

        // On phones the form stays folded so the feed is the first thing on screen.
        function setComposeOpen(open) {
            const toggle = document.getElementById('composeToggle');
            toggle.setAttribute('aria-expanded', String(open));
            toggle.textContent = open ? '收起' : '写留言';
        }

        function initGuestMode() {
            const nickname = document.getElementById('nicknameSelect');
            nickname.innerHTML = '<option>登录后可发布</option>';
            nickname.disabled = true;
            document.getElementById('zoneSelect').disabled = true;
            const email = document.getElementById('contactEmail');
            email.value = '';
            email.placeholder = '登录后与账号绑定';
            document.getElementById('messageContent').disabled = true;
            document.getElementById('messagePicFile').disabled = true;
            document.getElementById('fileUploadContainer').style.opacity = '.55';
            const submit = document.getElementById('submitBtn');
            submit.textContent = '登录后发布';
            submit.onclick = () => RootedVoxAuth.handleLogin();
            const toggle = document.getElementById('composeToggle');
            toggle.textContent = '登录后发布';
            toggle.onclick = () => RootedVoxAuth.handleLogin();
            document.getElementById('avatarBtn').hidden = true;
            const login = document.getElementById('logoutBtn');
            login.textContent = '登录';
            showFormStatus('已审核留言可直接浏览；发布、回复和通知需要登录。');
        }

        function initNicknameSelect() {
            const select = document.getElementById('nicknameSelect');
            const wasAnonymous = select.value === '匿名用户';
            select.innerHTML = '';
            const optionReal = document.createElement('option');
            optionReal.value = currentUserRealName;
            optionReal.textContent = currentUserRealName;
            const optionAnon = document.createElement('option');
            optionAnon.value = '匿名用户';
            optionAnon.textContent = '匿名用户';
            select.appendChild(optionReal);
            select.appendChild(optionAnon);
            select.value = wasAnonymous ? '匿名用户' : currentUserRealName;
        }

        let previewObjectUrls = [];
        function clearImagePreviews() {
            document.getElementById('previewContainer').replaceChildren();
            previewObjectUrls.forEach(url => URL.revokeObjectURL(url));
            previewObjectUrls = [];
        }

        function previewImages(input) {
            clearImagePreviews();
            const files = Array.from(input.files);
            // Validate the whole selection before allocating preview resources.
            if (files.length > MAX_IMAGES) {
                showFormStatus(`最多只能上传 ${MAX_IMAGES} 张图片。`, 'error');
                input.value = '';
                return;
            }
            for (const file of files) {
                if (!file.type.startsWith('image/')) {
                    showFormStatus('仅支持图片文件。', 'error');
                    input.value = '';
                    return;
                }
                if (file.size > MAX_SIZE) {
                    showFormStatus(`“${file.name}”超过 5MB，请压缩后重试。`, 'error');
                    input.value = '';
                    return;
                }
            }
            const fragment = document.createDocumentFragment();
            for (const file of files) {
                const url = URL.createObjectURL(file);
                previewObjectUrls.push(url);
                const img = document.createElement('img');
                img.src = url;
                img.alt = file.name;
                img.className = 'file-preview';
                fragment.appendChild(img);
            }
            document.getElementById('previewContainer').appendChild(fragment);
        }

        async function uploadImages(files) {
            if (!files || files.length === 0) return [];
            const progressBar = document.getElementById('progressBar');
            const uploadProgress = document.getElementById('uploadProgress');
            uploadProgress.style.display = 'block';
            progressBar.style.width = '0%';
            try {
                progressBar.style.width = '45%';
                const urls = await ForumUI.uploadFiles(files);
                progressBar.style.width = '100%';
                return urls;
            } finally {
                uploadProgress.style.display = 'none';
            }
        }

        function savePostDraft() {
            const text = document.getElementById('messageContent').value;
            const fields = { text, zone: document.getElementById('zoneSelect').value,
                anonymous: document.getElementById('nicknameSelect').value === '匿名用户' };
            ForumDrafts.save('post', fields);
            document.getElementById('discardDraft').hidden = !ForumDrafts.get('post');
        }

        function initPostDraft() {
            ForumDrafts.bind(userId);
            const text = document.getElementById('messageContent');
            const zone = document.getElementById('zoneSelect');
            const nickname = document.getElementById('nicknameSelect');
            const discard = document.getElementById('discardDraft');
            const draft = ForumDrafts.get('post');
            if (draft) {
                text.value = draft.text;
                zone.value = draft.zone || zone.value;
                if (draft.anonymous) nickname.value = '匿名用户';
                document.getElementById('contentCount').textContent = text.value.length + ' / 1000';
                showFormStatus(draft.attachments?.length ? '已恢复草稿和已上传的图片。' : '已恢复文字草稿。');
                for (const src of draft.attachments || []) {
                    const img = document.createElement('img');
                    img.className = 'file-preview';
                    img.src = src;
                    img.alt = '已上传的图片';
                    document.getElementById('previewContainer').append(img);
                }
                discard.hidden = false;
                setComposeOpen(true);
            }
            text.addEventListener('input', savePostDraft);
            zone.addEventListener('change', savePostDraft);
            nickname.addEventListener('change', savePostDraft);
            document.getElementById('messagePicFile').addEventListener('change', () => {
                ForumDrafts.save('post', { text: text.value, attachments: [] });
                savePostDraft();
            });
            discard.onclick = () => {
                ForumDrafts.clear('post');
                text.value = '';
                document.getElementById('messagePicFile').value = '';
                clearImagePreviews();
                document.getElementById('contentCount').textContent = '0 / 1000';
                discard.hidden = true;
                showFormStatus('');
            };
        }

        async function postMessage() {
            const anonymous = document.getElementById('nicknameSelect').value === '匿名用户';
            const content = document.getElementById('messageContent').value.trim();
            const zone = document.getElementById('zoneSelect').value;
            const files = document.getElementById('messagePicFile').files;
            const submitBtn = document.getElementById('submitBtn');
            if (!content) {
                showFormStatus('请先写下留言内容。', 'error');
                document.getElementById('messageContent').focus();
                return;
            }
            if (submitBtn.disabled) return;
            submitBtn.disabled = true;
            submitBtn.textContent = '发布中...';
            try {
                savePostDraft();
                const original = ForumDrafts.get('post');
                const picUrls = files.length ? await uploadImages(Array.from(files)) : original?.attachments || [];
                const payload = { content, zone, anonymous, imageUrls: picUrls };
                const submitted = ForumDrafts.prepare('post', original, payload);
                showFormStatus('正在上传并提交…');
                const response = await request('/api/messages', {
                    method: 'POST', credentials: 'include',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload)
                });
                if (response.status === 401) return RootedVoxAuth.handleLogin('/messages' + location.search);
                if (!response.ok) throw new Error('留言服务暂时不可用');
                const result = await response.json();
                showFormStatus('发布成功，审核结果会通过站内通知告知你。', 'success');
                if (result.published === true) loadMainMessages(false);
                if (!submitted || ForumDrafts.get('post') !== submitted) return;
                ForumDrafts.clear('post');
                document.getElementById('discardDraft').hidden = true;
                document.getElementById('messageContent').value = '';
                document.getElementById('contentCount').textContent = '0 / 1000';
                document.getElementById('messagePicFile').value = '';
                clearImagePreviews();
            } catch (error) {
                if (error.message === 'login_required') return RootedVoxAuth.handleLogin('/messages' + location.search);
                showFormStatus('发布失败：' + (error.message || error), 'error');
            } finally {
                submitBtn.disabled = false;
                submitBtn.textContent = '发布留言';
            }
        }

        function showFormStatus(message, type = '') {
            const node = document.getElementById('formStatus');
            if (!node) return;
            node.textContent = message;
            node.className = `form-status${type ? ` ${type}` : ''}`;
        }

        async function loadMainMessages(isLoadMore = false) {
            if (isLoadMore && (!hasMore || isLoadingMore)) return;
            if (abortController) abortController.abort();
            const controller = new AbortController();
            abortController = controller;
            const signal = controller.signal;
            isLoadingMore = true;
            const container = document.getElementById('messageContainer');
            document.querySelector('.feed-retry')?.remove();
            const loadMoreWrap = document.getElementById('loadMoreWrapper');

            if (!isLoadMore) {
                container.innerHTML = '<div class="loading">加载留言中...</div>';
                document.getElementById('messageFeed').scrollTop = 0;
                pageAutoLoads = 0;
                document.getElementById('feedMore')?.setAttribute('hidden', '');
                currentPage = 0;
                feedCursor = null;
                hasMore = true;
                if (loadMoreWrap) loadMoreWrap.remove();
                document.querySelector('.no-more-tip')?.remove();
            } else {
                if (!document.querySelector('.list-loading-tip')) {
                    container.insertAdjacentHTML('beforeend', '<div class="loading list-loading-tip">加载更多...</div>');
                }
            }

            try {
                if (!window.RootedVoxPublicData) throw new Error('留言服务暂时不可用');
                const result = await RootedVoxPublicData.listMessages({
                    page: currentPage, cursor: feedCursor,
                    limit: PAGE_SIZE,
                    sort: activeSort,
                    search: activeSearch,
                    zone: activeZone,
                    signal
                });
                const data = result.messages || [];
                if (signal.aborted) return;
                hasMore = result.hasMore === true;

                const loadingTip = document.querySelector('.list-loading-tip');
                if (loadingTip) loadingTip.remove();

                if (!data || data.length === 0) {
                    if (!isLoadMore) {
                        container.innerHTML = `<div class="empty-message">${activeSearch ? '没有找到相关留言，试试其他关键词。' : '暂无留言，快来发布第一条留言吧！'}</div>`;
                    }
                    hasMore = false;
                    showNoMoreTip();
                    return;
                }

                feedCursor = result.nextCursor || null;

                let html = '';
                for (let msg of data) {
                    const parsedContent = parseMessageContent(msg.content, msg.zone);
                    const time = new Date(msg.created_at).toLocaleString('zh-CN', { dateStyle: 'short', timeStyle: 'short' });
                    let imageHtml = '';
                    if (msg.pic_url && msg.pic_url.length > 0) {
                        imageHtml = '<div class="message-images">';
                        for (let url of msg.pic_url) {
                            imageHtml += `<img src="${escapeHtml(url)}" class="message-image" alt="${escapeHtml(msg.username)} 发布的图片" loading="lazy" tabindex="0">`;
                        }
                        imageHtml += '</div>';
                    }

                    html += `
                    <div class="message-item" id="message-${msg.id}" data-avatar-url="${escapeHtml(msg.avatar_url || '')}" data-official="${msg.is_official === true}" data-developer="${msg.is_developer === true}" data-anonymous="${msg.username === '匿名用户' ? 'true' : 'false'}">
                        <div class="message-avatar-box"></div>
                        <div style="flex:1">
                            <div class="message-header">
                                <span class="message-author">${escapeHtml(msg.username)}</span>
                                <span class="message-time">${time}</span>
                            </div>
                            <span class="message-zone">${escapeHtml(parsedContent.zone)}</span>
                            <div class="message-content">${escapeHtml(parsedContent.text).replace(/\n/g, '<br>')}</div>
                            ${imageHtml}
                            <a class="detail-btn" href="details.html?id=${encodeURIComponent(msg.id)}">🔍 查看详情</a>
                        </div>
                    </div>`;
                }

                if (!html && !isLoadMore) {
                    container.innerHTML = '<div class="empty-message">这个分区暂时没有留言，来发布第一条吧！</div>';
                    showNoMoreTip();
                    return;
                }

                if (isLoadMore) {
                    container.insertAdjacentHTML('beforeend', html);
                    currentPage++;
                } else {
                    container.innerHTML = html;
                    currentPage++;
                }

                if (!hasMore) {
                    showNoMoreTip();
                }

                renderMessageAvatars(data.map(msg => document.getElementById(`message-${msg.id}`)).filter(Boolean));
                // A tall form can leave the first page shorter than the feed viewport.
                requestAnimationFrame(() => {
                    if (!signal.aborted && hasMore && feedHasRoom()) loadMainMessages(true);
                });
            } catch (err) {
                if (signal.aborted) return;
                document.querySelector('.list-loading-tip')?.remove();
                if (!isLoadMore) container.innerHTML = '';
                const retry = document.createElement('button');
                retry.type = 'button';
                retry.className = 'detail-btn feed-retry';
                retry.textContent = isLoadMore ? '下一页加载失败，点击重试' : '加载失败，点击重试';
                retry.onclick = () => loadMainMessages(isLoadMore);
                container.append(retry);
            } finally {
                if (abortController === controller) isLoadingMore = false;
            }
        }

        // Desktop scrolls the feed in its own box; on phones the feed grows with the page.
        function feedScrollsWithPage(feed) {
            return typeof getComputedStyle === 'function' && getComputedStyle(feed).overflowY === 'visible';
        }

        // True when the rendered posts end above the fold, so the next page is needed now.
        function feedHasRoom() {
            const feed = document.getElementById('messageFeed');
            if (feedScrollsWithPage(feed)) return feed.getBoundingClientRect().bottom <= window.innerHeight;
            return feed.clientHeight > 0 && feed.scrollHeight <= feed.clientHeight;
        }

        function showNoMoreTip() {
            const wrap = document.getElementById('loadMoreWrapper');
            if (wrap) wrap.remove();
            document.getElementById('feedMore')?.setAttribute('hidden', '');
            const container = document.getElementById('messageContainer');
            if (!document.querySelector('.no-more-tip')) {
                container.insertAdjacentHTML('afterend', `
                    <div class="empty-message no-more-tip" style="padding:20px 0;">— 已经到底啦，没有更多留言 —</div>
                `);
            }
        }

        document.addEventListener('DOMContentLoaded', async function () {
            const authReady = initAuth();
            const submitButton = document.getElementById('submitBtn');
            submitButton.disabled = true;
            // Bound here, not with on* attributes: the Content-Security-Policy blocks those.
            submitButton.onclick = () => postMessage();
            const picker = document.getElementById('messagePicFile');
            picker.addEventListener('change', () => previewImages(picker));
            const composeToggle = document.getElementById('composeToggle');
            composeToggle.onclick = () => setComposeOpen(composeToggle.getAttribute('aria-expanded') !== 'true');

            const contentInput = document.getElementById('messageContent');
            contentInput.addEventListener('input', () => {
                document.getElementById('contentCount').textContent = `${contentInput.value.length} / 1000`;
                if (document.getElementById('formStatus').classList.contains('error')) showFormStatus('');
            });

            const search = document.getElementById('messageSearch');
            const sort = document.getElementById('messageSort');
            const zone = document.getElementById('messageZoneFilter');
            const params = new URLSearchParams(location.search);
            const initialZone = params.get('zone') === '校园生活' ? '日常分享' : params.get('zone');
            activeZone = [...zone.options].some(o => o.value === initialZone) ? initialZone : 'all';
            activeSort = params.get('sort') === 'oldest' ? 'oldest' : 'newest';
            activeSearch = (params.get('q') || '').trim().slice(0, 100);
            zone.value = activeZone;
            sort.value = activeSort;
            search.value = activeSearch;

            function applyFilters() {
                clearTimeout(searchTimer);
                const text = search.value.trim();
                if (text === activeSearch && zone.value === activeZone && sort.value === activeSort) return;
                activeSearch = text;
                activeSort = sort.value;
                activeZone = zone.value;
                const url = new URL(location.href);
                for (const [key, value] of [['q', text], ['zone', activeZone === 'all' ? '' : activeZone],
                    ['sort', activeSort === 'newest' ? '' : activeSort]]) {
                    if (value) url.searchParams.set(key, value);
                    else url.searchParams.delete(key);
                }
                history.replaceState(history.state, '', url);
                loadMainMessages(false);
            }
            search.addEventListener('input', event => {
                clearTimeout(searchTimer);
                if (!event.isComposing) searchTimer = setTimeout(applyFilters, 280);
            });
            search.addEventListener('compositionend', applyFilters);
            zone.addEventListener('change', applyFilters);
            sort.addEventListener('change', applyFilters);

            // Public browsing must not wait for session or profile requests.
            loadMainMessages(false);
            const messageFeed = document.getElementById('messageFeed');
            messageFeed.addEventListener('scroll', () => {
                if (isLoadingMore || !hasMore || document.querySelector('.feed-retry')) return;
                clearTimeout(scrollTimeout);
                scrollTimeout = setTimeout(() => {
                    if (messageFeed.scrollTop + messageFeed.clientHeight >= messageFeed.scrollHeight - SCROLL_THRESHOLD) {
                        loadMainMessages(true);
                    }
                }, 120);
            });

            // A feed that grows with the page would keep the footer out of reach, so after
            // a few automatic pages a button takes over.
            const feedMore = document.getElementById('feedMore');
            feedMore.onclick = async () => {
                feedMore.hidden = true;
                pageAutoLoads = 0;
                await loadMainMessages(true);
            };
            window.addEventListener('scroll', () => {
                if (isLoadingMore || !hasMore || !feedScrollsWithPage(messageFeed) || document.querySelector('.feed-retry')) return;
                if (pageAutoLoads >= PAGE_AUTO_LOADS) { feedMore.hidden = false; return; }
                clearTimeout(scrollTimeout);
                scrollTimeout = setTimeout(() => {
                    if (messageFeed.getBoundingClientRect().bottom > window.innerHeight + SCROLL_THRESHOLD) return;
                    pageAutoLoads++;
                    loadMainMessages(true);
                }, 120);
            }, { passive: true });

            const loggedIn = await authReady;
            if (loggedIn) {
                document.getElementById('contactEmail').value = currentUserEmail;
                initNicknameSelect();
                initPostDraft();
            } else {
                initGuestMode();
            }
            document.getElementById('submitBtn').disabled = false;

            const logoutButton = document.getElementById('logoutBtn');
            let logoutArmed = null;
            logoutButton.onclick = loggedIn
            ? async () => {
                // A second press within a few seconds confirms; no blocking dialog.
                if (!logoutArmed) {
                    logoutButton.textContent = '再点一次确认退出';
                    logoutArmed = setTimeout(() => { logoutArmed = null; logoutButton.textContent = '退出登录'; }, 4000);
                    return;
                }
                clearTimeout(logoutArmed);
                ForumDrafts.logout();
                await RootedVoxAuth.logout('/main');
            }
            : () => RootedVoxAuth.handleLogin();

            const avatarBtn = document.getElementById('avatarBtn');
            const avatarDropdown = document.getElementById('avatarDropdown');
            function setAvatarMenu(open) {
                avatarDropdown.style.display = open ? 'block' : 'none';
                avatarBtn.setAttribute('aria-expanded', String(open));
            }
            avatarBtn.onclick = (e) => {
                e.stopPropagation();
                setAvatarMenu(avatarDropdown.style.display !== 'block');
            };

            document.addEventListener('click', (e) => {
                if (!avatarBtn.contains(e.target) && !avatarDropdown.contains(e.target)) {
                    setAvatarMenu(false);
                }
            });

            document.getElementById('openProfile').onclick = () => {
                showModal(document.getElementById('profileModal'), null, avatarBtn);
                setAvatarMenu(false);
                const nicknameInput = document.getElementById('profileNickname');
                nicknameInput.value = currentUserRealName;
                nicknameInput.focus();
            };

            const changeAvatar = document.getElementById('profileAvatarButton');
            changeAvatar.onclick = async () => {
                if (changeAvatar.disabled) return;
                changeAvatar.disabled = true;
                try {
                    await loadAvatarAssets();
                    closeProfileModal();
                    await window.RootedVoxAvatarEditor.open({ name: currentUserRealName, onSave: uploadAvatar });
                } catch (error) {
                    notify(error.message || '头像组件加载失败，请重试', 'error');
                } finally { changeAvatar.disabled = false; }
            };

            document.getElementById('saveProfile').onclick = saveProfileNickname;
            document.getElementById('closeProfileModal').onclick = closeProfileModal;
            document.getElementById('cancelProfile').onclick = closeProfileModal;
            document.getElementById('profileModal').onclick = (e) => {
                if (e.target === document.getElementById('profileModal')) closeProfileModal();
            };


            document.getElementById('openNotifications').onclick = async () => {
                setAvatarMenu(false);
                await openNotifications(false);
            };

            document.getElementById('closeModal').onclick = () => {
                hideModal(document.getElementById('notificationModal'));
            };

            document.getElementById('notificationModal').onclick = (e) => {
                if (e.target === document.getElementById('notificationModal')) {
                    hideModal(document.getElementById('notificationModal'));
                }
            };

            document.addEventListener('keydown', (event) => {
                if (event.key === 'Escape') {
                    hideModal(document.getElementById('notificationModal'));
                    closeProfileModal();
                }
                if (event.key === 'Tab') trapModalFocus(event);
            });

            const notifyModalBody = document.getElementById("notificationList");
            notifyModalBody.addEventListener("scroll", async () => {
                if (!notifyHasMore || notifyLoading) return;
                const scrollTop = notifyModalBody.scrollTop;
                const viewHeight = notifyModalBody.clientHeight;
                const totalHeight = notifyModalBody.scrollHeight;
                if (scrollTop + viewHeight >= totalHeight - 80) {
                    await openNotifications(true);
                }
            });

            if (loggedIn) {
                initUserExtra().catch(() => showFormStatus('个人资料暂时无法同步，可稍后重新打开页面重试。', 'error'));
            }
        });

        window.addEventListener('beforeunload', () => {
            clearImagePreviews();
            if (abortController) abortController.abort();
            if (scrollTimeout) clearTimeout(scrollTimeout);
        });

// Shared by the community feed, thread and homepage.
(() => {
  function escapeHtml(value) {
      return String(value ?? '').replace(/[&<>"']/g, char => ({
          '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
      })[char]);
  }
  const MESSAGE_ZONES = [
      { label: '学习互助', keywords: ['学习', '作业', '考试', '课程', '笔记', '竞赛', '选课', '大学'] },
      { label: '活动社团', keywords: ['活动', '社团', '比赛', '演出', '运动', '招新', '音乐', '篮球', '足球'] },
      { label: '失物招领', keywords: ['失物', '招领', '丢了', '捡到', '寻找', '遗失', '找到'] }
  ];

  function parseMessageContent(content = '', storedZone = '') {
      const marker = content.match(/^【([^】]+)】\s*/);
      const validZones = ['日常分享', ...MESSAGE_ZONES.map(zone => zone.label)];
      if (storedZone === '校园生活') storedZone = '日常分享';
      const markerZone = marker?.[1] === '校园生活' ? '日常分享' : marker?.[1];
      const explicitZone = validZones.includes(markerZone) ? markerZone : '';
      const text = explicitZone ? content.replace(/^【[^】]+】\s*/, '') : content;
      const inferredZone = MESSAGE_ZONES.find(zone => zone.keywords.some(word => text.includes(word)))?.label;
      return { zone: validZones.includes(storedZone) ? storedZone : (explicitZone || inferredZone || '日常分享'), text };
  }

  const avatarCacheVersion = Date.now();
  function getFreshAvatar(src) {
      if (!src) return '';
      // Content-addressed avatars are immutable; legacy paths refresh once per visit.
      if (/\.[a-f0-9]{64}\.webp(?:[?#]|$)/.test(src)) return src;
      return src + (src.includes('?') ? '&' : '?') + 't=' + avatarCacheVersion;
  }

  function renderMessageAvatars(items = document.querySelectorAll(".message-item")) {
      items.forEach(el => {
          const avatarUrl = el.dataset.avatarUrl;

          const box = el.querySelector(".message-avatar-box");
          const username = el.querySelector(".message-author")?.textContent || "";
          const firstChar = username.charAt(0) || "?";

          const isDeveloper = el.dataset.official === "true" || el.dataset.developer === "true";
          const renderKey = JSON.stringify([avatarUrl, username, isDeveloper]);
          if (box.dataset.renderKey === renderKey) return;
          box.dataset.renderKey = renderKey;

          if (username === "匿名用户") {
              // A neutral silhouette: the old solid black disc vanished on the dark theme.
              box.innerHTML = `<div class="anonymous-avatar" aria-hidden="true"><svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><circle cx="12" cy="8.5" r="4"/><path d="M4 20.5c.6-4.2 3.9-6.5 8-6.5s7.4 2.3 8 6.5z"/></svg></div>`;
              return;
          }

          // The picture, or the first character of the name when there is none.
          const face = avatarUrl
              ? `<img loading="lazy" decoding="async" width="38" height="38" alt="" src="${escapeHtml(getFreshAvatar(avatarUrl))}" style="width:38px;height:38px;border-radius:50%;object-fit:cover;${isDeveloper ? 'display:block;' : ''}">`
              : `<div style="width:38px;height:38px;border-radius:50%;background:var(--theme-soft);display:flex;align-items:center;justify-content:center;color:var(--ink);">${escapeHtml(firstChar)}</div>`;
          // Developers and the official account get a gold ring and a Dev badge around it.
          box.innerHTML = isDeveloper
              ? `<div style="position:relative;padding:2px;border-radius:50%;background:linear-gradient(135deg,#ffd700,#ff9500);"><div style="border-radius:50%;background:#fff;padding:1px;">${face}</div><span style="position:absolute;right:-6px;bottom:-2px;font-size:9px;font-weight:bold;color:#171000;background:#e3ac21;padding:1px 4px;border-radius:6px;white-space:nowrap;z-index:2;">Dev</span></div>`
              : face;
      });
  }

  function compressImage(file, options = {}) {
      return new Promise((resolve, reject) => {
          if (!file.type.startsWith('image/')) {
              return resolve(file);
          }
          const defaultOpts = {
              maxWidth: 1920,
              maxHeight: 1080,
              quality: 0.6,
              mimeType: "image/webp"
          };
          const opts = { ...defaultOpts, ...options };
          const source = URL.createObjectURL(file);
          const img = new Image();
          img.onload = () => {
              URL.revokeObjectURL(source);
              let width = img.width;
              let height = img.height;
              const scaleRatio = Math.min(opts.maxWidth / width, opts.maxHeight / height);
              if (scaleRatio < 1) {
                  width = width * scaleRatio;
                  height = height * scaleRatio;
              }
              const canvas = document.createElement("canvas");
              canvas.width = width;
              canvas.height = height;
              const ctx = canvas.getContext("2d");
              ctx.drawImage(img, 0, 0, width, height);
              const encode = (type, quality) => new Promise(done => canvas.toBlob(done, type, quality));
              (async () => {
                  let blob = await encode(opts.mimeType, opts.quality);
                  // Safari cannot export WebP and hands back a PNG, which for a photo is
                  // several times larger than the original. Photos are re-encoded as JPEG;
                  // PNG and GIF sources keep the PNG, as they may be transparent.
                  if (blob && blob.type !== opts.mimeType && !['image/png', 'image/gif'].includes(file.type)) {
                      blob = await encode("image/jpeg", 0.7) || blob;
                  }
                  if (!blob) return reject(new Error("图片压缩失败"));
                  const suffixes = { "image/webp": ".webp", "image/png": ".png", "image/jpeg": ".jpg" };
                  const suffix = suffixes[blob.type];
                  if (!suffix) return reject(new Error("图片格式不受支持"));
                  // Never upload a "compressed" copy that is bigger than an accepted original.
                  if (blob.size >= file.size && ['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) {
                      return resolve(file);
                  }
                  const newFileName = file.name.replace(/(\.\w+)$/, suffix);
                  resolve(new File([blob], newFileName, { type: blob.type }));
              })().catch(() => reject(new Error("图片压缩失败")));
          };
          img.onerror = () => { URL.revokeObjectURL(source); reject(new Error("图片加载失败")); };
          img.src = source;
      });
  }

  const uploads = new WeakMap();
  const uploadReuseMs = 24 * 60 * 60 * 1000;
  async function uploadFiles(files) {
      const selected = Array.from(files);
      if (selected.length > 5 || selected.some(file => !file.type.startsWith('image/') || file.size > 5 * 1024 * 1024)) {
          throw new Error('最多选择 5 张图片，每张不超过 5MB');
      }
      const missing = selected.filter(file => !uploads.has(file) || Date.now() - uploads.get(file).at > uploadReuseMs);
      if (missing.length) {
          const form = new FormData();
          form.append('kind', 'message');
          for (const file of missing) {
              const image = file.size < 100 * 1024 ? file : await compressImage(file);
              form.append('files', image, image.name);
          }
          const response = await request('/api/uploads', { method: 'POST', credentials: 'include', body: form });
          if (response.status === 401) throw new Error('login_required');
          if (!response.ok) throw new Error('图片上传失败');
          const { urls } = await response.json();
          if (urls?.length !== missing.length) throw new Error('图片上传未完成');
          missing.forEach((file, index) => uploads.set(file, { url: urls[index], at: Date.now() }));
      }
      return selected.map(file => uploads.get(file).url);
  }
  // Thumbnails open in an in-page viewer instead of a new tab. The listeners are
  // delegated because feeds and threads add images after the page has loaded.
  let viewer;
  function openImage(image) {
      const source = image.currentSrc || image.src;
      if (!viewer) {
          viewer = document.createElement('dialog');
          viewer.className = 'image-viewer';
          const close = document.createElement('button');
          close.type = 'button';
          close.textContent = '×';
          close.setAttribute('aria-label', '关闭图片');
          viewer.append(close, document.createElement('img'));
          viewer.addEventListener('click', () => viewer.close());
          document.body.append(viewer);
      }
      if (typeof viewer.showModal !== 'function') return window.open(source, '_blank', 'noopener');
      const full = viewer.querySelector('img');
      full.src = source;
      full.alt = image.alt;
      viewer.showModal();
  }
  if (typeof document !== 'undefined' && document.addEventListener) {
      document.addEventListener('click', event => {
          const image = event.target.closest?.('img.message-image');
          if (image) openImage(image);
      });
      document.addEventListener('keydown', event => {
          if (event.key === 'Enter' && event.target.matches?.('img.message-image')) openImage(event.target);
      });
  }
  // Short messages shown in the page. Unlike alert() they do not block the page, and a
  // live region announces them to screen readers.
  let toast, toastTimer;
  function notify(message, type = '') {
      if (!toast) {
          toast = document.createElement('div');
          document.body.append(toast);
      }
      toast.setAttribute('role', type === 'error' ? 'alert' : 'status');
      toast.className = `forum-toast show ${type}`.trim();
      toast.textContent = message;
      clearTimeout(toastTimer);
      toastTimer = setTimeout(() => { toast.className = `forum-toast ${type}`.trim(); }, 5000);
  }
  // Post times read like the homepage ("5 分钟前") for the first week, then as a date.
  // The exact time stays available as the element's tooltip and datetime.
  function formatPostTime(value) {
      const date = new Date(value);
      if (Number.isNaN(date.getTime())) return { text: '', title: '', iso: '' };
      const locale = document.documentElement?.lang === 'en' ? 'en' : 'zh-CN';
      const title = date.toLocaleString(locale, { dateStyle: 'medium', timeStyle: 'short' });
      const seconds = Math.max(1, Math.floor((Date.now() - date.getTime()) / 1000));
      const relative = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
      let text;
      if (seconds < 60) text = locale === 'en' ? 'just now' : '刚刚';
      else if (seconds < 3600) text = relative.format(-Math.floor(seconds / 60), 'minute');
      else if (seconds < 86400) text = relative.format(-Math.floor(seconds / 3600), 'hour');
      else if (seconds < 7 * 86400) text = relative.format(-Math.floor(seconds / 86400), 'day');
      else text = date.toLocaleDateString(locale, date.getFullYear() === new Date().getFullYear()
          ? { month: 'short', day: 'numeric' } : { year: 'numeric', month: 'short', day: 'numeric' });
      return { text, title, iso: date.toISOString() };
  }
  function postTimeHtml(value) {
      const time = formatPostTime(value);
      return `<time class="message-time" datetime="${escapeHtml(time.iso)}" title="${escapeHtml(time.title)}">${escapeHtml(time.text)}</time>`;
  }
  window.ForumUI = { parseMessageContent, escapeHtml, renderMessageAvatars, getFreshAvatar, uploadFiles, notify, formatPostTime, postTimeHtml };
})();

// Shared by the community feed, thread and homepage.
(() => {
  function escapeHtml(value) {
      return String(value ?? '').replace(/[&<>"']/g, char => ({
          '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
      })[char]);
  }
  const DEVELOPER_NICKNAMES = [
      "Sam.Li",
      "Jerry",
      "Maod1e",
      "bYcHhh",
      "曹颢喆 Jerry"
  ];

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
      if (/\.[a-f0-9]{64}\.png(?:[?#]|$)/.test(src)) return src;
      return src + (src.includes('?') ? '&' : '?') + 't=' + avatarCacheVersion;
  }

  function renderMessageAvatars(items = document.querySelectorAll(".message-item")) {
      items.forEach(el => {
          const avatarUrl = el.dataset.avatarUrl;

          const box = el.querySelector(".message-avatar-box");
          const username = el.querySelector(".message-author")?.textContent || "";
          const firstChar = username.charAt(0) || "?";

          const isDeveloper = el.dataset.official === "true" || DEVELOPER_NICKNAMES.includes(username);
          const renderKey = JSON.stringify([avatarUrl, username, isDeveloper]);
          if (box.dataset.renderKey === renderKey) return;
          box.dataset.renderKey = renderKey;

          const devWrapStyle = isDeveloper
              ? `position:relative;padding:2px;border-radius:50%;background:linear-gradient(135deg,#ffd700,#ff9500);`
              : ``;
          const devInnerStyle = isDeveloper
              ? `border-radius:50%;background:#fff;padding:1px;`
              : ``;

          box.style.removeProperty("display");
          box.style.removeProperty("flex-direction");
          box.style.removeProperty("align-items");
          box.style.removeProperty("gap");

          if (username === "匿名用户") {
              box.innerHTML = `<div style="width:38px;height:38px;border-radius:50%;background:#000;"></div>`;
              return;
          }

          let avatarCore = "";

          if (avatarUrl) {
              if (isDeveloper) {
                  avatarCore = `
                  <div style="${devWrapStyle}">
                      <div style="${devInnerStyle}">
                          <img loading="lazy" decoding="async" width="38" height="38" alt="" src="${escapeHtml(getFreshAvatar(avatarUrl))}" style="width:38px;height:38px;border-radius:50%;object-fit:cover;display:block;">
                      </div>
                      <span style="position:absolute;right:-6px;bottom:-2px;font-size:9px;font-weight:bold;color:#fff;background:#c28c00;padding:1px 4px;border-radius:6px;white-space:nowrap;z-index:2;">Dev</span>
                  </div>`;
              } else {
                  avatarCore = `<img loading="lazy" decoding="async" width="38" height="38" alt="" src="${escapeHtml(getFreshAvatar(avatarUrl))}" style="width:38px;height:38px;border-radius:50%;object-fit:cover;">`;
              }
          } else {
              if (isDeveloper) {
                  avatarCore = `
                  <div style="${devWrapStyle}">
                      <div style="${devInnerStyle}">
                          <div style="width:38px;height:38px;border-radius:50%;background:#ccc;display:flex;align-items:center;justify-content:center;color:#aeb5ae;">${escapeHtml(firstChar)}</div>
                      </div>
                      <span style="position:absolute;right:-6px;bottom:-2px;font-size:9px;font-weight:bold;color:#fff;background:#c28c00;padding:1px 4px;border-radius:6px;white-space:nowrap;z-index:2;">Dev</span>
                  </div>`;
              } else {
                  avatarCore = `<div style="width:38px;height:38px;border-radius:50%;background:#ccc;display:flex;align-items:center;justify-content:center;color:#aeb5ae;">${escapeHtml(firstChar)}</div>`;
              }
          }

          box.innerHTML = avatarCore;
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
              canvas.toBlob(blob => {
                  if (!blob) return reject("图片压缩失败");
                  const suffixes = { "image/webp": ".webp", "image/png": ".png", "image/jpeg": ".jpg" };
                  const suffix = suffixes[blob.type];
                  if (!suffix) return reject(new Error("图片格式不受支持"));
                  const newFileName = file.name.replace(/(\.\w+)$/, suffix);
                  const compressedFile = new File([blob], newFileName, { type: blob.type });
                  resolve(compressedFile);
              }, opts.mimeType, opts.quality);
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
  window.ForumUI = { parseMessageContent, escapeHtml, renderMessageAvatars, getFreshAvatar, uploadFiles };
})();

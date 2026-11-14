(function () {
  const zones = [
    { key: 'life', label: '日常分享', icon: '日', description: '日常分享与生活见闻' },
    { key: 'study', label: '学习互助', icon: '学', description: '课程、考试与经验分享' },
    { key: 'clubs', label: '活动社团', icon: '动', description: '活动、比赛与社团招新' },
    { key: 'lost', label: '失物招领', icon: '寻', description: '寻找物品与归还线索' }
  ];

  const escapeHtml = (value) => {
    const node = document.createElement('div');
    node.textContent = value || '';
    return node.innerHTML;
  };
  const relativeTime = (value) => {
    const seconds = Math.max(1, Math.floor((Date.now() - new Date(value).getTime()) / 1000));
    const formatter = new Intl.RelativeTimeFormat('zh-CN', { numeric: 'auto' });
    if (seconds < 60) return formatter.format(-seconds, 'second');
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return formatter.format(-minutes, 'minute');
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return formatter.format(-hours, 'hour');
    const days = Math.floor(hours / 24);
    return days < 30 ? formatter.format(-days, 'day') : new Date(value).toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' });
  };
  function renderZones(host, items = [], locked = false) {
    const groups = Object.fromEntries(zones.map((zone) => [zone.key, []]));
    items.forEach(item => {
      const parsed = ForumUI.parseMessageContent(item.content, item.zone);
      const zone = zones.find(zone => zone.label === parsed.zone);
      if (zone) groups[zone.key].push({ ...item, text: parsed.text });
    });
    host.innerHTML = zones.map((zone) => {
      const posts = groups[zone.key].slice(0, 2);
      const body = locked
        ? '<div class="zone-empty">登录后查看这个分区的最新动态。</div>'
        : posts.length
          ? posts.map((item) => {
              return `<a class="zone-post" href="details.html?id=${encodeURIComponent(item.id)}"><strong>${escapeHtml(item.text)}</strong><small>→</small><span>${escapeHtml(item.username || 'ISAer')} · ${relativeTime(item.created_at)}</span></a>`;
            }).join('')
          : '<div class="zone-empty">这个分区还没有新动态。</div>';
      return `<article class="zone-card"><div class="zone-head"><div class="zone-title"><span class="zone-icon">${zone.icon}</span><div><h3>${zone.label}</h3><p>${zone.description}</p></div></div><span class="zone-count">${locked ? '需登录' : `最新 ${groups[zone.key].length} 条`}</span></div><div class="zone-posts">${body}</div><a class="zone-link" href="messages.html?zone=${encodeURIComponent(zone.label)}">进入${zone.label} →</a></article>`;
    }).join('');
  }

  function initGreeting() {
    const node = document.getElementById('dayGreeting');
    if (!node) return;
    const hour = new Date().getHours();
    const part = hour < 6 ? '夜深了' : hour < 11 ? '早上好' : hour < 14 ? '中午好' : hour < 18 ? '下午好' : '晚上好';
    node.textContent = `${part} · 社区在线`;
  }
  function initCarousel() {
    const slides = [...document.querySelectorAll('.hero-slide')];
    const host = document.getElementById('heroDots');
    if (!slides.length || !host) return;
    let current = 0;
    let timer;
    const dots = slides.map((slide, index) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = `hero-dot${index === 0 ? ' active' : ''}`;
      button.setAttribute('aria-label', `显示第 ${index + 1} 张：${slide.dataset.label}`);
      button.setAttribute('aria-pressed', String(index === 0));
      host.appendChild(button);
      return button;
    });
    const schedule = () => {
      clearInterval(timer);
      if (!matchMedia('(prefers-reduced-motion: reduce)').matches) timer = setInterval(() => show(current + 1), 6000);
    };
    const show = (next, restart = false) => {
      current = (next + slides.length) % slides.length;
      slides.forEach((slide, index) => slide.classList.toggle('active', index === current));
      dots.forEach((dot, index) => {
        dot.classList.toggle('active', index === current);
        dot.setAttribute('aria-pressed', String(index === current));
      });
      if (restart) schedule();
    };
    dots.forEach((dot, index) => dot.addEventListener('click', () => show(index, true)));
    document.getElementById('prevSlide')?.addEventListener('click', () => show(current - 1, true));
    document.getElementById('nextSlide')?.addEventListener('click', () => show(current + 1, true));
    document.querySelector('.hero')?.addEventListener('mouseenter', () => clearInterval(timer));
    document.querySelector('.hero')?.addEventListener('mouseleave', schedule);
    document.addEventListener('visibilitychange', () => document.hidden ? clearInterval(timer) : schedule());
    schedule();
  }

  async function initMealEntry() {
    const link = document.getElementById('mealEntryLink');
    const note = document.getElementById('mealEntryNote');
    if (!link || !note || !window.RootedVoxAuth) return;
    try {
      const session = await RootedVoxAuth.getSession();
      if (!session?.authenticated) return;
      link.href = 'meal-rating.html';
      link.textContent = '进入今日评分 →';
      note.textContent = '反馈会与当前登录账号绑定';
    } catch {}
  }

  async function loadFeed() {
    const host = document.getElementById('latestFeed');
    if (!host) return;
    try {
      if (!window.RootedVoxPublicData) throw new Error('feed_unavailable');
      const result = await RootedVoxPublicData.overview();
      renderZones(host, result.messages || []);
    } catch (error) {
      host.innerHTML = '<div class="zone-card"><div class="zone-empty">暂时无法同步分区内容，请稍后重试。</div><a class="text-link" href="/messages">前往社区广场 →</a></div>';
    }
  }
  function protectHomeBack() {
    const navigation = performance.getEntriesByType('navigation')[0];
    if (navigation && navigation.type !== 'navigate') return;
    if (history.length < 2 || history.state?.rootedVoxHomeBuffer) return;
    if (document.referrer && new URL(document.referrer).origin === location.origin) return;

    const listeners = new AbortController();
    function arm(event) {
      if (!event.isTrusted || navigator.userActivation?.isActive === false) return;
      listeners.abort();
      // One extra entry allows a second Back to follow the original history.
      history.pushState({ ...history.state, rootedVoxHomeBuffer: true }, '', location.href);
    }
    const options = { capture: true, signal: listeners.signal };
    window.addEventListener('click', arm, options);
    window.addEventListener('keydown', arm, options);
  }

  document.addEventListener('DOMContentLoaded', () => {
    protectHomeBack();
    initGreeting();
    initCarousel();
    initMealEntry();
    loadFeed();
  });
})();

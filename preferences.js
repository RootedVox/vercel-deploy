(() => {
  const system = matchMedia('(prefers-color-scheme: dark)');
  const root = document.documentElement;
  const read = key => {
    try { return localStorage.getItem('rv-' + key); } catch { return null; }
  };
  const write = (key, value) => {
    try { localStorage.setItem('rv-' + key, value); } catch {}
  };
  let theme = read('theme') || 'auto';
  let language = read('language') === 'en' ? 'en' : 'zh-CN';
  const applyTheme = () => {
    root.dataset.theme = theme === 'auto' ? (system.matches ? 'dark' : 'light') : theme;
  };
  applyTheme();
  root.lang = language;
  // The translation table is only needed in English. It is written into the document
  // while this script blocks the parser, so the page never paints untranslated first.
  if (language === 'en') document.write('<script src="/english.js?v=3900ebfcc5"><\/script>');
  let englishRequested = language === 'en';
  function loadEnglish() {
    if (englishRequested) return;
    englishRequested = true;
    const script = document.createElement('script');
    script.src = '/english.js?v=3900ebfcc5';
    script.onload = () => { localize(document.head.querySelector('title')); localize(document.body); };
    document.head.append(script);
  }
  system.addEventListener('change', applyTheme);

  const originals = new WeakMap();
  const attributes = ['placeholder', 'aria-label', 'title'];
  const skip = 'script, style, textarea, [contenteditable], .message-content, .message-author, .notification-content, #nicknameSelect option[value]:not([value="匿名用户"]):not([value="real"]), .zone-post, #languageChoice';
  const translate = value => {
    const key = value.trim();
    const english = window.rvEnglish?.get(key);
    if (language !== 'en') return value;
    if (english !== undefined) return value.replace(key, english);
    const count = key.match(/^最新 (\d+) 条$/);
    if (count) return value.replace(key, count[1] + (count[1] === "1" ? " recent post" : " recent posts"));
    if (/^↳ 回复 @/.test(key)) return value.replace('回复', 'Reply to');
    if (/^回复 @/.test(key)) return value.replace('回复', 'Reply to');
    return value;
  };

  function localize(node) {
    if (!node) return;
    const element = node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
    if (!element || element.closest?.(skip) && node.nodeType === Node.TEXT_NODE) return;
    if (node.nodeType === Node.TEXT_NODE) {
      const saved = originals.get(node);
      const source = saved?.rendered === node.data ? saved.source : node.data;
      const rendered = translate(source);
      if (node.data !== rendered) node.data = rendered;
      originals.set(node, { source, rendered });
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE || element.closest('script, style, .message-content, .notification-content')) return;
    const saved = originals.get(node) || {};
    for (const attr of attributes) {
      const current = node.getAttribute(attr);
      if (!current) continue;
      const source = saved[attr]?.rendered === current ? saved[attr].source : current;
      const rendered = translate(source);
      if (current !== rendered) node.setAttribute(attr, rendered);
      saved[attr] = { source, rendered };
    }
    originals.set(node, saved);
    node.childNodes.forEach(localize);
  }

  document.addEventListener('DOMContentLoaded', () => {
    localize(document.head.querySelector('title'));
    localize(document.body);
    // The selectors may already be in the page or arrive later with a fetched header.
    const syncChoices = () => {
      const themeChoice = document.querySelector('#themeChoice');
      if (themeChoice && themeChoice.value !== theme) themeChoice.value = theme;
      const languageChoice = document.querySelector('#languageChoice');
      if (languageChoice && languageChoice.value !== language) languageChoice.value = language;
    };
    syncChoices();
    const observer = new MutationObserver(records => {
      for (const record of records) {
        if (record.type === 'childList') record.addedNodes.forEach(localize);
        else localize(record.target);
      }
      syncChoices();
    });
    observer.observe(document.body, {
      subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: attributes,
    });
    document.addEventListener('change', event => {
      if (event.target.id === 'themeChoice') {
        theme = event.target.value;
        write('theme', theme);
        applyTheme();
      }
      if (event.target.id === 'languageChoice') {
        language = event.target.value;
        write('language', language);
        root.lang = language;
        if (language === 'en') loadEnglish();
        localize(document.head.querySelector('title'));
        localize(document.body);
      }
    });
  });
})();

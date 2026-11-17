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
  if (language === 'en') document.write('<script src="/english.js?v=2e90aa2c97"><\/script>');
  let englishRequested = language === 'en';
  function loadEnglish() {
    if (englishRequested) return;
    englishRequested = true;
    const script = document.createElement('script');
    script.src = '/english.js?v=2e90aa2c97';
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
    const quota = key.match(/^仅限主楼 · 今日还可投稿 (\d+) 次$/);
    if (quota) return value.replace(key, 'New threads only · ' + quota[1] + ' remaining today');
    const comments = key.match(/^(\d+) 条评论$/);
    if (comments) return value.replace(key, comments[1] + (comments[1] === '1' ? ' comment' : ' comments'));
    const count = key.match(/^最新 (\d+) 条$/);
    if (count) return value.replace(key, count[1] + (count[1] === "1" ? " recent post" : " recent posts"));
    const updated = key.match(/^(\d+)(秒|分钟|小时|天)前更新$/);
    if (updated) {
      const unit = { 秒: 'second', 分钟: 'minute', 小时: 'hour', 天: 'day' }[updated[2]];
      const time = new Intl.RelativeTimeFormat('en', { numeric: 'auto' }).format(-Number(updated[1]), unit);
      return value.replace(key, 'Updated ' + time);
    }
    const updatedDate = key.match(/^(\d+)月(\d+)日更新$/);
    if (updatedDate) {
      const time = new Date(2000, Number(updatedDate[1]) - 1, Number(updatedDate[2]));
      return value.replace(key, 'Updated ' + time.toLocaleDateString('en', { month: 'short', day: 'numeric' }));
    }
    if (/^↳ 回复 @/.test(key)) return value.replace('回复', 'Reply to');
    if (/^回复 @/.test(key)) return value.replace('回复', 'Reply to');
    return value;
  };

  const choiceIds = ['languageChoice', 'themeChoice', 'messageZoneFilter', 'nicknameSelect', 'zoneSelect'];
  const choices = new WeakMap();
  let openChoice;
  let choiceList;

  function closeChoice(restoreFocus = false) {
    if (!openChoice) return;
    const { button } = openChoice;
    button.setAttribute('aria-expanded', 'false');
    choiceList.hidden = true;
    openChoice = null;
    if (restoreFocus) button.focus();
  }

  function syncChoice(select, button) {
    const label = select.getAttribute('aria-label') || select.labels[0]?.textContent.trim() || '';
    const current = select.selectedOptions[0]?.textContent.trim() || '';
    if (button.textContent !== current) button.textContent = current;
    const accessibleName = [label, current].filter(Boolean).join(' · ');
    if (button.getAttribute('aria-label') !== accessibleName) button.setAttribute('aria-label', accessibleName);
    if (button.disabled !== select.disabled) button.disabled = select.disabled;
    if (button.disabled && openChoice?.button === button) closeChoice();
  }

  function positionChoice(button) {
    const anchor = button.getBoundingClientRect();
    const width = choiceList.offsetWidth;
    const left = Math.max(8, Math.min(anchor.left, window.innerWidth - width - 8));
    const below = window.innerHeight - anchor.bottom - 14;
    const above = anchor.top - 14;
    const placeAbove = choiceList.scrollHeight > below && above > below;
    choiceList.style.left = left + 'px';
    choiceList.style.maxHeight = Math.max(40, placeAbove ? above : below) + 'px';
    choiceList.style.top = (placeAbove ? Math.max(8, anchor.top - choiceList.offsetHeight - 6) : anchor.bottom + 6) + 'px';
  }

  function showChoice(select, button, direction = 0) {
    if (!choiceList) {
      choiceList = document.createElement('div');
      choiceList.id = 'rvChoiceList';
      choiceList.className = 'rv-choice-list';
      choiceList.setAttribute('role', 'listbox');
      choiceList.hidden = true;
      document.body.append(choiceList);
    }
    closeChoice();
    openChoice = { select, button };
    choiceList.setAttribute('aria-label', select.getAttribute('aria-label') || select.labels[0]?.textContent.trim() || '');
    const options = Array.from(select.options, (option, index) => {
      const item = document.createElement('button');
      item.type = 'button';
      item.tabIndex = -1;
      item.setAttribute('role', 'option');
      item.setAttribute('aria-selected', String(option.selected));
      item.disabled = option.disabled || option.parentElement?.disabled === true;
      item.textContent = option.textContent.trim();
      item.addEventListener('click', event => {
        // The panel lives outside the header, but selecting inside it stays in the nav.
        event.stopPropagation();
        const changed = select.selectedIndex !== index;
        select.selectedIndex = index;
        closeChoice(true);
        if (changed) select.dispatchEvent(new Event('change', { bubbles: true }));
        syncChoice(select, button);
      });
      return item;
    });
    choiceList.replaceChildren(...options);
    button.setAttribute('aria-expanded', 'true');
    choiceList.style.minWidth = Math.min(button.offsetWidth, window.innerWidth - 16) + 'px';
    choiceList.hidden = false;
    positionChoice(button);
    const enabled = options.filter(item => !item.disabled);
    const selected = enabled.find(item => item.getAttribute('aria-selected') === 'true');
    (selected || enabled.at(direction < 0 ? -1 : 0))?.focus({ preventScroll: true });
    if (choiceList.contains(document.activeElement)) document.activeElement.scrollIntoView({ block: 'nearest' });
  }

  function syncMenus() {
    for (const id of choiceIds) {
      const select = document.getElementById(id);
      if (!select) continue;
      let button = choices.get(select);
      if (!button) {
        button = document.createElement('button');
        button.type = 'button';
        button.className = 'rv-choice-button';
        button.setAttribute('aria-haspopup', 'listbox');
        button.setAttribute('aria-expanded', 'false');
        button.setAttribute('aria-controls', 'rvChoiceList');
        button.addEventListener('click', () => {
          if (openChoice?.button === button) closeChoice();
          else showChoice(select, button);
        });
        button.addEventListener('keydown', event => {
          if (!['ArrowDown', 'ArrowUp'].includes(event.key)) return;
          event.preventDefault();
          showChoice(select, button, event.key === 'ArrowUp' ? -1 : 1);
        });
        select.hidden = true;
        select.after(button);
        choices.set(select, button);
        for (const label of select.labels) {
          label.addEventListener('click', event => {
            event.preventDefault();
            if (!button.disabled) button.focus();
          });
        }
        select.addEventListener('change', () => syncChoice(select, button));
      }
      syncChoice(select, button);
    }
  }

  function attachChoiceEvents() {
    document.addEventListener('pointerdown', event => {
      if (openChoice && !openChoice.button.contains(event.target) && !choiceList.contains(event.target)) closeChoice();
    });
    document.addEventListener('keydown', event => {
      if (!openChoice) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        closeChoice(true);
      } else if (event.key === 'Tab' && choiceList.contains(event.target)) {
        closeChoice(true);
      } else if (choiceList.contains(event.target) && ['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) {
        event.preventDefault();
        const items = Array.from(choiceList.querySelectorAll('button:not(:disabled)'));
        if (!items.length) return;
        const index = items.indexOf(document.activeElement);
        if (event.key === 'Home') items[0].focus();
        else if (event.key === 'End') items.at(-1).focus();
        else items[(index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length].focus();
      }
    }, true);
    window.addEventListener('resize', () => closeChoice(true));
    window.addEventListener('scroll', event => {
      if (openChoice && !(event.target instanceof Node && choiceList.contains(event.target))) positionChoice(openChoice.button);
    }, true);
  }

  function localize(node) {
    if (!node) return;
    const element = node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
    if (element?.closest?.('.rv-choice-button, .rv-choice-list')) return;
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
    syncMenus();
    attachChoiceEvents();
    queueMicrotask(syncMenus);
    const observer = new MutationObserver(records => {
      for (const record of records) {
        if (record.type === 'childList') record.addedNodes.forEach(localize);
        else localize(record.target);
      }
      syncChoices();
      syncMenus();
    });
    observer.observe(document.body, {
      subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: [...attributes, 'disabled', 'selected'],
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

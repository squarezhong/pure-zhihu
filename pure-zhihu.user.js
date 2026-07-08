// ==UserScript==
// @name         Pure Zhihu
// @author       squarezhong
// @namespace    https://github.com/squarezhong/pure-zhihu
// @version      0.4.3
// @description  大幅简化知乎：默认进入关注流，隐藏顶栏噪音和指定侧边栏模块，并支持严格模式过滤“赞同了回答”动态。
// @homepageURL  https://github.com/squarezhong/pure-zhihu
// @supportURL   https://github.com/squarezhong/pure-zhihu/issues
// @updateURL    https://raw.githubusercontent.com/squarezhong/pure-zhihu/main/pure-zhihu.user.js
// @downloadURL  https://raw.githubusercontent.com/squarezhong/pure-zhihu/main/pure-zhihu.user.js
// @match        https://www.zhihu.com/
// @match        https://www.zhihu.com/*
// @run-at       document-start
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// ==/UserScript==

(function () {
  'use strict';

  const STORAGE_KEY = 'pure-zhihu-mode';
  const MODE_DIFFUSE = 'diffuse';
  const MODE_STRICT = 'strict';
  const HIDDEN_CLASS = 'pure-zhihu-hidden';
  const STRICT_HIDDEN_CLASS = 'pure-zhihu-strict-hidden';
  const SEARCH_CONTAINER_CLASS = 'pure-zhihu-search-container';
  const ACTIVE_CLASS = 'pure-zhihu-active';
  const STRICT_CLASS = 'pure-zhihu-strict';
  const STYLE_ID = 'pure-zhihu-style';
  const HEADER_CHANNEL_TEXTS = ['推荐', '热榜', '专栏', '圈子', '故事'];
  const HEADER_PARTIAL_TEXTS = ['AI Works'];
  const HEADER_ACTION_TEXTS = ['直播', '直答'];
  const SIDEBAR_BLOCK_TEXTS = ['大家都在搜', '盐言作者平台', '付费咨询', '知乎知学堂'];
  const STRICT_DYNAMIC_TEXTS = ['赞同了回答', '赞同了文章', '赞同了想法', '赞同了视频'];

  let mode = getStoredMode();
  let applyScheduled = false;

  injectStyle();
  syncRootClasses();
  registerMenu();
  patchHistory();
  bindLifecycleEvents();
  redirectHomeToFollow();
  scheduleApply();

  function getStoredMode() {
    const stored = gmGetValue(STORAGE_KEY, MODE_DIFFUSE);
    return stored === MODE_STRICT ? MODE_STRICT : MODE_DIFFUSE;
  }

  function gmGetValue(key, fallback) {
    try {
      if (typeof GM_getValue === 'function') {
        return GM_getValue(key, fallback);
      }
    } catch (_) {
      // Fall through to the default value.
    }
    return fallback;
  }

  function gmSetValue(key, value) {
    try {
      if (typeof GM_setValue === 'function') {
        GM_setValue(key, value);
      }
    } catch (_) {
      // Ignore storage failures; the current page can still be cleaned.
    }
  }

  function registerMenu() {
    if (typeof GM_registerMenuCommand !== 'function') {
      return;
    }

    const nextMode = mode === MODE_STRICT ? MODE_DIFFUSE : MODE_STRICT;
    const currentLabel = mode === MODE_STRICT ? '严格模式' : '扩散模式';
    const nextLabel = nextMode === MODE_STRICT ? '严格模式' : '扩散模式';

    GM_registerMenuCommand(
      `Pure Zhihu：切换到${nextLabel}（当前：${currentLabel}）`,
      () => {
        mode = nextMode;
        gmSetValue(STORAGE_KEY, nextMode);
        window.location.reload();
      }
    );

    GM_registerMenuCommand('Pure Zhihu：重新应用规则', () => {
      clearHiddenClasses();
      syncRootClasses();
      applyRules();
    });
  }

  function injectStyle() {
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
      html.${ACTIVE_CLASS} .${HIDDEN_CLASS},
      html.${ACTIVE_CLASS}.${STRICT_CLASS} .${STRICT_HIDDEN_CLASS} {
        display: none !important;
      }

      html.${ACTIVE_CLASS} header input::placeholder,
      html.${ACTIVE_CLASS} .AppHeader input::placeholder,
      html.${ACTIVE_CLASS} [class*="Search"] input::placeholder {
        color: transparent !important;
        opacity: 0 !important;
      }

      html.${ACTIVE_CLASS} .${SEARCH_CONTAINER_CLASS} {
        margin-right: 24px !important;
      }

      html.${ACTIVE_CLASS} .AppHeader-Tabs,
      html.${ACTIVE_CLASS} [class*="AppHeader-Tabs"] {
        border-right: 0 !important;
      }

      html.${ACTIVE_CLASS} .AppHeader-Tabs::before,
      html.${ACTIVE_CLASS} .AppHeader-Tabs::after,
      html.${ACTIVE_CLASS} [class*="AppHeader-Tabs"]::before,
      html.${ACTIVE_CLASS} [class*="AppHeader-Tabs"]::after {
        content: none !important;
        display: none !important;
      }
    `;

    const attach = () => {
      if (document.getElementById(STYLE_ID)) {
        return;
      }
      const target = document.head || document.documentElement;
      if (target) {
        target.appendChild(style);
      }
    };

    attach();
    if (!document.getElementById(STYLE_ID)) {
      document.addEventListener('DOMContentLoaded', attach, { once: true });
    }
  }

  function bindLifecycleEvents() {
    document.addEventListener('DOMContentLoaded', scheduleApply, { once: true });
    window.addEventListener('load', scheduleApply, { once: true });
    window.addEventListener('popstate', onRouteChanged);

    const startObserver = () => {
      const target = document.documentElement || document.body;
      if (!target) {
        window.setTimeout(startObserver, 50);
        return;
      }

      const observer = new MutationObserver(() => {
        scheduleApply();
      });
      observer.observe(target, {
        childList: true,
        subtree: true
      });
    };

    startObserver();
  }

  function patchHistory() {
    ['pushState', 'replaceState'].forEach((methodName) => {
      const original = window.history[methodName];
      if (typeof original !== 'function') {
        return;
      }

      window.history[methodName] = function patchedHistoryMethod() {
        const result = original.apply(this, arguments);
        onRouteChanged();
        return result;
      };
    });
  }

  function onRouteChanged() {
    syncRootClasses();
    redirectHomeToFollow();
    scheduleApply();
  }

  function redirectHomeToFollow() {
    if (!isZhihuHost() || !isHomePage()) {
      return;
    }

    window.location.replace(`${window.location.origin}/follow`);
  }

  function scheduleApply() {
    if (applyScheduled) {
      return;
    }

    applyScheduled = true;
    window.requestAnimationFrame(() => {
      applyScheduled = false;
      applyRules();
    });
  }

  function applyRules() {
    syncRootClasses();
    clearHiddenClasses();

    if (!isManagedPage()) {
      return;
    }

    cleanTopChrome();
    cleanSidebarBlocks();

    if (mode === MODE_STRICT) {
      cleanStrictDynamics();
    }
  }

  function syncRootClasses() {
    const root = document.documentElement;
    if (!root) {
      return;
    }

    root.classList.toggle(ACTIVE_CLASS, isManagedPage() || isHomePage());
    root.classList.toggle(STRICT_CLASS, mode === MODE_STRICT);
  }

  function clearHiddenClasses() {
    document
      .querySelectorAll(`.${HIDDEN_CLASS}, .${STRICT_HIDDEN_CLASS}`)
      .forEach((element) => {
        element.classList.remove(HIDDEN_CLASS, STRICT_HIDDEN_CLASS);
      });
  }

  function cleanTopChrome() {
    const headerCandidates = uniqueElements([
      ...document.querySelectorAll('header, .AppHeader, [class*="AppHeader"]')
    ]).filter(isLikelyGlobalHeader);

    headerCandidates.forEach((header) => {
      hideHeaderNoise(header);
      cleanSearchRecommendations(header);
      hideHeaderSeparators(header);
    });
  }

  function hideHeaderNoise(header) {
    const controls = header.querySelectorAll(
      'a, button, [role="tab"], [role="link"], [role="button"]'
    );
    controls.forEach((control) => {
      if (isHeaderNoiseLabel(getElementLabel(control))) {
        hide(findCompactHeaderBlock(control, header));
      }
    });
  }

  function hideHeaderSeparators(header) {
    const dividerCandidates = header.querySelectorAll(
      '[class*="Divider"], [class*="divider"], [class*="Separator"], [class*="separator"]'
    );

    dividerCandidates.forEach((element) => {
      if (isCompactHeaderSeparator(element)) {
        hide(element);
      }
    });

    hideFollowTrailingSeparators(header);
  }

  function isCompactHeaderSeparator(element) {
    const rect = element.getBoundingClientRect();
    return rect.width <= 28 && rect.height <= 48;
  }

  function hideFollowTrailingSeparators(header) {
    const followEntry = findHeaderFollowEntry(header);
    const searchContainer = findHeaderSearchContainer(header);
    if (!followEntry) {
      return;
    }

    const followRect = followEntry.getBoundingClientRect();
    const searchRect = searchContainer ? searchContainer.getBoundingClientRect() : null;
    const leftBound = followRect.right - 2;
    const rightBound = searchRect ? searchRect.left - 4 : followRect.right + 120;

    Array.from(header.querySelectorAll('*')).forEach((element) => {
      if (
        element === followEntry ||
        element.contains(followEntry) ||
        followEntry.contains(element) ||
        (searchContainer && (element === searchContainer || element.contains(searchContainer)))
      ) {
        return;
      }

      const rect = element.getBoundingClientRect();
      if (
        rect.width > 0 &&
        rect.width <= 36 &&
        rect.height >= 8 &&
        rect.height <= 64 &&
        rect.left >= leftBound &&
        rect.left < rightBound &&
        isSeparatorLikeElement(element)
      ) {
        hide(element);
      }
    });
  }

  function isSeparatorLikeElement(element) {
    const text = getOwnText(element) || getElementLabel(element);
    const interactive = element.matches('a, button, input, [role="button"], [role="link"]');
    return !interactive && text.length === 0;
  }

  function cleanSearchRecommendations(header) {
    const inputs = header.querySelectorAll(
      'input[type="search"], input[type="text"], input:not([type])'
    );

    inputs.forEach((input) => {
      if (!isLikelyHeaderSearchInput(input)) {
        return;
      }

      if (!input.dataset.pureZhihuSearchBound) {
        input.dataset.pureZhihuSearchBound = 'true';
        input.addEventListener('input', () => {
          input.dataset.pureZhihuUserEdited = 'true';
        });
      }

      input.placeholder = '';
      input.setAttribute('placeholder', '');
      markSearchContainer(input, header);

      if (
        input.value &&
        document.activeElement !== input &&
        input.dataset.pureZhihuUserEdited !== 'true'
      ) {
        input.value = '';
      }
    });
  }

  function markSearchContainer(input, header) {
    const container =
      input.closest('form') ||
      input.closest('[role="search"]') ||
      input.closest('[class*="Search"], [class*="search"]');

    if (container && header.contains(container)) {
      container.classList.add(SEARCH_CONTAINER_CLASS);
    }
  }

  function findHeaderFollowEntry(header) {
    return Array.from(header.querySelectorAll('a, button, [role="tab"], [role="link"]')).find(
      (element) => {
        const text = getElementLabel(element);
        const href = element.getAttribute('href') || '';
        return text === '关注' || (text.length <= 8 && /\/follow(?:ing)?(?:$|[/?#])/.test(href));
      }
    );
  }

  function findHeaderSearchContainer(header) {
    const input = Array.from(
      header.querySelectorAll('input[type="search"], input[type="text"], input:not([type])')
    ).find(isLikelyHeaderSearchInput);

    if (!input) {
      return null;
    }

    return (
      input.closest(`.${SEARCH_CONTAINER_CLASS}`) ||
      input.closest('form') ||
      input.closest('[role="search"]') ||
      input.closest('[class*="Search"], [class*="search"]') ||
      input
    );
  }

  function isHeaderNoiseLabel(text) {
    if (HEADER_CHANNEL_TEXTS.includes(text) || HEADER_ACTION_TEXTS.includes(text)) {
      return true;
    }

    return HEADER_PARTIAL_TEXTS.some((partial) => text.includes(partial));
  }

  function isLikelyHeaderSearchInput(input) {
    return Boolean(
      input.closest('form, [role="search"], [class*="Search"], [class*="search"]')
    );
  }

  function findCompactHeaderBlock(element, header) {
    const clickable = element.closest('a, button, [role="tab"], [role="link"], [role="button"]');
    if (clickable && header.contains(clickable)) {
      const listItem = clickable.closest('li');
      if (listItem && header.contains(listItem) && getElementLabel(listItem).length <= 30) {
        return listItem;
      }

      const compactParent = clickable.closest('[class*="Tab"], [class*="Item"]');
      if (
        compactParent &&
        header.contains(compactParent) &&
        getElementLabel(compactParent).length <= 30
      ) {
        return compactParent;
      }

      return clickable;
    }

    const compactParent = element.closest('li, [class*="Tab"], [class*="Item"]');
    if (
      compactParent &&
      header.contains(compactParent) &&
      getElementLabel(compactParent).length <= 30
    ) {
      return compactParent;
    }

    return element;
  }

  function cleanSidebarBlocks() {
    const scopedCandidates = uniqueElements([
      ...document.querySelectorAll(
        [
          'aside *',
          '.GlobalSideBar *',
          '.TopstorySideBar *',
          '[class*="SideBar"] *',
          '[class*="Sidebar"] *',
          '[class*="sideColumn"] *',
          '[class*="SideColumn"] *',
          '[class*="TopSearch"] *',
          '[class*="Creator"] *',
          'section',
          'section *',
          '.Card',
          '.Card *',
          '[class*="Card"]',
          '[class*="Card"] *'
        ].join(', ')
      )
    ]);

    const textElements = uniqueElements([
      ...scopedCandidates.filter(matchesBlockedSidebarText),
      ...findElementsByText(SIDEBAR_BLOCK_TEXTS)
    ]);

    textElements.forEach((element) => {
      const block = findSidebarBlockFromAny(element);
      if (block && isLikelySidebarBlock(block)) {
        hide(block);
      }
    });
  }

  function matchesBlockedSidebarText(element) {
    const ownText = getOwnText(element);
    const text = ownText || getElementLabel(element);
    return (
      text.length > 0 &&
      text.length < 200 &&
      SIDEBAR_BLOCK_TEXTS.some((blockedText) => text.includes(blockedText))
    );
  }

  function findElementsByText(texts) {
    if (!document.body) {
      return [];
    }

    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const elements = [];

    while (walker.nextNode()) {
      const text = normalizeText(walker.currentNode.textContent);
      if (texts.some((blockedText) => text.includes(blockedText))) {
        elements.push(walker.currentNode.parentElement);
      }
    }

    return uniqueElements(elements);
  }

  function findSidebarBlockFromAny(element) {
    const root = element.closest(
      'aside, .GlobalSideBar, .TopstorySideBar, [class*="SideBar"], [class*="Sidebar"], [class*="sideColumn"], [class*="SideColumn"]'
    );

    if (root) {
      return findSidebarBlock(element, root);
    }

    return (
      findRightColumnCard(element) ||
      element.closest('[class*="TopSearch"], [class*="Creator"], .Card, [class*="Card"], section') ||
      element
    );
  }

  function findRightColumnCard(element) {
    let current = element;
    let candidate = null;

    while (current && current !== document.body && current !== document.documentElement) {
      if (isRightColumnCardShape(current) && containsBlockedSidebarText(current)) {
        candidate = current;
      }

      const parent = current.parentElement;
      if (!parent || isTooLargeForSidebarModule(parent)) {
        break;
      }

      current = parent;
    }

    return candidate;
  }

  function findSidebarBlock(element, root) {
    let current = element;

    while (current && current !== root) {
      if (isSidebarModuleLike(current) || current.parentElement === root) {
        return current;
      }
      current = current.parentElement;
    }

    return element;
  }

  function isLikelySidebarBlock(element) {
    if (
      element.closest(
        'aside, .GlobalSideBar, .TopstorySideBar, [class*="SideBar"], [class*="Sidebar"], [class*="sideColumn"], [class*="SideColumn"]'
      )
    ) {
      return true;
    }

    const className = String(element.className || '');
    if (className.includes('TopSearch') || className.includes('Creator')) {
      return true;
    }

    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.left > window.innerWidth * 0.45;
  }

  function cleanStrictDynamics() {
    const mainRoots = uniqueElements([
      ...document.querySelectorAll(
        'main, .Topstory-mainColumn, [class*="Topstory-mainColumn"], [class*="List"]'
      )
    ]);

    mainRoots.forEach((root) => {
      const feedItems = Array.from(
        root.querySelectorAll(
          '.TopstoryItem, [class*="TopstoryItem"], .List-item, [class*="ListItem"], article, .Card'
        )
      );

      feedItems.forEach((item) => {
        const text = normalizeText(item.textContent);
        if (isStrictDynamicText(text)) {
          hide(item, true);
        }
      });
    });
  }

  function isStrictDynamicText(text) {
    return STRICT_DYNAMIC_TEXTS.some((dynamicText) => text.includes(dynamicText));
  }

  function isLikelyGlobalHeader(element) {
    if (element.tagName === 'HEADER') {
      return true;
    }

    const className = String(element.className || '');
    return className.includes('AppHeader');
  }

  function isSidebarModuleLike(element) {
    const className = String(element.className || '');
    return (
      element.tagName === 'SECTION' ||
      className.includes('Card') ||
      className.includes('Module') ||
      className.includes('TopSearch') ||
      className.includes('Creator') ||
      className.includes('TopstoryItem') === false && isRightColumnCardShape(element)
    );
  }

  function isRightColumnCardShape(element) {
    const rect = element.getBoundingClientRect();
    return (
      rect.width >= 220 &&
      rect.width <= 520 &&
      rect.height >= 40 &&
      rect.height <= 760 &&
      rect.left >= window.innerWidth * 0.42
    );
  }

  function isTooLargeForSidebarModule(element) {
    const rect = element.getBoundingClientRect();
    return rect.width > 620 || rect.height > 900 || rect.left < window.innerWidth * 0.35;
  }

  function containsBlockedSidebarText(element) {
    const text = getElementLabel(element);
    return SIDEBAR_BLOCK_TEXTS.some((blockedText) => text.includes(blockedText));
  }

  function hide(element, strictOnly) {
    if (!element || element === document.body || element === document.documentElement) {
      return;
    }

    element.classList.add(strictOnly ? STRICT_HIDDEN_CLASS : HIDDEN_CLASS);
  }

  function isManagedPage() {
    return isZhihuHost() && (isHomePage() || isFollowPage());
  }

  function isHomePage() {
    return window.location.pathname === '/';
  }

  function isFollowPage() {
    return /^\/follow(?:\/)?$/.test(window.location.pathname);
  }

  function isZhihuHost() {
    return window.location.hostname === 'www.zhihu.com';
  }

  function normalizeText(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
  }

  function getOwnText(element) {
    return normalizeText(
      Array.from(element.childNodes)
        .filter((node) => node.nodeType === Node.TEXT_NODE)
        .map((node) => node.textContent)
        .join(' ')
    );
  }

  function getElementLabel(element) {
    return normalizeText(
      element.textContent ||
        element.getAttribute('aria-label') ||
        element.getAttribute('title') ||
        ''
    );
  }

  function uniqueElements(elements) {
    return Array.from(new Set(elements)).filter(Boolean);
  }
})();

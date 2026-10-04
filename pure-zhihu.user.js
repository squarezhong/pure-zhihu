// ==UserScript==
// @name         Pure Zhihu
// @author       squarezhong
// @namespace    https://github.com/squarezhong/pure-zhihu
// @version      0.4.8
// @description  大幅简化知乎：默认进入关注流，隐藏广告、顶栏噪音和指定侧栏模块；严格模式过滤赞同动态及折叠动态入口。
// @homepageURL  https://github.com/squarezhong/pure-zhihu
// @supportURL   https://github.com/squarezhong/pure-zhihu/issues
// @updateURL    https://raw.githubusercontent.com/squarezhong/pure-zhihu/main/pure-zhihu.user.js
// @downloadURL  https://raw.githubusercontent.com/squarezhong/pure-zhihu/main/pure-zhihu.user.js
// @match        https://*.zhihu.com/*
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
  const HEADER_ACTION_TEXTS = ['直播', '直答', '知乎直答'];
  const SIDEBAR_BLOCK_TEXTS = ['大家都在搜', '盐言作者平台', '付费咨询', '知乎知学堂'];
  const SIDEBAR_ROOTS = 'aside, .GlobalSideBar, .TopstorySideBar, [class*="SideBar"], [class*="Sidebar"], [class*="sideColumn"], [class*="SideColumn"]';
  const CONTENT_ROOTS = 'article, .TopstoryItem, .List-item, .ContentItem, .RichContent, .RichText, .AnswerItem, .QuestionHeader, .CommentItem, [role="dialog"], [contenteditable="true"]';
  const AD_MODULES = '.TopstoryItem--advertCard, .Pc-feedAd, .Pc-feedAd-new, .Pc-card, .AdvertCard, .Question-sideColumnAdContainer';
  const AD_CONTENT = '.RichContent, .RichText, .AnswerItem, .CommentItem, article, [contenteditable="true"]';
  const NAVIGATION = 'nav, .AppHeader-Tabs, [role="navigation"]';
  const CONTROLS = 'a, button, [role="tab"], [role="link"], [role="button"]';

  let mode = getStoredMode();
  let applyScheduled = false;
  let hidden = new Set();
  let strictHidden = new Set();

  injectStyle();
  syncRootClasses();
  registerMenu();
  patchHistory();
  bindLifecycleEvents();
  redirectHomeToFollow();
  scheduleApply();

  function getStoredMode() {
    try {
      return typeof GM_getValue === 'function' && GM_getValue(STORAGE_KEY, MODE_DIFFUSE) === MODE_STRICT
        ? MODE_STRICT : MODE_DIFFUSE;
    } catch (_) {
      return MODE_DIFFUSE;
    }
  }

  function registerMenu() {
    if (typeof GM_registerMenuCommand !== 'function') return;
    const nextMode = mode === MODE_STRICT ? MODE_DIFFUSE : MODE_STRICT;
    const currentLabel = mode === MODE_STRICT ? '严格模式' : '扩散模式';
    const nextLabel = nextMode === MODE_STRICT ? '严格模式' : '扩散模式';
    GM_registerMenuCommand(`Pure Zhihu：切换到${nextLabel}（当前：${currentLabel}）`, () => {
      mode = mode === MODE_STRICT ? MODE_DIFFUSE : MODE_STRICT;
      try {
        if (typeof GM_setValue !== 'function') throw new Error('Storage unavailable');
        GM_setValue(STORAGE_KEY, mode);
      } catch (_) {
        // Keep the selected mode usable on this page when storage is unavailable.
        scheduleApply();
        return;
      }
      window.location.reload();
    });
    GM_registerMenuCommand('Pure Zhihu：重新应用规则', applyRules);
  }

  function injectStyle() {
    const attach = () => {
      if (document.getElementById(STYLE_ID)) return;
      const target = document.head || document.documentElement;
      if (!target) return;
      const style = document.createElement('style');
      style.id = STYLE_ID;
      style.dataset.pureZhihuVersion = '0.4.8';
      style.textContent = `
        ${AD_MODULES.split(', ').map((selector) => `html.${ACTIVE_CLASS} ${selector}`).join(',\n')} {
          display: none !important;
        }
        html.${ACTIVE_CLASS} .${HIDDEN_CLASS},
        html.${ACTIVE_CLASS}.${STRICT_CLASS} .${STRICT_HIDDEN_CLASS} { display: none !important; }
        html.${ACTIVE_CLASS} .${SEARCH_CONTAINER_CLASS} { margin-right: 24px !important; }
        html.${ACTIVE_CLASS} .AppHeader-Tabs { border-right: 0 !important; }
        html.${ACTIVE_CLASS} .AppHeader-Tabs::before,
        html.${ACTIVE_CLASS} .AppHeader-Tabs::after { content: none !important; display: none !important; }
      `;
      target.appendChild(style);
    };
    attach();
    if (!document.getElementById(STYLE_ID)) {
      document.addEventListener('DOMContentLoaded', attach, { once: true });
    }
  }

  function bindLifecycleEvents() {
    document.addEventListener('DOMContentLoaded', scheduleApply, { once: true });
    window.addEventListener('load', scheduleApply, { once: true });
    window.addEventListener('pageshow', onRouteChanged);
    window.addEventListener('popstate', onRouteChanged);
    const startObserver = () => {
      if (!document.documentElement) {
        window.setTimeout(startObserver, 50);
        return;
      }
      const observer = new MutationObserver((records) => {
        if (records.some((record) => {
          if (record.type !== 'attributes' || record.attributeName !== 'class') return true;
          // Ignore our own class changes, but handle React reusing an existing node.
          const withoutOurs = (value) => String(value || '').split(/\s+/)
            .filter((name) => name && !name.startsWith('pure-zhihu-')).sort().join(' ');
          const removedHiddenClass = [HIDDEN_CLASS, STRICT_HIDDEN_CLASS].some((name) =>
            String(record.oldValue || '').split(/\s+/).includes(name) &&
            !record.target.classList.contains(name) &&
            (name === HIDDEN_CLASS ? hidden : strictHidden).has(record.target)
          );
          return removedHiddenClass || withoutOurs(record.oldValue) !== withoutOurs(record.target.className);
        })) scheduleApply();
      });
      observer.observe(document.documentElement, {
        childList: true, subtree: true, characterData: true,
        attributes: true, attributeOldValue: true,
        attributeFilter: ['class', 'href', 'aria-label', 'title', 'placeholder']
      });
    };
    startObserver();
  }

  function patchHistory() {
    ['pushState', 'replaceState'].forEach((name) => {
      const original = window.history[name];
      window.history[name] = function () {
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
    if (window.location.hostname === 'www.zhihu.com' && window.location.pathname === '/') {
      window.location.replace(`${window.location.origin}/follow${window.location.search}${window.location.hash}`);
    }
  }

  function scheduleApply() {
    if (applyScheduled) return;
    applyScheduled = true;
    window.requestAnimationFrame(() => {
      applyScheduled = false;
      applyRules();
    });
  }

  function applyRules() {
    injectStyle();
    syncRootClasses();
    redirectHomeToFollow();
    hidden = new Set();
    strictHidden = new Set();
    if (isManagedPage()) {
      cleanTopChrome();
      cleanSearchDiscovery();
      cleanSidebarBlocks();
      cleanAdvertisements();
      if (mode === MODE_STRICT && window.location.hostname === 'www.zhihu.com' && /^\/follow\/?$/.test(window.location.pathname)) cleanStrictDynamics();
    }
    // Reconcile only differences: do not unhide/re-hide the whole feed every frame.
    reconcile(HIDDEN_CLASS, hidden);
    reconcile(STRICT_HIDDEN_CLASS, strictHidden);
  }

  function reconcile(className, desired) {
    document.querySelectorAll(`.${className}`).forEach((element) => {
      if (!desired.has(element)) element.classList.remove(className);
    });
    desired.forEach((element) => {
      if (!element.classList.contains(className)) element.classList.add(className);
    });
  }

  function syncRootClasses() {
    const root = document.documentElement;
    if (!root) return;
    root.classList.toggle(ACTIVE_CLASS, isManagedPage());
    root.classList.toggle(STRICT_CLASS, mode === MODE_STRICT);
  }

  function cleanTopChrome() {
    document.querySelectorAll('header, .AppHeader').forEach((header) => {
      const navs = [...header.querySelectorAll(NAVIGATION)].filter((nav) =>
        [...nav.querySelectorAll('a')].some((a) => {
          try { return new URL(a.getAttribute('href'), window.location.origin).pathname === '/follow'; }
          catch (_) { return false; }
        })
      );
      // An answer or article may also have a header. Require a global header marker.
      if (!header.classList.contains('AppHeader') && navs.length === 0) return;
      navs.forEach((nav) => {
        nav.querySelectorAll(CONTROLS).forEach((control) => {
          const text = getElementLabel(control);
          if (HEADER_CHANNEL_TEXTS.includes(text) || text.startsWith('AI Works')) hideHeaderControl(control, nav);
        });
        // Current Zhihu uses an empty direct child as the channel divider.
        [...nav.children].forEach((element) => {
          if (element.matches('div, span, [role="separator"]') && !getElementLabel(element) &&
              !element.querySelector(`${CONTROLS}, input, img, svg`)) hide(element);
        });
      });
      header.querySelectorAll('a, button, [role="button"]').forEach((control) => {
        if (control.closest('[role="tablist"], .Tabs, [role="dialog"], [role="listbox"]')) return;
        if (HEADER_ACTION_TEXTS.includes(getElementLabel(control))) hide(control);
      });
      header.querySelectorAll('input[type="search"], input[type="text"], input:not([type])').forEach((input) => {
        const container = input.closest('[role="search"], [class*="Search"], [class*="search"]');
        if (!container || !header.contains(container)) return;
        if (input.placeholder) input.placeholder = '';
        container.classList.add(SEARCH_CONTAINER_CLASS);
        // The value belongs to the user/router (including refresh and back/forward).
      });
    });
  }

  function hideHeaderControl(control, nav) {
    const item = control.closest('li');
    // Never hide a shared Tabs/Items wrapper which also contains the Follow entry.
    hide(item && nav.contains(item) && item.querySelectorAll('a, button').length === 1 ? item : control);
  }

  function cleanSearchDiscovery() {
    // Search dropdowns are portaled outside AppHeader. Hide only the discovery
    // group so history and keyword suggestions in the same menu remain usable.
    document.querySelectorAll('.SearchBar-menu .AutoComplete-group').forEach((group) => {
      const label = group.querySelector('.SearchBar-label');
      if (label && getElementLabel(label) === '搜索发现') hide(group);
    });
  }

  function cleanSidebarBlocks() {
    // Scope by modules, not every text node in the document or screen coordinates.
    const candidates = document.querySelectorAll(`${SIDEBAR_ROOTS}, .HotSearchCard, .KfeCollection-CreateSaltCard, .Card`);
    const titles = new Set();
    candidates.forEach((candidate) => {
      if (candidate.closest(CONTENT_ROOTS)) return;
      [candidate, ...candidate.querySelectorAll('*')].forEach((element) => {
        if (!element.closest(CONTENT_ROOTS) && SIDEBAR_BLOCK_TEXTS.includes(getOwnText(element))) {
          titles.add(element);
        }
      });
    });
    titles.forEach((title) => {
      const root = title.closest(SIDEBAR_ROOTS);
      const module = title.closest('.HotSearchCard, .KfeCollection-CreateSaltCard, .Card, section');
      if (module && (!root || root.contains(module))) {
        // Salt's Card is only a wrapper around the module; remove the empty card too.
        const wrapper = module.parentElement;
        hide(wrapper && wrapper.matches('.Card') && wrapper.children.length === 1 ? wrapper : module);
      } else if (root) {
        let block = title;
        while (block.parentElement && block.parentElement !== root) block = block.parentElement;
        if (block !== root) hide(block);
      }
    });
  }

  function cleanAdvertisements() {
    // Use the actual ad modules, including image/SVG badges without readable text.
    document.querySelectorAll(`${AD_MODULES}, .AdvertImg, .Banner-adTag, .Banner-adTag-new`).forEach((marker) => {
      const module = marker.closest(AD_MODULES) || marker.closest('.Banner-link') || marker;
      const card = module.closest('.TopstoryItem, .List-item, .Card');
      hide(card && !module.closest(AD_CONTENT) ? card : module);
    });

    // A standalone badge handles cards with new/generated CSS names.
    document.querySelectorAll('.TopstoryItem, .List-item, .Card').forEach((card) => {
      if (card.closest(AD_CONTENT)) return;
      const badge = [card, ...card.querySelectorAll('span, div, a, h3')].find((element) =>
        element.closest('.TopstoryItem, .List-item, .Card') === card &&
        !element.closest(`${AD_CONTENT}, .ContentItem, .FeedSource`) &&
        getOwnText(element) === '广告'
      );
      if (badge) hide(card);
    });
  }

  function cleanStrictDynamics() {
    document.querySelectorAll('.TopstoryItem').forEach((item) => {
      const source = item.querySelector('.FeedSource-firstline') || item.querySelector('.FeedSource');
      if (!source || source.closest('.TopstoryItem') !== item) return;
      const label = source.cloneNode(true);
      label.querySelectorAll('.UserLink, .AuthorInfo, a, time').forEach((element) => element.remove());
      if (/^赞同了(?:回答|文章|想法|视频)(?:$|[\s·\d])/.test(normalizeText(label.textContent))) hide(item, true);
    });

    // Folded groups are independent role=button divs, not FeedSource rows.
    document.querySelectorAll('.Topstory-feedGroupCollapsedItem, .TopstoryItem button, .TopstoryItem [role="button"]').forEach((entry) => {
      if (entry.closest(AD_CONTENT)) return;
      const text = normalizeText(entry.textContent).replace(/\u200b/g, '').trim();
      if (entry.matches('.Topstory-feedGroupCollapsedItem') || /^还有\s*\d+\s*个.+的动态被收起$/.test(text)) {
        hide(entry, true);
      }
    });
    // Hide empty wrappers, while preserving groups containing any normal dynamics.
    document.querySelectorAll('.TopstoryItem-feedList').forEach((group) => {
      const children = [...group.children].filter((child) => !child.matches('script, style'));
      if (children.length && children.every((child) => strictHidden.has(child))) hide(group, true);
    });
  }

  function hide(element, strictOnly) {
    if (element && element !== document.body && element !== document.documentElement) {
      (strictOnly ? strictHidden : hidden).add(element);
    }
  }

  function isManagedPage() {
    const hostname = window.location.hostname;
    return hostname === 'zhihu.com' || hostname.endsWith('.zhihu.com');
  }

  function normalizeText(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
  }

  function getOwnText(element) {
    return normalizeText([...element.childNodes].filter((node) => node.nodeType === Node.TEXT_NODE)
      .map((node) => node.textContent).join(' '));
  }

  function getElementLabel(element) {
    return normalizeText(element.textContent) || normalizeText(element.getAttribute('aria-label')) ||
      normalizeText(element.getAttribute('title'));
  }
})();

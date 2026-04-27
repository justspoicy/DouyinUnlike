// ==UserScript==
// @name         Pixiv 一键清空收藏
// @namespace    http://tampermonkey.net/
// @version      1.0.0
// @description  在 Pixiv 收藏页自动点击管理收藏、全选、解除收藏、确认解除，并循环直到全部移除。
// @author       You
// @match        https://www.pixiv.net/users/*/bookmarks/artworks*
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  const POLL_INTERVAL = 800;
  const PAGE_REFRESH_WAIT = 2500;
  const EMPTY_RETRY_LIMIT = 5;
  const MODE_WAIT_LIMIT = 10;
  const AUTO_START_DELAY = 1800;

  let isRunning = false;
  let timer = null;
  let completedRounds = 0;
  let emptyRetries = 0;
  let currentStep = 'manage';

  function log(message) {
    console.log(`[PixivUnbookmark] ${message}`);
  }

  function clearTimer() {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  }

  function visible(element) {
    return Boolean(element) && element.isConnected && element.offsetParent !== null;
  }

  function isDisabled(element) {
    if (!element) {
      return true;
    }

    return element.disabled || element.getAttribute('aria-disabled') === 'true' || element.closest('[aria-disabled="true"]') !== null;
  }

  function normalizeText(value) {
    return (value || '').replace(/\s+/g, ' ').trim();
  }

  function matchesAnyPattern(value, patterns) {
    return patterns.some((pattern) => pattern.test(normalizeText(value)));
  }

  function getClickableCandidates(root = document) {
    return Array.from(root.querySelectorAll('button, a, input, label, [role="button"], [role="checkbox"], [role="menuitemcheckbox"], div[tabindex], span[tabindex]'));
  }

  function getElementTextParts(element) {
    if (!element) {
      return [];
    }

    const texts = [
      element.textContent,
      element.getAttribute('aria-label'),
      element.getAttribute('title'),
      element.getAttribute('data-tooltip'),
      element.getAttribute('value'),
    ];

    const labelledBy = element.getAttribute('aria-labelledby');
    if (labelledBy) {
      labelledBy.split(/\s+/).forEach((id) => {
        const labelNode = document.getElementById(id);
        if (labelNode) {
          texts.push(labelNode.textContent);
        }
      });
    }

    if (element.id) {
      const label = document.querySelector(`label[for="${element.id}"]`);
      if (label) {
        texts.push(label.textContent);
      }
    }

    if (element.closest('label')) {
      texts.push(element.closest('label').textContent);
    }

    return texts.map(normalizeText).filter(Boolean);
  }

  function findByText(textPatterns, root = document) {
    const candidates = getClickableCandidates(root);

    for (const element of candidates) {
      if (!visible(element)) {
        continue;
      }

      if (isDisabled(element)) {
        continue;
      }

      const textParts = getElementTextParts(element);
      if (textParts.length === 0) {
        continue;
      }

      if (textParts.some((text) => matchesAnyPattern(text, textPatterns))) {
        return element;
      }
    }

    return null;
  }

  function clickElement(element) {
    if (!element) {
      return false;
    }

    element.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
    element.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    element.dispatchEvent(new MouseEvent('pointerover', { bubbles: true }));
    element.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
    element.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    element.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    element.dispatchEvent(new MouseEvent('pointerup', { bubbles: true }));
    element.click();
    return true;
  }

  function findClickableAncestor(element, root = document.body) {
    let current = element;

    while (current && current !== root && current !== document.body) {
      if (
        current.matches &&
        current.matches('button, a, label, [role="button"], [role="checkbox"], [role="menuitemcheckbox"], input, [tabindex]') &&
        visible(current) &&
        !isDisabled(current)
      ) {
        return current;
      }

      current = current.parentElement;
    }

    return element;
  }

  function getDialogs() {
    return Array.from(document.querySelectorAll('[role="dialog"], [aria-modal="true"], [class*="dialog"], [class*="modal"]'))
      .filter(visible);
  }

  function getManagementRoot() {
    const dialogs = getDialogs();
    if (dialogs.length > 0) {
      return dialogs[0];
    }

    const containers = Array.from(document.querySelectorAll('main, section, div')).filter(visible);
    const controlPatterns = [/^全选$/, /^全選択$/, /^Select all$/i, /^解除收藏$/, /^Remove bookmarks$/i, /^ブックマーク解除$/];

    for (const container of containers) {
      const controls = getClickableCandidates(container);
      const matchedCount = controls.filter((element) => {
        return getElementTextParts(element).some((text) => matchesAnyPattern(text, controlPatterns));
      }).length;

      if (matchedCount >= 2) {
        return container;
      }
    }

    return document;
  }

  function isSelectionControlActive() {
    return Boolean(findSelectAllButton()) || Boolean(findUnbookmarkButton()) || hasDisabledUnbookmarkButton();
  }

  function findConfirmUnbookmarkButton() {
    const specificDialogButtons = Array.from(document.querySelectorAll('.sc-f8f152e1-3 [role="button"]')).filter(visible);
    for (const button of specificDialogButtons) {
      const text = normalizeText(button.textContent);
      if (text === '解除') {
        return button;
      }
    }

    const patterns = [/^解除$/, /^解除收藏$/, /^确认$/, /^確認$/, /^確定$/, /^OK$/i, /^はい$/];

    for (const dialog of getDialogs()) {
      const button = findByText(patterns, dialog);
      if (button) {
        return button;
      }
    }

    return null;
  }

  function findManageButton() {
    const headerButtons = Array.from(document.querySelectorAll('button')).filter(visible);
    for (const button of headerButtons) {
      const text = normalizeText(button.textContent);
      if (!/^管理收藏$|^编辑收藏$|^Edit bookmarks$|^ブックマーク管理$/i.test(text)) {
        continue;
      }

      const nearCountBadge = Boolean(button.closest('div')?.parentElement?.textContent?.match(/插画|漫画|小说|珍藏册/));
      if (nearCountBadge) {
        return button;
      }
    }

    return findByText([/^管理收藏$/, /^编辑收藏$/, /^Edit bookmarks$/i, /^ブックマーク管理$/]);
  }

  function findSelectAllButton() {
    const root = getManagementRoot();

    const specificControl = root.querySelector('.sc-f6e451b3-4');
    if (specificControl && visible(specificControl)) {
      const directButtons = Array.from(specificControl.querySelectorAll('[role="checkbox"], input[type="checkbox"], button, [role="button"]')).filter((element) => {
        return visible(element) && !isDisabled(element);
      });
      if (directButtons.length > 0) {
        return directButtons[0];
      }

      const firstSelectableBlock = Array.from(specificControl.children).find((element) => {
        if (!visible(element)) {
          return false;
        }

        const text = normalizeText(element.textContent);
        return text === '全选' || text.startsWith('全选');
      });
      if (firstSelectableBlock) {
        return firstSelectableBlock;
      }

      const selectAllLabel = Array.from(specificControl.querySelectorAll('.sc-f6e451b3-6, div, span')).find((element) => {
        return visible(element) && normalizeText(element.textContent) === '全选';
      });

      if (selectAllLabel) {
        const ancestor = findClickableAncestor(selectAllLabel, specificControl);
        if (ancestor !== selectAllLabel) {
          return ancestor;
        }

        const siblingBlock = selectAllLabel.parentElement;
        if (siblingBlock && visible(siblingBlock)) {
          return siblingBlock;
        }

        return selectAllLabel;
      }
    }

    const exactSelectAllNode = Array.from(root.querySelectorAll('.sc-f6e451b3-6, div, span, label, button, [role="button"], [role="checkbox"]')).find((element) => {
      return visible(element) && normalizeText(element.textContent) === '全选';
    });
    if (exactSelectAllNode) {
      return findClickableAncestor(exactSelectAllNode, root);
    }

    const checkboxCandidate = Array.from(root.querySelectorAll('[role="checkbox"], input[type="checkbox"], label')).find((element) => {
      return visible(element) && getElementTextParts(element).some((text) => /^全选$|^全選択$|^Select all$/i.test(text));
    });

    if (checkboxCandidate) {
      return findClickableAncestor(checkboxCandidate, root);
    }

    return findByText([/^全选$/, /^全選択$/, /^Select all$/i], root);
  }

  function findUnbookmarkButton() {
    const root = getManagementRoot();
    const actionBar = root.querySelector('.sc-f6e451b3-4');

    if (actionBar && visible(actionBar)) {
      const actionButtons = Array.from(actionBar.querySelectorAll('.sc-f6e451b3-7[role="button"], [role="button"], button')).filter((candidate) => {
        return visible(candidate) && !isDisabled(candidate);
      });

      const exactActionButton = actionButtons.find((candidate) => normalizeText(candidate.textContent) === '解除收藏');
      if (exactActionButton) {
        return exactActionButton;
      }
    }

    const exactEnabledButton = Array.from(root.querySelectorAll('.sc-f6e451b3-7[role="button"]')).find((candidate) => {
      return visible(candidate)
        && normalizeText(candidate.textContent) === '解除收藏'
        && candidate.getAttribute('aria-disabled') === 'false';
    });
    if (exactEnabledButton) {
      return exactEnabledButton;
    }

    const button = findByText([/^解除收藏$/, /^Remove bookmarks$/i, /^ブックマーク解除$/], root);
    if (button) {
      return button.closest('[role="button"], button') || button;
    }

    const candidates = Array.from(root.querySelectorAll('[role="button"], button')).filter(visible);
    for (const candidate of candidates) {
      if (normalizeText(candidate.textContent) !== '解除收藏') {
        continue;
      }

      if (!isDisabled(candidate)) {
        return candidate;
      }
    }

    return null;
  }

  function hasDisabledUnbookmarkButton() {
    const root = getManagementRoot();
    return Array.from(root.querySelectorAll('[role="button"], button')).some((candidate) => {
      return visible(candidate) && normalizeText(candidate.textContent) === '解除收藏' && isDisabled(candidate);
    });
  }

  function hasArtworkItems() {
    const itemSelectors = [
      'a[href*="/artworks/"]',
      'figure a[href*="/artworks/"]',
      'ul li img',
      'img[src*="img-master"]'
    ];

    return itemSelectors.some((selector) => document.querySelector(selector));
  }

  function hasEmptyState() {
    const text = normalizeText(document.body.textContent);
    return [
      /公开收藏为空/,
      /还没有收藏作品/,
      /No bookmarks yet/i,
      /ブックマークした作品はまだありません/
    ].some((pattern) => pattern.test(text));
  }

  function waitNext(step, delay = POLL_INTERVAL) {
    clearTimer();
    timer = setTimeout(step, delay);
  }

  function finish(reason) {
    clearTimer();
    isRunning = false;
    log(`已停止: ${reason}。共完成 ${completedRounds} 轮解除。`);
  }

  function setStep(step) {
    currentStep = step;
  }

  function runCycle() {
    if (!isRunning) {
      return;
    }

    const confirmButton = findConfirmUnbookmarkButton();
    if (confirmButton && currentStep === 'confirm') {
      log('检测到确认弹窗，点击“解除”');
      clickElement(confirmButton);
      completedRounds += 1;
      emptyRetries = 0;
      setStep('manage');
      waitNext(runCycle, PAGE_REFRESH_WAIT);
      return;
    }

    if (currentStep === 'manage') {
      if (isSelectionControlActive()) {
        setStep('selectAll');
        waitNext(runCycle, 200);
        return;
      }

      const manageButton = findManageButton();
      if (manageButton) {
        log('点击“管理收藏”');
        clickElement(manageButton);
        emptyRetries = 0;
        setStep('selectAll');
        waitNext(runCycle);
        return;
      }
    }

    if (currentStep === 'selectAll') {
      const selectAllButton = findSelectAllButton();
      if (selectAllButton) {
        log('点击“全选”');
        clickElement(selectAllButton);
        emptyRetries = 0;
        if (hasDisabledUnbookmarkButton()) {
          waitNext(runCycle, 400);
          return;
        }

        setStep('unbookmark');
        waitNext(runCycle);
        return;
      }
    }

    if (currentStep === 'unbookmark') {
      const unbookmarkButton = findUnbookmarkButton();
      if (unbookmarkButton) {
        log(`点击“解除收藏”，目标文本: ${normalizeText(unbookmarkButton.textContent)}`);
        clickElement(unbookmarkButton);
        emptyRetries = 0;
        setStep('confirm');
        waitNext(runCycle);
        return;
      }
    }

    if (hasEmptyState()) {
      finish('收藏已全部移除');
      return;
    }

    if (hasArtworkItems()) {
      emptyRetries += 1;
      if (emptyRetries > MODE_WAIT_LIMIT) {
        finish(`在“${currentStep}”阶段多次尝试后仍未找到目标控件，页面结构可能已变化`);
        return;
      }

      log(`页面仍有收藏作品，但在“${currentStep}”阶段暂未找到目标控件，${POLL_INTERVAL}ms 后重试 (${emptyRetries}/${MODE_WAIT_LIMIT})`);
      waitNext(runCycle);
      return;
    }

    emptyRetries += 1;
    if (emptyRetries > EMPTY_RETRY_LIMIT) {
      finish('未检测到收藏项目，脚本结束');
      return;
    }

    log(`等待页面加载完成 (${emptyRetries}/${EMPTY_RETRY_LIMIT})`);
    waitNext(runCycle);
  }

  function start() {
    if (isRunning) {
      log('脚本已在运行');
      return;
    }

    isRunning = true;
    completedRounds = 0;
    emptyRetries = 0;
    setStep('manage');
    log('开始批量解除收藏');
    runCycle();
  }

  function stop() {
    finish('手动停止');
  }

  window.__pixivUnbookmarkAll = {
    start,
    stop,
    status() {
      return {
        running: isRunning,
        completedRounds,
        emptyRetries,
        currentStep,
        url: location.href,
      };
    },
  };

  log('脚本已就绪。执行 __pixivUnbookmarkAll.start() 开始，执行 __pixivUnbookmarkAll.stop() 停止。');
  waitNext(() => {
    if (!isRunning) {
      start();
    }
  }, AUTO_START_DELAY);

  window.addEventListener('load', () => {
    log('脚本已加载。在收藏页执行 __pixivUnbookmarkAll.start() 开始，__pixivUnbookmarkAll.stop() 停止。');
  });
})();

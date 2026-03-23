/**
 * 抖音「喜欢的视频」批量取消点赞脚本（批量管理模式）
 *
 * 使用方式：
 * 1. 用 Chrome / Edge 打开 https://www.douyin.com
 * 2. 登录你的账号
 * 3. 进入「我」→「喜欢」页面（URL 形如 https://www.douyin.com/user/xxx?showTab=like）
 * 4. 打开浏览器开发者工具（F12）→ Console（控制台）
 * 5. 将此文件全部内容粘贴进去，回车执行
 *
 * 脚本流程：
 *   点击「批量管理」→ 勾选「全选」→ 点击「取消喜欢」→ 弹窗中点「确认」→ 等待刷新 → 重复
 *
 * 若中途需要停止，在控制台执行：  window.__unlikeStop = true
 */

(async function unlikeAllBatch() {

  /* ===== 可调参数 ===== */
  const STEP_DELAY     = 1000;  // 每一步操作之间的等待毫秒
  const VIDEO_TIMEOUT  = 300000; // 等待视频出现的最长毫秒（超时则强制继续）
  const SCROLL_STEPS   = 5;     // 视频出现后向下滚动的次数
  const SCROLL_STEP_MS = 1200;  // 每次滚动后等待的毫秒
  const MAX_FAILS      = 3;     // 连续多少轮找不到「批量管理」时停止
  /* =================== */

  window.__unlikeStop = false;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const log   = (msg) => console.log(`[批量取消喜欢] ${msg}`);

  /**
   * 用 TreeWalker 遍历所有文本节点，找到文字与关键词完全匹配的节点，
   * 再向上最多 6 层找离它最近的可交互祖先元素后返回。
   * 这比 querySelector + textContent 更精确，不会误命中父容器。
   *
   * @param {...string} keywords  精确匹配的文字列表（满足其一即可）
   * @returns {Element|null}
   */
  function findByExactText(...keywords) {
    const set = new Set(keywords);
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      if (!set.has(node.textContent.trim())) continue;
      // 向上找最近的可交互元素
      let el = node.parentElement;
      for (let i = 0; i < 6 && el && el !== document.body; i++) {
        const tag = el.tagName.toLowerCase();
        const role = el.getAttribute('role') || '';
        if (
          tag === 'button' || tag === 'a' ||
          role === 'button' || role === 'checkbox' || role === 'option' ||
          el.onclick != null
        ) {
          return el;
        }
        el = el.parentElement;
      }
      // 兜底：直接返回文字节点的父元素
      return node.parentElement;
    }
    return null;
  }

  /**
   * 返回抖音主内容区的滚动容器。
   * 根据实际页面 HTML，固定选取 .route-scroll-container，
   * 找不到时退回 document.documentElement。
   */
  function getScrollContainer() {
    return document.querySelector('.route-scroll-container') || document.documentElement;
  }

  /**
   * 等待视频列表真正刷新：先等列表清空，再等新 li 插入。
   * 两个阶段都有独立超时，任一超时则 resolve(false) 继续下一轮。
   * @param {number} timeoutMs  每个阶段的最长等待毫秒
   */
  function waitForVideos(timeoutMs) {
    return new Promise((resolve) => {
      const getList = () => document.querySelector('ul[data-e2e="scroll-list"]');

      // 阶段一：等列表清空（旧内容移除）
      function waitEmpty() {
        const list = getList();
        if (!list || list.children.length === 0) { waitFill(); return; }
        const timer = setTimeout(() => { obs.disconnect(); resolve(false); }, timeoutMs);
        const obs = new MutationObserver(() => {
          const l = getList();
          if (!l || l.children.length === 0) {
            clearTimeout(timer); obs.disconnect(); waitFill();
          }
        });
        obs.observe(list, { childList: true, subtree: false });
      }

      // 阶段二：等新 li 插入（新内容出现）
      function waitFill() {
        const list = getList();
        if (list && list.children.length > 0) { resolve(true); return; }
        const timer = setTimeout(() => { obs.disconnect(); resolve(false); }, timeoutMs);
        const obs = new MutationObserver(() => {
          const l = getList();
          if (l && l.children.length > 0) {
            clearTimeout(timer); obs.disconnect(); resolve(true);
          }
        });
        // list 可能被整体替换，监听 body 以兜底
        obs.observe(document.body, { childList: true, subtree: true });
      }

      waitEmpty();
    });
  }

  /**
   * 视频出现后渐进式向下滚动触发懒加载，最后回到顶部。
   */
  async function scrollDownAndBack(steps, stepMs) {
    const container = getScrollContainer();
    for (let i = 0; i < steps && !window.__unlikeStop; i++) {
      container.scrollTop = container.scrollHeight;
      await sleep(stepMs);
    }
    container.scrollTop = 0;
    await sleep(600);
  }


  async function waitFor(timeoutMs, ...keywords) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const el = findByExactText(...keywords);
      if (el) return el;
      await sleep(300);
    }
    return null;
  }

  const esc = () =>
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

  let rounds = 0;
  let fails  = 0;

  log('脚本启动。中途停止：window.__unlikeStop = true');

  while (!window.__unlikeStop) {

    // ── 步骤 1：点击「批量管理」 ─────────────────────────────
    const batchBtn = document.querySelector('.buGg4uBH')
                  || await waitFor(6000, '批量管理');
    if (!batchBtn) {
      if (++fails >= MAX_FAILS) {
        log('多次未找到「批量管理」，任务结束（列表可能已清空）。');
        break;
      }
      log(`未找到「批量管理」(${fails}/${MAX_FAILS})，等待重试…`);
      await sleep(REFRESH_WAIT);
      continue;
    }
    fails = 0;
    batchBtn.click();
    log('① 已点击「批量管理」');
    await sleep(STEP_DELAY);

    // ── 步骤 2：点击「全选」 ─────────────────────────────────
    const selectAll = await waitFor(6000, '全选');
    if (!selectAll) {
      log('未找到「全选」，退出当前模式后重试');
      esc();
      await sleep(STEP_DELAY);
      continue;
    }
    selectAll.click();
    log('② 已点击「全选」');
    await sleep(STEP_DELAY);

    // ── 步骤 3：点击「取消喜欢」 ─────────────────────────────
    const unlikeBtn = await waitFor(6000, '取消喜欢', '取消点赞');
    if (!unlikeBtn) {
      log('未找到「取消喜欢」（可能没有视频被选中），退出重试');
      esc();
      await sleep(STEP_DELAY);
      continue;
    }
    unlikeBtn.click();
    log('③ 已点击「取消喜欢」');
    await sleep(STEP_DELAY);

    // ── 步骤 4：弹窗中点击确认 ───────────────────────────────
    // 优先匹配「确认取消」，其次「确认」「确定」
    const confirmBtn = await waitFor(6000, '确认取消', '确认', '确定');
    if (!confirmBtn) {
      log('未找到确认弹窗，退出重试');
      esc();
      await sleep(STEP_DELAY);
      continue;
    }
    confirmBtn.click();
    log(`④ 已确认，第 ${++rounds} 轮完成，监测视频是否重新加载…`);

    // ── 步骤 5：等视频出现后再滚动加载更多 ─────────────────
    const appeared = await waitForVideos(VIDEO_TIMEOUT);
    if (appeared) {
      log('视频已加载，等待 3 秒后开始向下滚动触发懒加载…');
      await sleep(3000);
    } else {
      log(`等待视频超时（${VIDEO_TIMEOUT}ms），强制继续…`);
    }
    await scrollDownAndBack(SCROLL_STEPS, SCROLL_STEP_MS);
  }

  log(`脚本结束，共完成 ${rounds} 轮批量取消操作。`);
})();

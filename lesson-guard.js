// 无题页面识别与无进展超时。
// auto-runner 的 solve() 在读不到 [data-test*="challenge challenge-"] 时，用它判断
// 页面是加载中、结算、封面，还是卡在了非题目页（例如法语 radio 进入的
// "CONVERSATIONS AVEC ZARI"：只有 token，没有 challenge 容器）。

const NO_PROGRESS_MS = 60000;

// 一次 page.evaluate 把判断需要的可见性全部取回来，避免多次往返和选择器漂移。
async function readPageState(page) {
  return await page.evaluate(() => {
    const visible = (e) => {
      if (!e) return false;
      const r = e.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) return false;
      const s = getComputedStyle(e);
      return s.display !== 'none' && s.visibility !== 'hidden' && parseFloat(s.opacity || '1') > 0.1;
    };
    const next = document.querySelector('[data-test="player-next"]');
    return {
      url: location.pathname + location.search,
      hasChallenge: !!document.querySelector('[data-test*="challenge challenge-"]'),
      hasLoading: !!document.querySelector('[data-test="loading-screen"]'),
      hasStoryCover: visible(document.querySelector('[data-test="story-start"]')),
      hasStoriesElement: !!document.querySelector('[data-test="stories-element"]'),
      hasEndButton: visible(document.querySelector('[data-test="legendary-session-end-continue"]')),
      hasQuitButton: visible(document.querySelector('[data-test="quit-button"]')),
      nextEnabled: !!next && visible(next) && !next.disabled && next.getAttribute('aria-disabled') !== 'true',
      nextText: next ? (next.innerText || '').trim().slice(0, 20) : '',
      text: (document.body.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 180),
    };
  }).catch(() => null);
}

function classifyPage(snapshot) {
  if (!snapshot) return 'unknown';
  if (snapshot.hasChallenge) return 'question';
  if (snapshot.hasLoading) return 'loading';
  if (snapshot.hasStoryCover) return 'story-cover';
  if (snapshot.hasEndButton) return 'settlement';
  if (snapshot.hasQuitButton) return 'non-question';
  return 'unknown';
}

function describePage(snapshot) {
  if (!snapshot) return '页面状态未知';
  const kind = classifyPage(snapshot);
  const names = {
    question: '题目页',
    loading: '加载中',
    'story-cover': '故事封面',
    settlement: '结算页',
    'non-question': '非题目页',
    unknown: '未知页面',
  };
  const detail = kind === 'non-question' ? '（有 quit-button，无 challenge 容器）' : '';
  const text = snapshot.text ? ' text=' + JSON.stringify(snapshot.text.slice(0, 80)) : '';
  return (names[kind] || kind) + detail + ' url=' + snapshot.url + text;
}

// 只记录“最后一次有进展”的时间；调用 touch() 表示答完题、推进了页面或收到课程数据。
function createProgressGuard(timeoutMs = NO_PROGRESS_MS, now = () => Date.now()) {
  let last = now();
  return {
    touch() { last = now(); },
    stalled(nowMs = now()) { return Math.max(0, nowMs - last); },
    expired(nowMs = now()) { return nowMs - last >= timeoutMs; },
  };
}

function noProgressError(snapshot, guard) {
  return new Error('无题页面停滞 ' + Math.round(guard.stalled() / 1000) + ' 秒：' + describePage(snapshot));
}

module.exports = {
  NO_PROGRESS_MS,
  readPageState,
  classifyPage,
  describePage,
  createProgressGuard,
  noProgressError,
};

// 电台（duo_radio）专用作答器：配对完成之后的判断题、单选、多选。
//
// 页面事实（真机取证，2026-11-19）：
// - 判断题：两张 [data-test="challenge-choice"] 卡，卡内第一个 svg 渲染成勾或叉；
//   勾（41x28 viewBox）与叉（36x38 viewBox）不对称/对称程度不同，按渲染形状判定，
//   不按左右顺序、不按 class、不按尺寸。session 元素是 {type:'challenge', prompt, isTrue}。
// - 单选/多选：卡片文本与 session 元素 choices 文本一一对应，correctIndex / correctIndices 给答案。
// - 提交键：底部 img 图标按钮中作答前 disabled、作答后 enabled 的那个（唯一才点）。
// - 任何一步拿不到唯一证据 → blocked + 脱敏现场，不猜、不硬点、不按顺序凑。
const fs = require('node:fs');
const path = require('node:path');

const DIAG = path.join(__dirname, 'radio-quiz-diag.json');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
const clean = (s) => norm(s).replace(/^\d+\s*/, '').toLowerCase();

// 页内读取：卡片（含第一个 svg 的渲染形状指标）与可见按钮（含 img 文件名，不含完整 URL）
const READ_SRC = `(() => {
  const vis = (e) => { const r = e.getBoundingClientRect(), s = getComputedStyle(e); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
  const norm = (x) => (x || '').replace(/\\s+/g, ' ').trim();
  const shapeOf = (card) => {
    const svg = card.querySelector('svg');
    const p = svg && svg.querySelector('path');
    if (!svg || !p) return null;
    const vb = (svg.getAttribute('viewBox') || '').split(/[\\s,]+/).map(Number);
    const vw = vb[2], vh = vb[3];
    if (!(vw > 0) || !(vh > 0)) return null;
    try {
      const W = 48, H = Math.max(10, Math.round(W * vh / vw));
      const cv = document.createElement('canvas');
      cv.width = 480; cv.height = Math.round(480 * vh / vw);
      const g = cv.getContext('2d');
      g.scale(480 / vw, (480 * vh / vw) / vh);
      g.fillStyle = '#000';
      const path2 = new Path2D(p.getAttribute('d') || '');
      try { g.fill(path2, 'evenodd'); } catch (e) { g.fill(path2); }
      const img = g.getImageData(0, 0, cv.width, cv.height).data;
      const grid = [];
      for (let y = 0; y < H; y++) {
        const row = [];
        for (let x = 0; x < W; x++) {
          const px = Math.floor((x + 0.5) * cv.width / W), py = Math.floor((y + 0.5) * cv.height / H);
          row.push(img[(py * cv.width + px) * 4 + 3] > 96 ? 1 : 0);
        }
        grid.push(row);
      }
      let lr = 0, ud = 0, n = 0;
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        lr += grid[y][x] !== grid[y][W - 1 - x] ? 1 : 0;
        ud += grid[y][x] !== grid[H - 1 - y][x] ? 1 : 0;
        n++;
      }
      const corner = (x0, x1, y0, y1) => { let s = 0, m = 0; for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { s += grid[y][x]; m++; } return s / m; };
      const hx = Math.max(1, Math.floor(W * 0.3)), hy = Math.max(1, Math.floor(H * 0.3));
      let ink = 0; for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) ink += grid[y][x];
      return {
        vb: vw + 'x' + vh,
        mirrorLR: +(lr / n).toFixed(3), mirrorUD: +(ud / n).toFixed(3), ink: +(ink / n).toFixed(3),
        corners: { tl: +corner(0, hx, 0, hy).toFixed(3), tr: +corner(W - hx, W, 0, hy).toFixed(3), bl: +corner(0, hx, H - hy, H).toFixed(3), br: +corner(W - hx, W, H - hy, H).toFixed(3) },
      };
    } catch (e) { return { err: String((e && e.message) || e).slice(0, 60) }; }
  };
  const cards = [...document.querySelectorAll('[data-test="challenge-choice"]')].filter(vis).map((e, i) => {
    const r = e.getBoundingClientRect();
    return {
      i, text: norm(e.innerText).slice(0, 120),
      checked: e.getAttribute('aria-checked') === 'true',
      ariaDisabled: e.getAttribute('aria-disabled') === 'true',
      rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
      shape: shapeOf(e),
    };
  });
  const buttons = [...document.querySelectorAll('button')].filter(vis).map((e, i) => {
    const img = e.querySelector('img');
    const r = e.getBoundingClientRect();
    return {
      i, test: e.getAttribute('data-test') || '', text: norm(e.innerText).slice(0, 40),
      disabled: !!e.disabled,
      img: img ? String(img.getAttribute('src') || '').split('/').pop().split('?')[0].slice(0, 48) : '',
      rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
    };
  });
  return { url: location.pathname, text: norm(document.body.innerText).slice(0, 600), cards, buttons, media: document.querySelectorAll('audio, video').length };
})()`;

async function readQuiz(page) {
  return await page.evaluate(READ_SRC).catch(() => null);
}

// 勾 = 左上角空、右上角有墨（起笔左下、顶点右上）；叉 = 四角都有墨且上下对称。
// 阈值来自实测渲染指标：勾 corners.tl≈0/tr≈0.4，叉四角 0.4~0.6、mirrorUD≈0.12。
// 不用左右顺序、class、尺寸；两判据同时成立才算唯一。
function classifyShape(s) {
  if (!s || s.err || !Number.isFinite(s.mirrorLR) || !Number.isFinite(s.mirrorUD)) return 'unknown';
  const c = s.corners || {};
  const ok = (v) => Number.isFinite(v);
  const allFour = ['tl', 'tr', 'bl', 'br'].every((k) => ok(c[k]) && c[k] > 0.22);
  const cross = allFour && s.mirrorUD < 0.32;
  const check = ok(c.tl) && ok(c.tr) && c.tl < 0.12 && c.tr > 0.2;
  if (cross && !check) return 'cross';
  if (check && !cross) return 'check';
  return 'unknown';
}

// session 元素唯一匹配：判断题按 prompt 是否出现在页面文本；选择题按卡片文本与 choices 的交集。
function pickJudgeElement(session, pageText) {
  const els = ((session && session.elements) || []).filter((e) => e && typeof e.isTrue === 'boolean');
  const hits = els.filter((e) => { const p = norm(e.prompt); return p && pageText.includes(p); });
  if (hits.length === 1) return { el: hits[0] };
  return { error: 'RADIO_JUDGE_UNMATCHED hits=' + hits.length };
}

function pickChoiceElement(session, cardTexts) {
  const want = cardTexts.map(clean).filter(Boolean);
  if (new Set(want).size !== want.length) return { error: 'RADIO_CHOICE_CARD_DUP' };
  const els = ((session && session.elements) || []).filter((e) => e && Array.isArray(e.choices) && e.choices.length === want.length);
  const scored = els.filter((e) => {
    const cs = e.choices.map(clean);
    return new Set(cs).size === cs.length && cs.every((c) => want.includes(c));
  });
  if (scored.length === 1) return { el: scored[0] };
  return { error: 'RADIO_CHOICE_UNMATCHED hits=' + scored.length };
}

// 页面卡片 ↔ choices 索引一一映射（按文本唯一），任一卡片对不上就拒绝。
function mapCards(cards, choices) {
  const map = [];
  for (let ci = 0; ci < cards.length; ci++) {
    const t = clean(cards[ci].text);
    const hits = [];
    for (let xi = 0; xi < choices.length; xi++) if (clean(choices[xi]) === t && t) hits.push(xi);
    if (hits.length !== 1) return { error: 'RADIO_CHOICE_CARD_AMBIGUOUS card=' + ci + ' hits=' + hits.length };
    map.push({ card: ci, choice: hits[0] });
  }
  const back = new Set();
  for (const m of map) {
    if (back.has(m.choice)) return { error: 'RADIO_CHOICE_DUP choice=' + m.choice };
    back.add(m.choice);
  }
  return { map };
}

function correctIndices(el) {
  if (Array.isArray(el.correctIndices) && el.correctIndices.length) return el.correctIndices;
  if (Number.isFinite(el.correctIndex)) return [el.correctIndex];
  return null;
}

function cardSig(cards) {
  return (cards || []).map((c) => c.text).join('|');
}

function dumpDiag(reason, state) {
  if (process.env.RADIO_QUIZ_DIAG_OFF === '1') return;
  try {
    const safe = state ? {
      url: state.url,
      text: (state.text || '').slice(0, 300),
      cards: (state.cards || []).map((c) => ({ i: c.i, text: c.text, checked: c.checked, shape: c.shape })),
      buttons: (state.buttons || []).map((b) => ({ i: b.i, test: b.test, text: b.text, disabled: b.disabled, img: b.img })),
    } : null;
    fs.writeFileSync(DIAG, JSON.stringify({ at: new Date().toISOString(), reason, state: safe, note: '脱敏现场：不写 URL 查询值/凭据/完整 HTML' }, null, 1));
  } catch (e) {}
}

async function clickCard(page, card) {
  await page.mouse.click(card.rect.x + card.rect.w / 2, card.rect.y + card.rect.h / 2);
}

// 选卡并确认选中（aria-checked=true）。
// 真机事实（s3u71l5 判断题）：点击卡片后卡片区立即清空、只剩标题，检查键仍禁用——
// 这是「点卡即提交」的过渡，不是 aria-checked 选中。卡片消失持续 1 秒按已提交处理。
async function selectCards(page, cards, check) {
  const before = await readQuiz(page);
  const prevN = (before.cards || []).length;
  for (const c of cards) {
    await check();
    await clickCard(page, c);
    await sleep(250);
  }
  for (let i = 0; i < 20; i++) {
    await sleep(300);
    const now = await readQuiz(page);
    if (!now) break;
    const allChecked = cards.every((c) => (now.cards[c.i] || {}).checked);
    if (allChecked) return { ok: true, before, after: now };
    if (now.cards.length === 0 && prevN > 0) {
      await sleep(1000);
      const after = await readQuiz(page);
      if (after && after.cards.length === 0) return { ok: true, auto: true, before, after };
    }
  }
  return { ok: false, before, after: await readQuiz(page) };
}

// 提交键：作答前 disabled、作答后 enabled 的图标按钮；唯一才点。
async function findCheckButton(page, before) {
  const wasDisabled = (before.buttons || [])
    .filter((b) => b.disabled && b.img)
    .map((b) => b.img);
  const now = await readQuiz(page);
  if (!now) return { error: 'RADIO_CHECK_READ_FAILED' };
  const cands = (now.buttons || []).filter((b) => !b.disabled && b.img && wasDisabled.includes(b.img));
  if (cands.length === 1) return { btn: cands[0], state: now };
  return { error: 'RADIO_CHECK_UNRESOLVED candidates=' + cands.length + ' wasDisabled=' + wasDisabled.length };
}

// 等真实推进：返回学习路径 / 新题出现。
// 真机事实：点卡即提交后卡片区会清空约 14 秒（播放/过渡），之后才出下一题；
// 这段时间不是反馈页，也不该点任何键，只等。
async function waitAdvance(page, prev) {
  const prevSig = cardSig(prev.cards);
  let last = null;
  let contClicks = 0;
  for (let i = 0; i < 50; i++) {
    await sleep(700);
    last = await readQuiz(page);
    if (!last) continue;
    if (/^\/learn(\/|$)/.test(last.url)) return { status: 'learn', state: last };
    if (last.cards.length && cardSig(last.cards) !== prevSig) return { status: 'next', state: last };
    // 结算页（真机：「总经验 … 超级棒 … 继续」）只有常规 player-next，点它回学习路径
    if (!last.cards.length && contClicks < 3) {
      const cont = (last.buttons || []).find((b) => b.test === 'player-next' && /继续/.test(b.text) && !b.disabled);
      if (cont) {
        await page.mouse.click(cont.rect.x + cont.rect.w / 2, cont.rect.y + cont.rect.h / 2);
        contClicks++;
        await sleep(1200);
        continue;
      }
    }
  }
  return { status: 'timeout', state: last };
}

// 反馈页找「继续」：新出现的、enabled 的图标按钮（或文本含「继续」的按钮）；唯一才点。
async function clickContinue(page, feedback, before) {
  const prevImgs = new Set((before.buttons || []).map((b) => b.img));
  const cands = (feedback.buttons || []).filter((b) => !b.disabled && (b.text === '继续' || (b.img && !prevImgs.has(b.img))));
  if (cands.length !== 1) return { error: 'RADIO_CONTINUE_AMBIGUOUS candidates=' + cands.length };
  await page.mouse.click(cands[0].rect.x + cands[0].rect.w / 2, cands[0].rect.y + cands[0].rect.h / 2);
  return { clicked: cands[0] };
}

async function answerJudge(page, session, state, check) {
  const picked = pickJudgeElement(session, state.text);
  if (picked.error) return { status: 'blocked', error: picked.error, state };
  const kinds = state.cards.map((c) => classifyShape(c.shape));
  const checks = state.cards.filter((c, i) => kinds[i] === 'check');
  const crosses = state.cards.filter((c, i) => kinds[i] === 'cross');
  if (checks.length !== 1 || crosses.length !== 1) {
    return { status: 'blocked', error: 'RADIO_JUDGE_SHAPE_UNRESOLVED kinds=' + JSON.stringify(kinds) + ' shapes=' + JSON.stringify(state.cards.map((c) => c.shape)), state };
  }
  const want = picked.el.isTrue ? checks[0] : crosses[0];
  const sel = await selectCards(page, [want], check);
  if (!sel.ok) return { status: 'blocked', error: 'RADIO_JUDGE_SELECT_NO_FEEDBACK', state: sel.after || state };
  return { status: 'picked', before: sel.before, auto: !!sel.auto, isTrue: picked.el.isTrue, picked: want.text };
}

async function answerChoice(page, session, state, check) {
  const cards = state.cards.map((c) => c.text);
  const picked = pickChoiceElement(session, cards);
  if (picked.error) return { status: 'blocked', error: picked.error, state };
  const el = picked.el;
  const idx = correctIndices(el);
  if (!idx) return { status: 'blocked', error: 'RADIO_CHOICE_NO_ANSWER', state };
  const mapping = mapCards(state.cards, el.choices);
  if (mapping.error) return { status: 'blocked', error: mapping.error, state };
  const wantCards = [];
  for (const ci of idx) {
    const m = mapping.map.find((x) => x.choice === ci);
    if (!m) return { status: 'blocked', error: 'RADIO_CHOICE_ANSWER_NOT_ON_PAGE choice=' + ci, state };
    wantCards.push(state.cards[m.card]);
  }
  const sel = await selectCards(page, wantCards, check);
  if (!sel.ok) return { status: 'blocked', error: 'RADIO_CHOICE_SELECT_NO_FEEDBACK', state: sel.after || state };
  return { status: 'picked', before: sel.before, auto: !!sel.auto, n: wantCards.length, multi: idx.length > 1 };
}

// 主循环：答题 → 提交 → 等推进 → 继续；拿不到唯一证据就 blocked。
async function run(page, session, check = async () => {}) {
  let answered = 0;
  for (let step = 0; step < 30; step++) {
    await check();
    if (/^\/learn(\/|$)/.test(new URL(page.url()).pathname)) return { status: 'done', answered };
    let state = await readQuiz(page);
    if (!state) return { status: 'blocked', error: 'RADIO_QUIZ_READ_FAILED' };
    // 没卡片：等渲染（电台页面约 22 秒）或过场；30 秒内没卡片就停
    for (let w = 0; w < 30 && !state.cards.length; w++) {
      await sleep(1000);
      if (/^\/learn(\/|$)/.test(new URL(page.url()).pathname)) return { status: 'done', answered };
      state = await readQuiz(page);
      if (!state) return { status: 'blocked', error: 'RADIO_QUIZ_READ_FAILED' };
    }
    if (!state.cards.length) {
      dumpDiag('no-cards', state);
      return { status: 'blocked', error: 'RADIO_QUIZ_NO_QUESTION url=' + state.url, state };
    }
    // session 里有唯一判断题元素 → 必须按勾/叉作答；否则按 choices 匹配。
    // 形状判不出就 blocked，不退回选择题、不按左右顺序猜。
    const kinds = state.cards.map((c) => classifyShape(c.shape));
    const judgePick = pickJudgeElement(session, state.text);
    console.log('RADIO_QUIZ_QUESTION cards=' + state.cards.length + ' kinds=' + JSON.stringify(kinds) + ' texts=' + JSON.stringify(state.cards.map((c) => c.text)));
    let picked;
    if (judgePick.el) {
      const shapeJudge = state.cards.length === 2 && kinds.filter((k) => k === 'check').length === 1 && kinds.filter((k) => k === 'cross').length === 1;
      if (!shapeJudge) {
        dumpDiag('RADIO_JUDGE_SHAPE_UNRESOLVED kinds=' + JSON.stringify(kinds), state);
        return { status: 'blocked', error: 'RADIO_JUDGE_SHAPE_UNRESOLVED kinds=' + JSON.stringify(kinds) + ' shapes=' + JSON.stringify(state.cards.map((c) => c.shape)), state };
      }
      picked = await answerJudge(page, session, state, check);
    } else {
      picked = await answerChoice(page, session, state, check);
    }
    if (picked.status === 'blocked') {
      dumpDiag(picked.error, picked.state);
      return { status: 'blocked', error: picked.error, state: picked.state };
    }
    console.log('RADIO_QUIZ_ANSWER ' + (picked.isTrue !== undefined ? 'judge isTrue=' + picked.isTrue + ' picked=' + JSON.stringify(picked.picked) : 'choice n=' + picked.n + ' multi=' + picked.multi) + ' auto=' + !!picked.auto);
    let adv;
    if (picked.auto) {
      // 点卡即提交：卡片消失后等真正推进，不再找检查键
      adv = await waitAdvance(page, picked.before);
    } else {
      const cb = await findCheckButton(page, picked.before);
      if (cb.error) {
        dumpDiag(cb.error, cb.state || state);
        return { status: 'blocked', error: cb.error, state: cb.state || state };
      }
      await check();
      console.log('RADIO_QUIZ_SUBMIT img=' + cb.btn.img);
      await page.mouse.click(cb.btn.rect.x + cb.btn.rect.w / 2, cb.btn.rect.y + cb.btn.rect.h / 2);
      adv = await waitAdvance(page, cb.state);
    }
    console.log('RADIO_QUIZ_ADVANCE ' + adv.status);
    if (adv.status === 'learn') { console.log('RADIO_QUIZ_DONE answered=' + answered); return { status: 'done', answered }; }
    if (adv.status === 'next') { answered++; continue; }
    dumpDiag('RADIO_SUBMIT_NO_ADVANCE', adv.state);
    return { status: 'blocked', error: 'RADIO_SUBMIT_NO_ADVANCE', state: adv.state };
  }
  return { status: 'blocked', error: 'RADIO_QUIZ_TOO_MANY_STEPS' };
}

module.exports = { run, readQuiz, classifyShape, pickJudgeElement, pickChoiceElement, mapCards, correctIndices, cardSig, findCheckButton, clickContinue, waitAdvance, answerJudge, answerChoice };

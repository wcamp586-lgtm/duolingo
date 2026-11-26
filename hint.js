const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const core = require('./core.js');
const storyRunner = require('./story-runner.js');
const { COLLECT_SRC, readDom, clickMarks, fillInput } = require('./lesson-dom.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const AUTO = process.argv.includes('--auto');    // 全自动：填答案 + 点检查/继续
const HINT_ONLY = process.argv.includes('--hint'); // 只标绿框，不点
const FILL = !HINT_ONLY;                         // 默认：自动填答案，流程由用户控制
const NOPUNCT = process.argv.includes('--nopunct'); // 填答案时去掉末尾标点（更像真人手打）

// 失败留证：同一现场只记一次，写 fails.json + fail-N.png，事后直接看这两样就能定位
const fails = [];
const failKeys = new Set();
async function recordFail(page, kind, dom, extra) {
  const key = kind + '|' + ((dom && dom.type) || '') + '|' + ((dom && dom.options) || []).join('|')
    + '|' + ((dom && dom.boxText) || '').slice(0, 80);
  if (failKeys.has(key)) return;
  failKeys.add(key);
  const rec = Object.assign({
    n: fails.length + 1,
    ts: new Date().toISOString(),
    kind,
    url: page.url().replace('https://www.duolingo.com', ''),
    type: dom && dom.type,
    boxText: ((dom && dom.boxText) || '').slice(0, 600),
    domOptions: ((dom && dom.options) || []).slice(0, 40),
  }, extra || {});
  fails.push(rec);
  try { fs.writeFileSync(path.join(__dirname, 'fails.json'), JSON.stringify(fails, null, 1)); } catch (e) {}
  try { await page.screenshot({ path: path.join(__dirname, 'fail-' + rec.n + '.png') }); } catch (e) {}
  console.log(`FAIL[${kind}] #${rec.n} type=${rec.type} dom=${JSON.stringify(rec.domOptions).slice(0, 180)}`);
}

// 故事课的识别依据：页面文本里出现它的英文标题或任一对话行。
// 不能只看 URL（故事课挂在 /lesson/... 下）也不能只看 storiesSession（普通课启动时也会预加载）。
function storyTexts(sess) {
  const out = [];
  for (const e of sess.elements || []) {
    if (e.type === 'HEADER') {
      const en = (e.learningLanguageTitleContent || {}).text;
      if (en) out.push(en);
      if (e.title) out.push(e.title);   // 页面可能显示中文标题，两个都要认
    } else if (e.type === 'LINE') {
      const t = e.line && e.line.content && e.line.content.text;
      if (t && t.length > 8) out.push(t);
    }
  }
  return out;
}

// 故事课使用独立控制器，实际控件定位与结果验证见 story-runner.js。
async function storyStep(page, sess) {
  return storyRunner.step(page, sess);
}

// 题干文本：克隆容器后删掉输入框，剩下的就是题目本身。输入框里的内容变了它不变，
// 所以可以拿来判断「还是不是同一题」。不能用 session 的 prompt——英文题干题页面上只有英文句子。
async function challengePromptText(page) {
  return await page.evaluate(() => {
    const box = document.querySelector('[data-test*="challenge challenge-"]');
    if (!box) return '';
    const cp = box.cloneNode(true);
    cp.querySelectorAll('textarea, input, [contenteditable="true"]').forEach((e) => e.remove());
    return (cp.innerText || '').trim();
  }).catch(() => '');
}

// 读当前输入框已有内容：同一 ID 的题重出时容器是新的、框是空的，缓存必须失效
async function inputValueNow(page) {
  return await page.evaluate(() => {
    const box = document.querySelector('[data-test*="challenge challenge-"]');
    const el = box && box.querySelector('textarea, input[type="text"], [contenteditable="true"]');
    if (!el) return null;
    return (el.value != null ? el.value : (el.textContent || '')).trim();
  }).catch(() => null);
}

async function markState(page) {
  return await page.evaluate(() => {
    const box = document.querySelector('[data-test*="challenge challenge-"]');
    if (!box) return null;
    return { sig: box.dataset.duoSig || '', marked: box.querySelectorAll('.__duo_hi').length };
  }).catch(() => null);
}

async function applyMarks(page, marks, sig) {
  return await page.evaluate(({ src, list, signature }) => {
    document.querySelectorAll('.__duo_badge').forEach((e) => e.remove());
    document.querySelectorAll('.__duo_hi').forEach((e) => {
      e.style.outline = ''; e.style.outlineOffset = ''; delete e.dataset.duoHi; e.classList.remove('__duo_hi');
    });
    const box = document.querySelector('[data-test*="challenge challenge-"]');
    if (!box) return 0;
    const els = eval(src);            // 与 readDom 完全同一套元素与顺序
    if (!els) return 0;
    let n = 0;
    for (const m of list) {
      const el = els[m.index];
      if (!el) continue;
      el.style.outline = '3px solid #22c55e';
      el.style.outlineOffset = '3px';
      el.dataset.duoHi = '1';
      el.classList.add('__duo_hi');
      if (getComputedStyle(el).position === 'static') el.style.position = 'relative';
      if (m.order > 0) {
        const b = document.createElement('span');
        b.className = '__duo_badge';
        b.textContent = String(m.order);
        b.style.cssText = 'position:absolute;top:-9px;right:-9px;width:22px;height:22px;border-radius:50%;background:#22c55e;color:#fff;font:bold 13px/22px sans-serif;text-align:center;z-index:99999;pointer-events:none;box-shadow:0 1px 4px rgba(0,0,0,.4)';
        el.appendChild(b);
      }
      n++;
    }
    box.dataset.duoSig = signature;
    return n;
  }, { src: COLLECT_SRC, list: marks, signature: sig }).catch(() => 0);
}

async function clickToken(page, text) {
  // 一次精确匹配，一次文本兜底，不做循环重试（否则配对会一顿一顿）
  const ex = page.locator(`[data-test="${text}-challenge-tap-token"]:visible`).first();
  if (await ex.count().catch(() => 0)) { try { await ex.click({ timeout: 1500 }); return true; } catch (e) {} }
  const esc = text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // 整词匹配：hasText 是子串匹配，找 'long' 会点到 lifelong。
  // 前后都允许数字，因为脚本自己会把绿色序号塞进按钮（textContent 变成 long1 / 1long）
  const lo = page.locator('button:visible').filter({ hasText: new RegExp('^\\s*\\d*\\s*' + esc + '\\d*\\s*$') }).first();
  if (await lo.count().catch(() => 0)) { try { await lo.click({ timeout: 1500 }); return true; } catch (e) {} }
  return false;
}

(async () => {
  const ctx = await chromium.launchPersistentContext(path.join(__dirname, 'profile'), {
    headless: false, viewport: { width: 1280, height: 900 },
    args: ['--disable-blink-features=AutomationControlled', '--disable-session-crashed-bubble', '--no-first-run', '--hide-crash-restore-bubble', '--no-proxy-server'],
    ignoreDefaultArgs: ['--enable-automation'],
  });
  const page = ctx.pages()[0] || (await ctx.newPage());

  let session = null;
  // 故事数据在进课时才请求，而且常走缓存不再发；启动时先用上次存的那份，
  // 靠标题/对话文本匹配，用错故事也不会命中，不会被误当成当前课
  let storiesSession = null;
  try {
    const cached = JSON.parse(fs.readFileSync(path.join(__dirname, 'stories-session.json'), 'utf8'));
    if (cached && Array.isArray(cached.elements)) storiesSession = cached;
  } catch (e) {}
  let lexemes = null;
  page.on('response', async (r) => {
    const u = r.url();
    if (!u.includes('duolingo.com')) return;
    const ct = (r.headers()['content-type'] || '').toLowerCase();
    // session 端点即使 content-type 不是 json 也尝试解析
    if (!ct.includes('json') && !/session/i.test(u)) return;
    let j;
    try { j = await r.json(); } catch (e) { console.log('PARSE_FAIL ' + u.replace('https://www.duolingo.com', '').slice(0, 80)); return; }
    {
      const isSession = j && (Array.isArray(j.challenges) || Array.isArray(j.mistakesReplacementChallenges));
      if (/session/i.test(u) && !isSession) {
        console.log('JSON_SESSION_NONMATCH ' + u.replace('https://www.duolingo.com', '').slice(0, 80) + ' keys=' + (j && typeof j === 'object' ? Object.keys(j).slice(0, 8).join(',') : typeof j));
      }
      if (!isSession && /session|lesson|challenge|practice|stories|unit/i.test(u)) {
        console.log('JSON_OTHER ' + u.replace('https://www.duolingo.com', '').slice(0, 80) + ' keys=' + (j && typeof j === 'object' ? Object.keys(j).slice(0, 6).join(',') : typeof j));
      }
      if (u.includes('practice-lexemes')) {
        try { require('fs').writeFileSync(require('path').join(__dirname, 'practice-lexemes.json'), JSON.stringify(j, null, 1)); } catch (e) {}
        lexemes = j && j.practiceLexemes ? j.practiceLexemes : null;
        const n = lexemes ? lexemes.length : '?';
        console.log('LEXEMES_SAVED count=' + n);
      }
      if (!isSession && u.includes('stories.duolingo.com') && Array.isArray(j.elements)) {
        storiesSession = j;
        require('fs').writeFileSync(require('path').join(__dirname, 'stories-session.json'), JSON.stringify(j, null, 1));
        console.log('STORIES_SAVED elements=' + j.elements.length);
      }
      if (isSession && !u.includes('session')) console.log('SESSION from unusual url: ' + u.replace('https://www.duolingo.com', '').slice(0, 90));
      if (isSession) {
        session = j;
        const by = core.collectChallenges(j).reduce((m, c) => { m[c.__pool] = (m[c.__pool] || 0) + 1; return m; }, {});
        console.log('SESSION pools=' + JSON.stringify(by));
        try { require('fs').writeFileSync(require('path').join(__dirname, 'last-session.json'), JSON.stringify(j, null, 1)); } catch (e) {}
      }
    }
  });

  const unitArg = process.argv.slice(2).find((a) => /^\d+$/.test(a));
  if (unitArg) {
    await page.goto(`https://www.duolingo.com/lesson/unit/${unitArg}/legendary/1`, { waitUntil: 'domcontentloaded' }).catch(() => {});
    await sleep(6000);
    // 只有 --auto 才代点「继续」；默认模式停在封面上等用户自己点
    for (let i = 0; AUTO && i < 3; i++) {
      if (await page.locator('[data-test*="challenge challenge-"]').count().catch(() => 0)) break;
      let clicked = false;
      try {
        const c = page.getByRole('button', { name: '继续' }).first();
        if (await c.count()) { await c.click({ force: true }); clicked = true; }
      } catch (e) {}
      if (!clicked) await page.mouse.click(971, 792);
      await sleep(5000);
    }
  } else {
    await page.goto('https://www.duolingo.com/learn', { waitUntil: 'domcontentloaded' }).catch(() => {});
    await sleep(6000);
  }
  const nt = page.locator('[data-test="notification-drawer-no-thanks-button"]');
  if (await nt.count().catch(() => 0)) { await nt.click({ force: true }).catch(() => {}); await sleep(1000); }

  try { fs.writeFileSync(path.join(__dirname, 'fails.json'), '[]'); } catch (e) {}   // 本次从零开始记
  console.log('WAITING  (' + (FILL ? '点「开始」进课，脚本自动填答案；检查/继续/结束由你点' : '只标注，不点击') + ')');
  let lastReported = '';
  let idle = 0;
  let triedStart = false;
  let filledId = '';
  let filledAt = 0;
  let filledInputKey = '';
  let coverTries = 0;
  while (idle < 7200) {
    await sleep(1000);
    idle++;
    // 只尝试点一次「开始」，避免反复点造成循环；点不到就等用户手动点（仅 --auto）
    if (AUTO && !session && !triedStart && page.url().includes('/learn')) {
      triedStart = true;
      // 用 Playwright 自己的可见性/可点性检查，比手算坐标稳（页面有两套重叠布局）
      let clickedStart = false;
      for (const re of [/^\s*开始\s*\+\s*\d+\s*经验\s*$/, /^\s*开始\s*$/]) {
        const b = page.getByText(re).first();
        if (!(await b.count().catch(() => 0))) continue;
        try { await b.click({ timeout: 3000 }); clickedStart = true; } catch (e) {}
        if (clickedStart) break;
      }
      if (clickedStart) { console.log('CLICK_START_ONCE'); await sleep(6000); }
      else console.log('NO_START_BUBBLE  (请手动点开始)');
    }
    // 故事课走独立 API 和独立 DOM：先只采集结构，别动它
    // 故事课：用它的英文标题/对话行判断，命中才接管；普通课文本不会命中
    if (storiesSession) {
      const bodyText = await page.evaluate(() => document.body.innerText || '').catch(() => '');
      if (storyTexts(storiesSession).some((t) => t.length > 6 && bodyText.includes(t))) {
        try { await storyStep(page, storiesSession); }
        catch (e) { console.log('STORY_ERR ' + e.message); }
        continue;
      }
    }
    if (!session) {
      // 只在 URL 变化时打一次：能直接看出脚本盯的是哪个页面、是不是还没进课
      const u = page.url().replace('https://www.duolingo.com', '');
      if (lastReported !== 'nosession:' + u) {
        console.log('NO_SESSION url=' + u + '  (脚本还没拿到题目数据)');
        lastReported = 'nosession:' + u;
      }
      continue;
    }

    const dom = await readDom(page);
    if (!dom) {
      // 默认模式一个流程按钮都不碰：开始/继续/检查/跳过全由用户点
      if (!AUTO) {
        if (lastReported !== 'wait-cover') {
          console.log('WAIT_COVER  (请手动点「继续」进入课程)');
          lastReported = 'wait-cover';
        }
        continue;
      }
      lastReported = '';
      // 课程封面/引导页：点「继续」才会开题、下发 session（仅 --auto）
      if (page.url().includes('/lesson')) {
        if (coverTries >= 3) { console.log('COVER_STUCK  (点不动了，请手动处理)'); continue; }
        let clicked = false;
        const nb = page.locator('[data-test="player-next"]').first();
        if (await nb.count().catch(() => 0) && await nb.isEnabled().catch(() => false)) {
          await nb.click().catch(() => {}); clicked = true;
        }
        if (!clicked) {
          try {
            const c = page.getByRole('button', { name: '继续' }).first();
            if (await c.count()) { await c.click({ force: true }); clicked = true; }
          } catch (e) {}
        }
        if (clicked) {
          coverTries++;
          console.log('COVER_CONTINUE (' + coverTries + '/3)');
          await sleep(5000);
        } else console.log('COVER_NO_BUTTON url=' + page.url().replace('https://www.duolingo.com', ''));
      }
      continue;
    }

    // speak 没有可选项（录音按钮会被误收成“选项”），直接走口语分支
    // listenSpeak 可能有点选选项，只有真的没有选项时才按口语处理
    if (dom.type === 'speak' || (dom.type === 'listenSpeak' && !dom.options.length)) {
      if (AUTO) {
        const sk = page.locator('[data-test="player-skip"]').first();
        if (await sk.count().catch(() => 0)) { await sk.click().catch(() => {}); await sleep(2000); }
        for (let k = 0; k < 3; k++) {
          const nb = page.locator('[data-test="player-next"]').first();
          if (await nb.count().catch(() => 0) && await nb.isEnabled().catch(() => false)) { await nb.click().catch(() => {}); await sleep(2000); continue; }
          try { const c = page.getByRole('button', { name: '继续' }).first(); if (await c.count()) { await c.click({ force: true }); await sleep(2000); continue; } } catch (e) {}
          break;
        }
        console.log('SPEAK skipped');
      } else if (lastReported !== 'speak') {
        console.log('SPEAK  (请点「现在不做口语题」)');
        lastReported = 'speak';
      }
      continue;
    }

    coverTries = 0;   // 回到题目状态，重置封面重试计数
    let pools = core.collectChallenges(session);
    // 配对题（含 extendedMatch）：session 优先，失败时用 practice-lexemes 的词对兜底
    const isPair = dom.type === 'match' || dom.type === 'extendedMatch';

    // 输入框题（用英语写出这句话）：没有选项，按题干匹配后用 correctSolutions 填入
    if (dom.hasInput) {
      const ikey = 'input|' + dom.type + '|' + (dom.boxText || '').slice(0, 60);
      if (lastReported !== ikey) { console.log('INPUT_DETECTED type=' + dom.type + ' boxText=' + JSON.stringify(dom.boxText).slice(0, 100)); lastReported = ikey; }
      let ich = core.matchByPrompt(pools, dom.boxText, dom.type);
      // name 题偶尔题型标注和池子不一致；它答案唯一性强，允许回退到不限题型
      if (!ich && dom.type === 'name') ich = core.matchByPrompt(pools, dom.boxText);
      if (!ich) ich = core.matchByDisplay(pools, dom.boxText, dom.type);   // 英文题干的缺词填空
      if (ich) {
        let ans = core.textAnswers(ich)[0];
        if (NOPUNCT && ans) ans = ans.replace(/[.!?。！？]+\s*$/, '');
        const key = 'fill|' + ich.id + '|' + ans;
        if (!(await inputValueNow(page))) filledInputKey = '';   // 新容器（同一题重出）清掉旧缓存
        if (filledInputKey !== key && (FILL || AUTO)) {
          const ok = await fillInput(page, ans, {
            onMismatch: (got, want) => console.log('FILL_GOT ' + JSON.stringify(got.slice(0, 80)) + ' want=' + JSON.stringify(want.slice(0, 80))),
          });
          if (!ok) await recordFail(page, 'fill-retry', dom, { answer: ans });
          console.log(`FILL ${ich.type}[${ich.__pool}] -> ${JSON.stringify(ans)} ${ok ? 'ok' : 'FAIL'}`);
          if (ok) filledInputKey = key;
          idle = 0;
          if (ok && AUTO) {
            await sleep(2500 + Math.random() * 4000);
            for (let k = 0; k < 2; k++) {
              const nb = page.locator('[data-test="player-next"]').first();
              if (await nb.count().catch(() => 0) && await nb.isEnabled().catch(() => false)) await nb.click().catch(() => {});
              await sleep(2000 + Math.random() * 3000);
            }
          }
        }
      } else if (lastReported !== 'input-nomatch') {
        // 把池子里题干沾边的题全带上：是「同题干多种题型」还是「真的一道都没有」，一看就知道
        const near = pools.filter((p) => p.prompt && dom.boxText.includes(p.prompt)).slice(0, 6)
          .map((p) => ({ type: p.type, pool: p.__pool, prompt: p.prompt, ans: core.textAnswers(p), opts: core.challengeOptions(p).slice(0, 12) }));
        const displayNear = pools.filter((p) => (p.displayTokens || []).length).slice(0, 3)
          .map((p) => ({ type: p.type, pool: p.__pool, blanks: (p.displayTokens || []).filter((t) => t.isBlank).map((t) => t.text) }));
        await recordFail(page, 'input-nomatch', dom, {
          near, displayNear,
          poolPrompts: pools.map((p) => p.prompt).filter(Boolean).slice(0, 60),
          poolSize: pools.length,
        });
        lastReported = 'input-nomatch';
      }
      continue;
    }

    let ch = core.resolveChallenge(pools, dom);
    // 填空题没有 prompt，选项又常和其它题重复（at/on、is/it's），纯选项认不出来；
    // 退回到「用句子里的非空格词认题」
    if (!ch && /^(tapComplete|completeReverseTranslation|partialReverseTranslate)$/.test(dom.type)) {
      ch = core.matchByDisplayStrict(pools, dom.boxText, dom.type) || core.matchByDisplay(pools, dom.boxText, dom.type);
    }
    // 点选填空（gapFill）同上：没有 prompt，用 displayTokens 非空格词序列认题
    if (!ch && core.normType(dom.type) === 'gapFill') {
      ch = core.matchBySentence(pools, dom, 'gapFill');
    }
    // 配对题 session 没命中时，用词汇表构造（配不上的留给手动）
    if (!ch && isPair && lexemes) ch = core.challengeFromLexemes(lexemes, dom.options);
    if (!ch) {
      const key = 'nomatch|' + dom.type + '|' + dom.options.join('|');
      if (key !== lastReported) {
        // 题干命中页面文本的排前面，其余同题型补在后面；poolPrompts 用来判断「题到底在不在池子里」
        const sameType = pools.filter((p) => core.normType(p.type) === core.normType(dom.type));
        const inBox = sameType.filter((p) => p.prompt && dom.boxText.includes(p.prompt));
        const near = [...inBox, ...sameType.filter((p) => !inBox.includes(p))].slice(0, 8)
          .map((p) => ({ type: p.type, pool: p.__pool, prompt: p.prompt, opts: core.challengeOptions(p), ans: core.textAnswers(p) }));
        const poolPrompts = sameType.map((p) => p.prompt).filter(Boolean).slice(0, 60);
        await recordFail(page, 'nomatch', dom, { near, poolPrompts, poolSize: pools.length, sameTypeCount: sameType.length });
        lastReported = key;
      }
      continue;
    }

    // 同一题已经填过：60 秒内不再重复填（否则点掉的词块消失会让它来回填）
    if (ch.id === filledId && Date.now() - filledAt < 60000) continue;

    const plan = core.buildPlan(ch);
    const marks = core.assignMarks(dom.options, plan);
    const sig = ch.id + '|' + marks.map((m) => m.index).join(',');
    const st = await markState(page);
    // 必须核对“本题完整标记”而不是“还有没有一个标记”
    if (st && st.sig === sig && st.marked === marks.length && marks.length > 0) continue;

    const n = await applyMarks(page, marks, sig);
    idle = 0;
    // 分母是“找到的标记数”，不是答案项数；两者不等说明有词没被收集到（可能被当流程按钮过滤了）
    console.log(`MARK ${ch.type}[${ch.__pool}] ${n}/${marks.length}` + (n === 0 ? ' RETRY' : '')
      + (marks.length < plan.length ? ` ⚠PLAN ${plan.length} 只映射 ${marks.length}` : ''));
    lastReported = '';
    await page.screenshot({ path: path.join(__dirname, 'hint-' + ch.type + '.png') }).catch(() => {});

    if ((FILL || AUTO) && n > 0) {
      let ok = false;
      if (ch.type === 'match' || ch.type === 'extendedMatch') {
        // 配对题必须逐词实点：点掉一个后索引会失效
        const hits = [];
        for (const p of ch.pairs) {
          const a = await clickToken(page, p.learningToken);
          await sleep(180);
          const b = await clickToken(page, p.fromToken);
          await sleep(80);
          hits.push((a ? '✓' : '✗') + p.learningToken + '/' + (b ? '✓' : '✗') + p.fromToken);
        }
        console.log('  pairs: ' + hits.join(' | '));
        // 至少一整对（两个词都点上）才算有效，只有一个 ✓ 可能只是残留词被点掉
        ok = hits.some((h) => /^✓.*\/✓/.test(h));
      } else {
        ok = (await clickMarks(page, marks)) > 0;
      }
      if (!ok) {
        await recordFail(page, 'click-none', dom, {
          chType: ch.type, chPool: ch.__pool, chPrompt: ch.prompt,
          plan: plan.slice(0, 20), marks: marks.slice(0, 20),
          answer: core.challengeOptions(ch).slice(0, 20),
        });
        continue;
      }
      filledId = ch.id;
      filledAt = Date.now();
      console.log('  filled');
      await sleep(500);
      if (AUTO) {   // 只有 --auto 才替你点「检查/继续」；默认等你手动点
        await sleep(2000 + Math.random() * 4000);   // 随机停顿，避免固定节拍
        for (let k = 0; k < 2; k++) {
          const nb = page.locator('[data-test="player-next"]').first();
          if (await nb.count().catch(() => 0) && await nb.isEnabled().catch(() => false)) await nb.click().catch(() => {});
          await sleep(2000 + Math.random() * 3000);
        }
      }
    }
  }
  if (fails.length) {
    console.log('\n=== 本次共 ' + fails.length + ' 处没填上 ===');
    for (const f of fails) console.log('  #' + f.n + ' [' + f.kind + '] ' + (f.type || '') + '  ' + f.boxText.replace(/\n/g, ' | ').slice(0, 80));
    console.log('证据：fails.json + fail-*.png');
  } else {
    console.log('\n=== 没有记录到失败 ===');
  }
  await ctx.close();
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });

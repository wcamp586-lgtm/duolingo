// 批量跑课检查：自动点节点进课，跑完/卡住就退出，记录每课的题型与失败。
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const core = require('./core.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = (a, b) => Math.floor(a + Math.random() * (b - a));

const COLLECT_SRC = `(() => {
  const box = document.querySelector('[data-test*="challenge challenge-"]');
  if (!box) return null;
  const vis = (e) => {
    const r = e.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    if (r.bottom <= 0 || r.top >= innerHeight) return false;
    const s = getComputedStyle(e);
    if (s.display === 'none' || s.visibility === 'hidden') return false;
    if (parseFloat(s.opacity || '1') <= 0.1) return false;
    return true;
  };
  const dedupe = (ls) => {
    const seen = new Set(); const out = [];
    for (const e of ls) {
      if (!(e.textContent || '').trim()) continue;
      const r = e.getBoundingClientRect();
      const k = Math.round(r.x) + ',' + Math.round(r.y) + ',' + Math.round(r.width) + ',' + Math.round(r.height);
      if (seen.has(k)) continue; seen.add(k); out.push(e);
    }
    return out;
  };
  let els = dedupe([...box.querySelectorAll('[data-test$="challenge-tap-token"]')].filter(vis));
  if (!els.length) els = dedupe([...box.querySelectorAll('[data-test*="challenge-choice"]')].filter(vis));
  if (!els.length) els = dedupe([...box.querySelectorAll('button')].filter(vis));
  return els;
})()`;

async function readDom(page) {
  return await page.evaluate((src) => {
    const box = document.querySelector('[data-test*="challenge challenge-"]');
    if (!box) return null;
    const els = eval(src);
    const type = (box.getAttribute('data-test') || '').replace('challenge challenge-', '');
    const clean = (s) => (s || '').trim().replace(/^\d+\s*/, '');
    const hasInput = [...box.querySelectorAll('textarea, input[type="text"], [contenteditable="true"]')].some((e) => e.getBoundingClientRect().width > 0);
    return { type, options: els.map((e) => clean(e.textContent)), hasInput, boxText: (box.innerText || '') };
  }, COLLECT_SRC).catch(() => null);
}

async function fillInput(page, text) {
  const box = page.locator('[data-test*="challenge challenge-"]');
  for (const sel of ['textarea', 'input[type="text"]', '[contenteditable="true"]']) {
    const el = box.locator(sel).first();
    if (await el.count().catch(() => 0)) {
      try { await el.fill(text); return true; } catch (e) {}
    }
  }
  return false;
}

async function clickMarks(page, marks) {
  return await page.evaluate(({ src, list }) => {
    const els = eval(src);
    if (!els) return 0;
    let n = 0;
    for (const m of list) { const el = els[m.index]; if (el) { el.click(); n++; } }
    return n;
  }, { src: COLLECT_SRC, list: marks }).catch(() => 0);
}

async function applyMarks(page, marks) {
  return await page.evaluate(({ src, list }) => {
    document.querySelectorAll('.__duo_hi').forEach((e) => { e.style.outline = ''; delete e.dataset.duoHi; e.classList.remove('__duo_hi'); });
    const els = eval(src);
    if (!els) return 0;
    let n = 0;
    for (const m of list) {
      const el = els[m.index];
      if (!el) continue;
      el.style.outline = '3px solid #22c55e'; el.dataset.duoHi = '1'; el.classList.add('__duo_hi'); n++;
    }
    return n;
  }, { src: COLLECT_SRC, list: marks }).catch(() => 0);
}

async function next(page) {
  const b = page.locator('[data-test="player-next"]').first();
  if (!(await b.count().catch(() => 0))) return 'none';
  if (!(await b.isEnabled().catch(() => false))) return 'disabled';
  try { await b.click({ timeout: 2500 }); return 'ok'; } catch (e) { return 'err'; }
}

(async () => {
  const ctx = await chromium.launchPersistentContext(path.join(__dirname, 'profile'), {
    headless: false, viewport: { width: 1280, height: 900 },
    args: ['--disable-blink-features=AutomationControlled', '--disable-session-crashed-bubble', '--no-first-run', '--hide-crash-restore-bubble'],
    ignoreDefaultArgs: ['--enable-automation'],
  });
  const page = ctx.pages()[0] || (await ctx.newPage());

  let session = null;
  page.on('response', async (r) => {
    if (!r.url().includes('/2023-05-23/sessions')) return;
    try {
      const j = await r.json();
      if (j && (Array.isArray(j.challenges) || Array.isArray(j.mistakesReplacementChallenges))) {
        session = j;
        try { fs.writeFileSync(path.join(__dirname, 'last-session.json'), JSON.stringify(j, null, 1)); } catch (e) {}
      }
    } catch (e) {}
  });

  const report = [];
  const rounds = Number(process.argv[2] || 6);

  for (let r = 0; r < rounds; r++) {
    session = null;
    if (r > 0) await sleep(4000);   // 给服务端留出解锁/刷新时间
    await page.goto('https://www.duolingo.com/learn', { waitUntil: 'domcontentloaded' }).catch(() => {});
    await sleep(7000);
    const nt = page.locator('[data-test="notification-drawer-no-thanks-button"]');
    if (await nt.count().catch(() => 0)) { await nt.click({ force: true }).catch(() => {}); await sleep(800); }

    const nodes = await page.evaluate(() => {
      return [...document.querySelectorAll('button[data-test^="skill-path-level-"]')]
        .map((e) => { const b = e.getBoundingClientRect(); return { dt: e.getAttribute('data-test'), x: b.x + b.width / 2, y: b.y + b.height / 2, w: b.width }; })
        .filter((x) => x.w > 0 && x.y > 80 && x.y < 820)
        .sort((a, b) => a.y - b.y);
    });
    if (!nodes.length) { report.push({ round: r, err: 'no node' }); continue; }

    // 当前那一关 = 带「开始 +N 经验」气泡的节点。优先点气泡，它永远指向当前关
    let node = null;
    let entered = false;
    const act = page.locator('a[data-test*="skill-path-state-active"]').first();
    if (await act.count().catch(() => 0)) {
      const dt = await act.getAttribute('data-test').catch(() => '');
      await act.click({ force: true }).catch(() => {});
      await sleep(4500);
      if (page.url().includes('/lesson')) { entered = true; node = { dt }; }
    }
    // 没有气泡或没进去：逐个节点试（只在没别的办法时）
    if (!entered) {
      for (const n of nodes) {
        if (page.url().includes('/lesson')) break;
        await page.mouse.click(n.x, n.y);
        await sleep(1800);
        if (!page.url().includes('/lesson')) {
          const a2 = page.locator('a[data-test*="skill-path-state-active"]');
          if (await a2.count().catch(() => 0)) { await a2.first().click().catch(() => {}); await sleep(3500); }
        }
        if (page.url().includes('/lesson')) { node = n; entered = true; break; }
      }
    }
    if (!entered) { console.log(`  轮${r}: 没有可进的关`); report.push({ round: r, err: 'none enterable' }); continue; }
    console.log(`  轮${r} 进入 ${node.dt}`);

    // 等 session 到位
    for (let w = 0; w < 20 && !session; w++) await sleep(1000);
    if (!session) { report.push({ round: r, node: node.dt, err: 'no session', url: page.url() }); continue; }

    const row = { round: r, node: node.dt, types: {}, noMatch: [], filled: 0, marked: 0, done: false };
    for (let i = 0; i < 25 && !row.done; i++) {
      const dom = await readDom(page);
      if (!dom) {
        // 完成页：点继续
        const nb = await next(page);
        if (nb === 'none') {
          try { const c = page.getByRole('button', { name: '继续' }).first(); if (await c.count()) { await c.click({ force: true }); await sleep(2000); continue; } } catch (e) {}
          row.done = true; break;
        }
        await sleep(2000); continue;
      }
      const t = dom.type || '?';
      row.types[t] = (row.types[t] || 0) + 1;
      const pools = core.collectChallenges(session || { challenges: [] });

      if (dom.hasInput) {
        const ich = core.matchByPrompt(pools, dom.boxText);
        if (ich) {
          const ans = core.textAnswers(ich)[0];
          const ok = await fillInput(page, ans);
          if (ok) row.filled++;
          console.log(`  [${r}] FILL ${ich.type} ${ok ? 'ok' : 'FAIL'} ${JSON.stringify(ans).slice(0, 60)}`);
        } else { row.noMatch.push('input:' + (dom.boxText || '').slice(0, 40)); }
        await sleep(600); await next(page); await sleep(1500); await next(page); await sleep(1200); continue;
      }

      const ch = core.resolveChallenge(pools, dom);
      if (!ch) {
        row.noMatch.push(t + ':' + JSON.stringify(dom.options).slice(0, 80));
        // 填不了就随便点一个，让课程能走到完成页（否则这一关不算完成、下一关不解锁）
        await page.evaluate((src) => {
          const els = eval(src);
          if (els && els[0]) els[0].click();
        }, COLLECT_SRC).catch(() => {});
        await sleep(800);
        let r = await next(page);
        if (r !== 'ok') {
          const sk = page.locator('[data-test="player-skip"]').first();
          if (await sk.count().catch(() => 0)) { await sk.click().catch(() => {}); await sleep(1200); }
          r = await next(page);
        }
        await sleep(1400);
        await next(page);
        await sleep(1200);
        continue;   // 不再 break，务必把这一关走完
      }
      const marks = core.assignMarks(dom.options, core.buildPlan(ch));
      await applyMarks(page, marks);
      await clickMarks(page, marks);
      if (marks.length) row.marked++;
      console.log(`  [${r}] ${ch.type} marks=${marks.length}/${core.buildPlan(ch).length}`);
      await sleep(rand(800, 1500));
      await next(page); await sleep(rand(1400, 2200)); await next(page); await sleep(rand(900, 1400));
    }
    report.push(row);
    console.log(`ROUND ${r} done types=${JSON.stringify(row.types)} noMatch=${row.noMatch.length}`);
    const quit = page.locator('[data-test="quit-button"]').first();
    if (await quit.count().catch(() => 0)) { await quit.click().catch(() => {}); await sleep(1000);
      const c = page.locator('button:visible').filter({ hasText: /退出|离开/ }).first();
      if (await c.count().catch(() => 0)) { await c.click().catch(() => {}); await sleep(1000); }
    }
  }

  fs.writeFileSync(path.join(__dirname, 'batch-report.json'), JSON.stringify(report, null, 1));
  console.log('\n=== 汇总 ===');
  for (const r of report) console.log(`round${r.round} ${r.node || r.err} types=${JSON.stringify(r.types)} noMatch=${(r.noMatch || []).length}`);
  await ctx.close();
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });

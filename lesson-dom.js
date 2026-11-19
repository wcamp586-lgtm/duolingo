// 供 hint.js（半自动）和 lesson-runner.js（全自动）共用的页面操作。
// 只收口纯页面层：选项收集、读题、点击、填框；流程控制和日志仍留在各自入口。
// 行为与原来的两份复制实现一致，hint.js 的 FILL_GOT 日志通过 onMismatch 回调保留。
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 唯一的选项收集实现：读取 / 标注 / 点击三处 eval 同一份源码，保证索引一致
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
  // 多邻国渲染两套重叠布局，按矩形去重（读取与标注必须一致）
  const dedupe = (ls) => {
    const seen = new Set();
    const out = [];
    for (const e of ls) {
      if (!(e.textContent || '').trim()) continue;
      const r = e.getBoundingClientRect();
      const k = Math.round(r.x) + ',' + Math.round(r.y) + ',' + Math.round(r.width) + ',' + Math.round(r.height);
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(e);
    }
    return out;
  };
  // 合并所有来源：配对题左右列可能是不同容器，先匹配到一个就停会漏掉另一列
  // 只有流程按钮才按文本排除；词块本身可能就是「开始」「继续」，不能一起删掉
  const skip = /^(检查|继续|跳过|退出|开始|现在不做口语题|使用键盘|加大难度)$/;
  const isToken = (e) => /challenge-(tap-token|choice)/.test(e.getAttribute('data-test') || '');
  const all = [
    ...box.querySelectorAll('[data-test$="challenge-tap-token"]'),
    ...box.querySelectorAll('[data-test*="challenge-choice"]'),
    ...box.querySelectorAll('button'),
  ];
  const els = dedupe(all.filter(vis).filter((e) => isToken(e) || !skip.test((e.textContent || '').trim())));
  return els;
})()`;

async function readDom(page) {
  return await page.evaluate((src) => {
    const box = document.querySelector('[data-test*="challenge challenge-"]');
    if (!box) return null;
    const els = eval(src);
    const type = (box.getAttribute('data-test') || '').replace('challenge challenge-', '');
    const clean = (s) => (s || '').trim().replace(/^\d+\s*/, '');
    const hasInput = [...box.querySelectorAll('textarea, input[type="text"], [contenteditable="true"]')]
      // 缺词填空的空位空闲时宽度是 0，只看宽度会漏掉；contenteditable 本身可编辑就算
      .some((e) => e.getBoundingClientRect().width > 0 || e.isContentEditable);
    return { type, options: els.map((e) => clean(e.textContent)), hasInput, boxText: (box.innerText || '') };
  }, COLLECT_SRC).catch(() => null);
}

async function clickMarks(page, marks) {
  return await page.evaluate(({ src, list }) => {
    const els = eval(src);
    if (!els) return 0;
    let n = 0;
    for (const m of list) {
      const el = els[m.index];
      // disabled 的元素调用 click() 不会触发事件，不能记成“已选”
      if (!el || el.disabled || el.getAttribute('aria-disabled') === 'true') continue;
      el.click(); n++;
    }
    return n;
  }, { src: COLLECT_SRC, list: marks }).catch(() => 0);
}

// onMismatch(got, want)：仅 hint.js 用它保留 FILL_GOT 日志；全自动模式不传。
async function fillInput(page, text, { onMismatch } = {}) {
  const box = page.locator('[data-test*="challenge challenge-"]');
  const el = box.locator('textarea, input[type="text"], [contenteditable="true"]').first();
  if (!(await el.count().catch(() => 0))) return false;
  // ElementHandle 绑定这个具体元素：题目被换掉后操作会报错，不会把旧答案写进新题的框
  const handle = await el.elementHandle().catch(() => null);
  if (!handle) return false;

  const norm = (s) => (s || '').replace(/\s+/g, ' ').trim().toLowerCase();
  const read = async () => norm(await handle.evaluate((e) => (e.value != null ? e.value : (e.textContent || ''))).catch(() => ''));
  const want = norm(text);
  const clear = async () => {
    await handle.click({ timeout: 1500, force: true }).catch(() => handle.focus().catch(() => {}));
    await page.keyboard.press('Meta+A').catch(() => {});
    await page.keyboard.press('Backspace').catch(() => {});
  };

  try {
    await handle.scrollIntoViewIfNeeded().catch(() => {});
    // 方式一：逐字键击
    await clear();
    await handle.type(text, { delay: 12 });
    await sleep(200);
    let got = await read();
    if (got === want) return true;

    // 方式二：一次性插入。缺词填空的空位宽度为 0 时键击容易丢字，
    // insertText 走 beforeinput/input 事件，React 一样能收到
    await clear();
    await page.keyboard.insertText(text).catch(() => {});
    await sleep(200);
    got = await read();
    if (got === want) return true;

    // 校验放宽：空位里可能残留占位符字符，答案整段在里面就算填进去了
    if (want && got.includes(want)) return true;

    if (onMismatch) onMismatch(got, want);
    return false;
  } catch (e) {
    return false;
  }
}

module.exports = { COLLECT_SRC, readDom, clickMarks, fillInput };

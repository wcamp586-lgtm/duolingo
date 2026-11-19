// 历史实现存档：prepareLegendary（靠页面点击找传奇入口）。
// 2026-11-18 从 legendary-entry.js 移除：auto-runner 已改用 prepareByUrl 直接构造 URL，此函数无人调用。
// 本文件只存档，不参与运行，也不被 npm test 引用；它依赖 legendary-entry.js 里的
// ORIGIN / LEARN / parseLegendaryEntry。

async function prepareLegendary(page, slot, check) {
  const heading = new RegExp('^第\\s*' + (slot.sectionIndex + 1) + '\\s*阶段');
  // 每次都刷新路径页：URL 是 /learn 不代表页面就是当前课程，
  // 切过课程后页面可能还留着上一门课的路径（unit 编号对不上就永远找不到节点）。
  await check();
  await page.goto(ORIGIN + '/learn', { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});

  if (!LEARN.test(page.url())) {
    await check();
    await page.goto(ORIGIN + '/sections', { waitUntil: 'domcontentloaded', timeout: 20000 });
    const title = page.getByText(new RegExp(heading.source + '\\s*$'));
    const card = title.locator('xpath=ancestor::*[.//button[normalize-space(.)="复习" or normalize-space(.)="继续"]][1]');
    const review = card.getByRole('button', { name: /^(复习|继续)$/ });
    await review.waitFor({ timeout: 12000 });
    await check();
    await review.click({ timeout: 5000 });
    await page.waitForURL(LEARN, { timeout: 12000 });
  }

  const path = page.locator('[data-test="skill-path"]');
  await path.waitFor({ timeout: 12000 });
  const node = path.locator('[data-test="skill-path-unit-' + slot.unitIndex + '"]')
    .locator('[data-test="skill-path-level-' + slot.levelIndex + ' skill-path-level-' + slot.type + '"]');

  for (let attempt = 0; attempt < 90 && !await node.count(); attempt++) {
    await check();
    const moved = await page.evaluate(unit => {
      const rendered = [...document.querySelectorAll('section[data-test^="skill-path-unit-"]')]
        .map(element => Number(element.dataset.test.split('-').at(-1)));
      const before = window.scrollY;
      window.scrollBy(0, (unit < Math.min(...rendered) ? -1 : 1) * Math.round(window.innerHeight * 0.9));
      return window.scrollY !== before;
    }, slot.unitIndex);
    await page.waitForTimeout(150);
    if (!moved) break;
  }
  await node.scrollIntoViewIfNeeded({ timeout: 3000 });
  const menu = page.locator('[data-test="legendary-node-button"]:visible');
  await check();
  // 路径节点有入场动画，locator.click 会报 element is not stable；用坐标点并重试
  let nodeClicked = false;
  for (let i = 0; i < 3 && !nodeClicked; i++) {
    const box = await node.boundingBox().catch(() => null);
    if (box && box.width > 5 && box.height > 5) {
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      nodeClicked = true;
    } else {
      await page.waitForTimeout(500);
    }
  }
  if (!nodeClicked) throw new Error('路径节点点不到');
  try {
    await menu.waitFor({ timeout: 1000 });
  } catch {
    await check();
    const box = await node.boundingBox();
    if (!box) throw new Error('路径节点已移出页面');
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  }
  await menu.waitFor({ timeout: 3500 });
  await check();
  // 菜单按钮同样有动画，locator.click 会不稳定；用坐标点并重试
  let menuClicked = false;
  for (let i = 0; i < 4 && !menuClicked; i++) {
    const box = await menu.boundingBox().catch(() => null);
    if (box && box.width > 5 && box.height > 5) {
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      menuClicked = true;
    } else {
      await page.waitForTimeout(400);
    }
  }
  if (!menuClicked) throw new Error('传奇菜单按钮点不到');
  const button = page.locator('[data-test="legendary-start-button"]:visible');
  await button.waitFor({ timeout: 6000 });
  const url = parseLegendaryEntry(await button.getAttribute('href'));
  return { button, url };
}

module.exports = { prepareLegendary };

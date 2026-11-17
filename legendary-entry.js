const ORIGIN = 'https://www.duolingo.com';
const LEARN = /^https:\/\/www\.duolingo\.com\/learn(?:[/?#]|$)/;

function parseLegendaryEntry(href) {
  if (!href) throw new Error('传奇确认层没有入口链接');
  const url = new URL(href, ORIGIN);
  if (url.origin !== ORIGIN || !/^\/lesson\/unit\/[1-9]\d*\/legendary\/[1-9]\d*\/?$/.test(url.pathname)) {
    throw new Error('目标节点没有有效的传奇入口');
  }
  return url;
}

// URL 层号 = 路径索引 + 1（u23l0→unit/24/legendary/1、u23l2→unit/24/legendary/3，已验证多次）。
// 直接构造省掉路径节点定位：/learn 只渲染当前一小段，节点还可能被课程切换搞错。
async function prepareByUrl(page, slot, check) {
  const guess = ORIGIN + '/lesson/unit/' + (slot.unitIndex + 1) + '/legendary/' + (slot.levelIndex + 1);
  await check();
  await page.goto(guess, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(3500);
  const button = page.locator('[data-test="legendary-start-button"]:visible').first();
  if (!(await button.count())) {
    // 有些节点不走确认页，直接进了课程；URL 已经在目标上就不算失败
    const u = new URL(page.url());
    if (u.origin === ORIGIN && /^\/lesson\/unit\/\d+\/legendary\/\d+/.test(u.pathname)) {
      return { button: null, url: u };
    }
    throw new Error('目标节点没有有效的传奇入口');
  }
  let url;
  try { url = parseLegendaryEntry(await button.getAttribute('href')); }
  catch (e) { const u = new URL(page.url()); url = u.origin === ORIGIN ? u : new URL(guess); }
  return { button, url };
}

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

function findCourseLevel(course, slot) {
  if (course.id !== slot.courseId) return null;
  const section = course.pathSectioned.find(value => value.index === slot.sectionIndex);
  const unit = section?.units.find(value => value.unitIndex === slot.unitIndex);
  return unit?.levels.find(level => level.id === slot.id) ?? null;
}

module.exports = { prepareByUrl, prepareLegendary, parseLegendaryEntry, findCourseLevel, LEARN, ORIGIN };

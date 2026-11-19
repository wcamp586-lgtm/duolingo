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

function findCourseLevel(course, slot) {
  if (course.id !== slot.courseId) return null;
  const section = course.pathSectioned.find(value => value.index === slot.sectionIndex);
  const unit = section?.units.find(value => value.unitIndex === slot.unitIndex);
  return unit?.levels.find(level => level.id === slot.id) ?? null;
}

module.exports = { prepareByUrl, parseLegendaryEntry, findCourseLevel, LEARN, ORIGIN };

# 多邻国「故事课自动作答」交接文档

> 2026-11-03 实测更新：当前 The Basketball Player 会话的 7 个交互元素已逐项完成，包括最后 5 组配对。
> 根因已确认：选择题的实际控件是答案行 `li` 内无文字的 `button[data-test="stories-choice"]`，答案文字是它的兄弟节点。
> 故事逻辑已迁入 `story-runner.js`，旧的按文字中心坐标点击逻辑已移除；补齐排序、短语选择、配对并验证页面状态。
> 最后一道题完成后保留绿色「继续」供用户手动结束，未代点最终结束，也未验证最终 XP 结算。
> 证据：`story-debug/live-test.jsonl`、`story-debug/all-questions-verified.png`；`npm test` 运行 43 项核心测试及 7 项故事测试。
> 下文保留此前卡点记录，旧代码描述不再代表当前实现。

写于 2026-11-03。目标读者：接手继续做的人。所有结论标了「已验证 / 未验证」。

---

## 1. 需求

用户要**故事课全自动**：

- 自动读故事数据、自动选答案、自动点「继续」往下推进
- 用户只负责两件事：**点进课程**、**最后点结束课程**

现有的普通课程填充器（`hint.js`）已经稳定工作，只差故事课这一块。**除故事课外，本次改动不影响其它课程**。

---

## 2. 已经验证的事实

### 2.1 故事课的入口和 URL

- 故事课 URL 是 `https://www.duolingo.com/lesson/unit/<N>/legendary/<M>`，**不是** `/stories`。
- 不能靠 URL 识别是不是故事课。

### 2.2 数据接口

页面加载时会请求：

```
https://stories.duolingo.com/api2/stories/en-zh-<slug>?crowns=<N>
```

返回 JSON，核心字段 `elements[]`。已保存样本：项目根目录 `stories-session.json`。

元素类型（样本里的实际分布）：

```
HEADER 1, LINE 20, CHALLENGE_PROMPT 2,
MULTIPLE_CHOICE 3, ARRANGE 1, GAP_FILL, POINT_TO_PHRASE 1,
SELECT_PHRASE 1, MATCH 1
```

关键结构：

```jsonc
// HEADER：中文标题在 title，英文标题在 learningLanguageTitleContent.text
{ "type": "HEADER", "title": "篮球运动员",
  "learningLanguageTitleContent": { "text": "The Basketball Player" } }

// LINE：对话行
{ "type": "LINE", "lineIndex": 1,
  "line": { "type": "PROSE", "content": { "text": "Vikram and Priti are shopping." } } }

// MULTIPLE_CHOICE：注意答案是「已经翻译好的中文」，和页面选项文本完全一致
{ "type": "MULTIPLE_CHOICE",
  "question": { "text": "Priti 看到谁了？" },
  "answers": [
    { "text": "Vikram 最喜欢的篮球运动员" },
    { "text": "她最喜欢的篮球运动员" },
    { "text": "几个正在玩游戏的人" } ],
  "correctAnswerIndex": 0,
  "lineIndex": 6 }
```

**答案文本与页面显示完全一致**（中文对中文），这本该让匹配很简单。

### 2.3 页面 DOM（部分已知）

`[data-test]` 全集（每屏都能采集到）：

```
stories-element, audio-button, close-button-stories,
stories-player-continue, drawer-backdrop
```

- **推进按钮有 `data-test="stories-player-continue"`**
- 封面按钮文字是「**开始读故事**」，对话屏是「**继续**」，不是始终叫「继续」

**唯一抓到的选项结构**（选择题页面，从答案文字向上找到的祖先行）：

```html
<div class="_3altc" dir="ltr">
  <div class="_15RU4 phrase">
    <span class="_3mgvn _1eBwj _2zwHn">Vikram</span>
    <span class="_3mgvn _1eBwj"> 最喜欢的篮球运动员</span>
  </div>
</div>
```

这个 `_3altc` 的实测属性（见日志 `STORY_DOM`）：

```
tag=DIV  role=null  tabindex=null  cursor=default   ← 注意 cursor 不是 pointer
```

类名是 CSS Modules 的 hash（`_3altc`、`_15RU4`、`_3mgvn`），**换版本就会变，不能写死**。

### 2.4 无障碍树里页面内容完全不可点 —— 已验证

用 macOS 无障碍树枚举（`desktop_observe`）查该窗口，**只列出浏览器的前进/后退/地址栏等控件，页面里的三个选项一个都没有**。

结论：选项不是 `<button>` / `<input>` / `[role=checkbox]` / `<a>`，是纯 `<div>` 挂 React 事件。

---

## 3. 已经尝试过的方案与结果

| # | 做法 | 结果 |
|---|---|---|
| 1 | 按 `<button>` 收集选项 | 失败。只收到「继续」一个，选项不是 button |
| 2 | `el.locator().click()` 点答案文字 | 失败。日志报告「点了」，但复选框一个没选中，「继续」保持灰色 |
| 3 | `page.mouse.click(x, y)` 点文字坐标 | 失败。同上 |
| 4 | 从文字向上找 `cursor:pointer` / `role=checkbox` / `tabindex=0` 的祖先再点 | **未验证**。代码已写，用户已放弃继续试 |

日志证据（`hint.log` / `hint.log.r12`）：

```
STORY_DOM {"tag":"DIV","cls":"_3altc","role":null,"tab":null,"cur":"default", ...}
STORY_ANSWER -> "Vikram 最喜欢的篮球运动员"  (Priti 看到谁了？)  try=1
STORY_ANSWER -> "Vikram 最喜欢的篮球运动员"  (Priti 看到谁了？)  try=2
STORY_ANSWER -> "Vikram 最喜欢的篮球运动员"  (Priti 看到谁了？)  try=3
STORY_STUCK  (没有可点的推进按钮)
```

**唯一卡住的环节就是选择题选项点不中。** 其它环节都验证可用：

- 抓故事数据 ✓
- 识别故事课 ✓（见 4.1）
- 点「开始读故事」/「继续」推进对话 ✓（日志大量 `STORY_NEXT`，对话确实在往下走）

---

## 4. 现状代码

文件 `hint.js`（项目根目录），故事课相关四个函数：

| 函数 | 作用 |
|---|---|
| `storyTexts(sess)` | 从 session 提取「英文标题 + 中文标题 + 所有对话行文本」，用于判断当前页面是不是这个故事 |
| `captureStory(page)` | 每屏采集一次结构，写 `story-dump.json`（去重，最多 80 条） |
| `storyChoose(page, d, sess)` | 选择题作答：题干出现在页面 + 答案文本命中 → 点击 |
| `storyStep(page, sess)` | 先试选择题，不是选择题就点推进按钮 |

`core.js` 里已有纯函数：

- `storiesPlan(el)` —— 按题型取出应选项
- `storiesQuestions(session)` —— 过滤出可交互题

主循环里的接管入口：

```js
if (storiesSession) {
  const bodyText = await page.evaluate(() => document.body.innerText || '');
  if (storyTexts(storiesSession).some((t) => t.length > 6 && bodyText.includes(t))) {
    try { await storyStep(page, storiesSession); }
    catch (e) { console.log('STORY_ERR ' + e.message); }
    continue;
  }
}
```

### 4.1 为什么用「页面文本」而不是 URL 判断

- URL 不可靠（故事课挂在 `/lesson/...`）
- `storiesSession` 也不可靠（**普通课程启动时也会预加载故事数据**，一次性给出 `STORIES_SAVED`）
- 用「页面上出现这个故事的标题或任一句对话」判断，普通课文本不会命中

---

## 5. 三个待验证假设（按可能性排序）

### 假设 A（最可能）：有透明遮罩挡住了点击

页面 `[data-test]` 里**一直存在 `drawer-backdrop`**。它可能不可见但仍吃掉了 pointer events，导致所有鼠标点击都落在遮罩上而不是选项。

**验证方法**（进故事课选择题页面，在 DevTools Console 或脚本里执行）：

```js
// 找到答案元素
const el = [...document.querySelectorAll('div')]
  .find(d => d.textContent.trim() === 'Vikram 最喜欢的篮球运动员');
const r = el.getBoundingClientRect();

// 这一点上真正的元素是什么？
const top = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
console.log('命中元素:', top, top.className, top.getAttribute('data-test'));

// 遮罩存在吗、可点吗
const bd = document.querySelector('[data-test="drawer-backdrop"]');
console.log('backdrop:', bd, bd && getComputedStyle(bd).pointerEvents, bd && bd.getBoundingClientRect());
```

如果 `elementFromPoint` 返回的不是选项行，假设成立。

### 假设 B：React 用的是 `onPointerDown` / `onMouseDown`

Playwright 的 `page.mouse.click()` 理论上会发 pointerdown + mousedown + mouseup + click 全套，但如果 Duolingo 有特殊处理，可试：

```js
const r = el.getBoundingClientRect();
const x = r.x + r.width / 2, y = r.y + r.height / 2;
el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: x, clientY: y }));
el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: x, clientY: y }));
el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: x, clientY: y }));
el.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: x, clientY: y }));
```

### 假设 C：可点区域不在文字祖先链上

截图里每个选项是「左侧方块 + 右侧文字」。方块可能是**和文字平级的兄弟节点**，点击处理挂在整个选项行（比 `_3altc` 更高层）或用事件委托挂在列表容器上。

`_3altc` 的 `cursor` 是 `default`，说明连它都不是设计上的可点元素。

**验证方法**：dump 完整 HTML 后看层级（见下节）。

---

## 6. 给接手的建议（重要）

### 6.1 先把调试通道打开

现在 `hint.js` 用 `--remote-debugging-pipe` 启动，**外部无法连接**，只能靠在脚本里打日志盲猜，这是本次卡住的根本原因。

改 `hint.js` 第 ~206 行的启动参数，加：

```js
args: [ ..., '--remote-debugging-port=9222' ]
```

然后用外部 Playwright / CDP 连上去，可以自由执行任意 DOM 查询，不用再改一次代码重启一次浏览器。

### 6.2 抓完整 HTML

进到故事课选择题那一屏，执行：

```js
// 整个故事面板
require('fs').writeFileSync('story-full.html',
  document.querySelector('[data-test="stories-element"]').outerHTML);
// 或整个 body
require('fs').writeFileSync('story-body.html', document.body.outerHTML);
```

现有 `captureStory()` 只存了几十字符的片段，**远远不够**。

### 6.3 找事件绑定

DevTools → Elements → 选中选项 → 右侧 **Event Listeners** 面板，看 click / pointerdown 挂在哪个祖先上。这一步能直接回答「点哪里才对」。

### 6.4 判断「是否选中」要有依据

现在脚本无法知道点击是否生效（只能靠「继续」按钮是否变绿倒推）。选中状态可能体现在：

- 选项行 class 增加（hash 名，需实测）
- 左侧方块里出现一个 `<svg>` / `<path>`
- `aria-checked` / `aria-selected`

确认后应该**点完立即校验**，而不是靠重试。

### 6.5 可复用、已验证的部分

以下不用重做：

- 故事数据抓取（`page.on('response')` 里识别 `stories.duolingo.com` 且 `Array.isArray(j.elements)`）
- 故事课识别（`storyTexts()` + 页面文本包含判断）
- 推进按钮：`[data-test="stories-player-continue"]`，文字是「开始读故事」或「继续」
- 该按钮在选择题未做完时是 `disabled` 的 —— 可以拿它当「有没有选完」的判据

---

## 7. 相关文件

| 文件 | 说明 |
|---|---|
| `hint.js` | 主脚本；故事课逻辑在 `storyTexts` / `captureStory` / `storyChoose` / `storyStep` |
| `core.js` | 纯函数；`storiesPlan` / `storiesQuestions` |
| `stories-session.json` | 故事数据样本（`The Basketball Player`，31 elements） |
| `story-dump.json` | 脚本每屏采集的结构（当前无选择题屏，因去重键太短被跳过） |
| `probe-story-dom.js` | 早期写的故事 DOM 探查脚本，可参考其连接方式 |
| `hint.log` / `hint.log.r12` 等 | 各轮运行日志，`STORY_DOM` / `STORY_ANSWER` 证据都在里面 |

---

## 8. 一句话总结

**除了「在选择题里点中选项」这一个动作，故事课自动化的其它部分都已经能用。** 卡住的原因是拿不到真实 DOM 结构，只能在每次重启后靠几十字符的日志片段推测——建议接手时先开 CDP 调试端口，把那一屏的完整 HTML 和事件绑定看清楚，再动手。

# 多邻国传奇课自动刷取 · 运行手册

给新会话用。照这里的顺序做，不要在没读完“开跑前检查清单”的情况下直接启动。

代码位置：`/Users/fengzhao/Projects/duolingo`（旧文档里的 `~/duo-xp` 链接已不存在）。

> **文档状态**：本文件是唯一运行手册。README 是使用入口；HANDOFF.md、AUTOMATION-PLAN.md、STORY-COURSE-HANDOFF.md、HANDOVER.md 是历史记录，不再维护。

---

## 一、开跑前检查清单（三步，缺一不可）

### 1. 确认当前课程是你想刷的那门

**这是最大的坑。** `auto-runner` 不选课程，它刷的是账号当前的活动课程。这两天发生过两次：准备刷英语，一启动发现刷的是日语。

在网页上切好课程后，用这个命令确认（会开一个有头窗口，读 `currentCourse.id`）：

```bash
cd /Users/fengzhao/Projects/duolingo && node -e "
const {chromium}=require('playwright');
(async()=>{
  const ctx=await chromium.launchPersistentContext('profile',{executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true,args:['--no-proxy-server']});
  const p=ctx.pages()[0]||await ctx.newPage();
  await p.goto('https://www.duolingo.com/learn',{waitUntil:'domcontentloaded',timeout:30000});
  await p.waitForTimeout(7000);
  const r=await p.evaluate(async()=>{const x=await fetch('/2023-05-23/users/769346152?fields=currentCourse,totalXp',{credentials:'include'});const j=await x.json();return {course:j.currentCourse&&j.currentCourse.id,xp:j.totalXp};});
  console.log(JSON.stringify(r));await ctx.close();
})().catch(e=>{console.error('ERR',e.message.split('\n')[0]);process.exit(1)});
"
```

输出里的 `course` 必须是目标课程，例如英语是 `DUOLINGO_EN_ZH-CN`、日语是 `DUOLINGO_JA_ZH-CN`。**不是就别跑**，让用户切课程。

### 2. 确认系统 Chrome 在

```bash
ls -d /Applications/Google\ Chrome.app && "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --version
```

Playwright 自带的 Chrome for Testing 156 在这台 macOS 27 上**有头启动就 SIGTRAP 崩溃**（无头正常）。所以 `auto-runner` 已经改成优先用系统 Chrome（`executablePath`，`fs.existsSync` 探测，不存在则回退自带浏览器——回退后会崩）。系统 Chrome 被卸载过（用户用 Krokiet 清理时连带清掉），现在装回来了，版本 157。

### 3. 确认没有别的实例占着 `profile/`

`profile/` 是登录态（约 1.1GB，2026-11-18 实测），**不要删**。两个浏览器同时用同一个 user-data-dir 会互相锁死。

```bash
pgrep -fl 'Google Chrome for Testing' | head -5
```

注意：用户自己开的 Chrome（带 `--remote-debugging-port=9222` 那个）用的是默认 profile，和这里的 `profile/` 不冲突，**不要杀**。

---

## 二、命令速查

```bash
cd /Users/fengzhao/Projects/duolingo

# 正式跑：时间上限（分钟）
node auto-runner.js --minutes 180

# 只跑 N 关就停（打通端到端时用，约 3 分钟）
node auto-runner.js --minutes 60 --max-lessons 1

# 到达 XP 上限即停（与 --minutes 二选一或同用，先到先停）
node auto-runner.js --xp 2000

# 从指定 section/unit 之后开始（默认 0/0 = 从队列最前面）
node auto-runner.js --minutes 60 --from-section 3 --from-unit 100

# 再加 --from-level 可跳过同一 unit 里的前几关（story 定位用）
node auto-runner.js --minutes 60 --from-unit 69 --from-level 1

# 普通课模式：从零做当前 active 节点（每节 15-17 题、+15 XP；一个 skill 节点通常要 4 节才 passed）
node auto-runner.js --normal --minutes 180 --max-lessons 4

# 只看队列，不开浏览器（用 course-path.json 快照，是 11-04 的旧数据，仅供粗看）
node auto-runner.js --dry-run --minutes 60

# 读账号总 XP（自带 Chromium 无头）
node read-xp.js
```

`read-xp.js` 已优先用系统 Chrome（找不到则回退 Playwright 自带 Chromium），和 `auto-runner` 一致。它只操作项目 `profile/`，不碰你日常用的 Chrome（默认 profile 是另一个 user-data-dir）。

**后台跑建议**（长任务用，日志落盘）：

```bash
cd /Users/fengzhao/Projects/duolingo && node auto-runner.js --minutes 180 2>&1 | tee auto-3h.log
```

`--minutes` / `--xp` 至少给一个，否则直接报错退出。

---

## 三、策略与判定逻辑（读代码前先理解这些）

### 刷哪些关

`policy.planCourse(course)` 只挑**已通过、还没传奇**的节点，类型限于 `skill` / `story` / `practice` / `unit_review`，按课程顺序（section → unit → level）排。

`--normal` 模式走 `policy.planNormal(course)`：只挑 `state === 'active'` 的节点（同一时刻只有一个）。按类型分入口：

- `skill` / `story`：`/lesson`，`LESSON` / `LEVEL_REVIEW` 会话，按 `skillId + crownLevelIndex` 匹配；一个 skill 通常要 4 节才 `passed`，成功判定用 **XP 到账**。
- `practice`：`/lesson`，会话是 `LEXEME_PRACTICE`（Course Practice）或 `UNIT_PRACTICE`（Unit Practice），没有 skillId 可对。
- `chest`：`/learn` 上点「打开」，不给 XP，节点变 `passed` 后解锁下一节点。
- `duo_radio`：路径上点它；有「稍后选择」时点击，但**点击本身不算成功**。要再找**同一 unit 往后**第一个有 `<a data-test="skill-path-state-active …">开始 +10 经验</a>` 的节点，点「开始」前先数候选：多个「开始」同时可见且无法唯一对应到刚选中的节点时，记 `RADIO_NEXT_AMBIGUOUS` 且不点；唯一才点。点完后先确认仍在 `/lesson` 课程路由，再确认题目/挑战容器出现（`lesson-guard` 判定为 `question`），两者都满足才打唯一一条 `RADIO_ADVANCED id=… next=… evidence=question url=…`；结算日志带 `radio=advanced next=…`。拿不到证据都算待处理：无入口 `RADIO_UNSUPPORTED`、点「稍后选择」失败 `RADIO_SKIP_CLICK_FAILED`、点了完全没变化 `RADIO_SKIP_NO_CHANGE`、弹窗收起但没推进 `RADIO_NO_PROGRESS`、后续节点/开始点击失败 `RADIO_NEXT_CLICK_FAILED`、多个入口无法唯一对应 `RADIO_NEXT_AMBIGUOUS`、离开 `/lesson` 的误导航 `RADIO_WRONG_PAGE`；都本次运行标记待处理，不猜下一节点。

单元测试入口是 `/lesson/unit/<unit+1>/test`（会话类型 `UNIT_TEST`，约 18 题，+50 XP）。

所以“从头开始刷”的真实含义是：**从课程里最靠前的未传奇节点开始**。前面的关如果已经是传奇，就不会再碰。电台、AI 对话、宝箱不在目标类型里，不刷；听说题遇到会自动点平台的跳过入口。

### 什么算成功

每关必须**同时满足**才记 `SETTLED`：

1. 目标节点的 `state` 变成 `legendary`
2. 账号 `totalXp` 比开课前增加

只点完“结束”不算，脚本会回读服务器核对。所以 `SETTLED` 是可以信的。

### 什么时候停

- 到时间上限 / XP 上限：不再开新课，但**手上这一关会结算完**才退（所以 `elapsedMs` 会比 `--minutes` 略长）
- 平台信号（401/403/429、登录页、可见 reCAPTCHA、验证路由）：**立即抛错终止**，截图存 `auto-blocked.png`，等人工处理
- 连续 8 关失败：终止
- 单关故障（超时、确认不到结算）：跳过该关、`SKIP_SLOT` 记一次，下一轮会重试它

### 实测速率（英语课）

| 日期 | 时长 | 关卡 | XP | 速率 |
|---|---:|---:|---:|---|
| 11-13 | 60 分钟 | 47 | +1880 | 76 秒/关 |
| 11-14 | 60 分钟 | 22（+1 未确认） | +1120 | 165 秒/关 |
| 11-16 | 180 分钟 | 75 | +3200 | 146 秒/关 |

单关 XP 通常是 40，偶尔 80（实测 11-14 有 6 关、11-16 有 5 关是 80，通常连续出现在同一区块）。**不要假设恒定 40**，对账要用 `totalXp` 差值。

---

## 四、日志怎么读

每一行的含义：

| 行 | 意思 |
|---|---|
| `START xp=... course=...` | 开跑基线。**先看 course 对不对** |
| `ENTRY s3u107l4 The Old TV → /lesson/...` | 正在进的关，`s`=section `u`=unit `l`=level |
| `LESSON_ANSWERED type=translate` | 答完一题，`type` 是题型 |
| `STORY_VERIFIED ...` / `STORY_DONE` | 故事课进度 |
| `SETTLED id=... state=legendary xp=... delta=40 answered=17` | 结算成功。`delta` 是这关涨的 XP |
| `SKIP_SLOT id=... (n/8) 原因` | 这一关这次失败，被跳过，之后会重试 |
| `NOMATCH_DETAIL {...}` | 第一次认不出题时的现场（kind / 页面选项 / 题干 / 同题型候选池） |
| `STOP {...}` | 正常结束，`xpGain` 是本次总增量 |
| `STOP story-done（最后结束课程需用户点击）` | 故事已答完但结束控件不明确/点不动；本轮停止，专用窗口和页面已保留 |
| `KEEP_OPEN 专用窗口和当前页面已保留` | 走到必须人工收尾的情况，没有在 finally 关闭浏览器 |
| `RADIO_ADVANCED id=... next=s3u71l1 evidence=question url=/lesson` | 唯一成功日志：后续节点已打开、开始已点击、挑战容器已出现 |
| `RADIO_NO_PROGRESS ...` | 弹窗收起或点了开始，但没进入题目界面，本次运行标记待处理 |
| `RADIO_NEXT_CLICK_FAILED ... step=node\|start` | 找到后续入口但点击失败，本次运行标记待处理 |
| `RADIO_NEXT_AMBIGUOUS ... candidates=N` | 多个「开始」同时可见且无法唯一对应，不点击，本次运行标记待处理 |
| `RADIO_WRONG_PAGE ...` | 点「开始」后离开 `/lesson`（回首页/别的页面），本次运行标记待处理 |
| `RADIO_SKIP_CLICK_FAILED ...` | 点击「稍后选择」抛错，本次运行标记待处理 |
| `RADIO_SKIP_NO_CHANGE ...` | 点击「稍后选择」后页面完全没变化，本次运行标记待处理 |
| `RADIO_UNSUPPORTED id=... ...` | 没有「稍后选择」入口，本次运行标记待处理 |
| `SETTLED ... radio=advanced next=...` | radio 内容跳过后，由产品 state + XP 确认结算 |
| `BLOCKED 原因` | 被平台信号或致命错误打断 |

### 结束后的对账方法

1. 读 `STOP` 行的 `xpGain`
2. 再独立读一次服务器 `totalXp`（`node read-xp.js`）
3. 两个数必须相等
4. 关卡数 = `grep -c '^SETTLED' 日志`，类型用 `ENTRY` 名称 + `LESSON_DATA type=` 判断

**注意**：`SKIP_SLOT` 之后重试成功的关，会在 `SETTLED` 里出现一次；`SETTLED` 条数才是实际完成的关卡数。`ENTRY` 条数可能更多（含重试）。

---

## 五、已知失败模式（都有实例，不是推测）

| 现象 | 原因 | 处置 |
|---|---|---|
| `未收到与目标节点匹配的课程数据` | 进课后 45 秒内没收到与目标 `skillId/levelIndex` 对得上的 session 响应 | 自动重试，重试后基本都成功。不处理 |
| `普通题停滞 nomatch translate/match/...` | 页面选项集合和下发答案对不上 | 弃关重开。单关偶发，可接受 |
| `page.evaluate: TimeoutError: signal timed out` | 回读进度的请求 15 秒超时 | 课程实际已完成，XP 也到账，只是没确认。事后用节点 state 核实即可 |
| `目标节点没有有效的传奇入口` | 该关已经不是"passed 未传奇"（多半上一条超时前已结算） | 本次运行内加入 `skipped`，不再重试（11-16 法语实测原来会反复撞 6 次） |
| `BLOCKED 关键请求 HTTP 429/403` | 平台限流或限制 | 立即停，别重试、别换 IP |
| 普通课 `select` 题 nomatch | 选项是 `{phrase}` 对象，旧 `tx()` 只认 text/value/word | 已修（`tx` 支持 phrase） |
| radio 延后后 API 仍 `locked` | 平台先给网页放行入口、后更新接口 | 按网页入口进课，结算看 radio 的 state 变 `passed` |
| radio 后停在非题目页（如 `CONVERSATIONS AVEC ZARI`） | 页面只有 token，没有 `challenge challenge-` 容器 | 已加无题页识别 + 60 秒无进展超时，按单关失败跳过，打印页面状态 |
| 点下一节点没反应 | 节点气泡挡住了坐标点击 | 改用 `locator.click()`；只有「稍后选择」成功后才继续找下一节点 |
| `RADIO_UNSUPPORTED ...` / `RADIO_SKIP_CLICK_FAILED` / `RADIO_SKIP_NO_CHANGE` | radio 没有入口、点击失败、或点击后页面没变 | 本次运行标记待处理，不重试；三种情况分开记录 |
| 普通模式会话类型对不上 | 练习课是 `LEXEME_PRACTICE` / `UNIT_PRACTICE`，没有 skillId | normal 模式非 skill/story 节点放宽到这两种 |
| 普通课 `match` 题 nomatch | 同一 unit 重复出同词表、选项集完全相同但 pairs 顺序不同 | 已修（`planSig` 按无序 pairs 比较 + practice-lexemes 兜底） |
| 普通课"新单词"题 nomatch | session 里两道题选项集相同、正确答案不同 | 按题干消歧；仍失败点 `player-skip`（跳过会被平台重练，所以只在确实认不出时用） |

### nomatch 的已知根因

**已确证：日语课的注音污染。** 日语课程给假名加注音（ruby），页面上一个词块的 `textContent` 会拼成「假名+罗马音」混排，例如：

```
页面 token: "でdeすsu" → core.norm() → "でdesu"
下发 token: "です"      → core.norm() → "です"
```

多重集比对失败，严格匹配和子集兜底都过不了，就 `nomatch`。**英语课没有注音，吃不到这个坑**——所以换到日语/中文/韩语这类带注音的课程时，这个失败会明显变多，甚至第一题就挂。

**未确证：英语课的偶发 nomatch。** 11-13 出现 3 关（translate「用英语写出这句话」、match「选择配对」），11-16 跑 75 关一次都没有。日志当时没记 `kind`，无法定论。已加 `NOMATCH_DETAIL` 诊断，下次触发会打出完整现场。

**代码层面的已知缺口**（`lesson-runner.js` vs `hint.js`）：半自动的 `hint.js` 有两条自动模式没有的兜底——
- 配对题失配时用拦截到的 `practice-lexemes` 词表重建题对
- 输入题失败时把候选全 dump 出来

所以同一道题在 hint 模式能过、在 auto 模式会 nomatch 弃关。

---

## 六、换语言课程特别注意

1. **一定要先切课程**，切完用第一节的命令确认 `currentCourse.id`。
2. 每门语言是独立课程、独立进度。刷别的语言会从**该课程最靠前的未传奇节点**开始，不会串。
3. 带注音/罗马音显示的语言（日语已确证）会出现大量 `nomatch`，预期失败率明显高于英语。如果实际跑下来失败率离谱，先看 `NOMATCH_DETAIL` 里 `options` 是不是带注音混排。
4. 小语种的传奇课可能题量、XP 规则不同，别拿英语的 40 XP/关去对账。

---

## 七、风险点（必须写进任何汇报里）

1. **违反多邻国服务条款**，官方公开说明会监测异常 XP 获取，发现后将用户移出排行榜。封号、清进度是真实可能。
2. 实测节奏 2.4–2.7 分钟/关、1880–3200 XP/小时、几乎全对。这个强度明显高于真人，检测面比半自动模式大。
3. **一次跑通不代表安全**。返回 200、XP 正常结算、节点变传奇，都不能证明后续不会被限制。不要声称“真人速度就安全”“每天少于多少不会触发”。
4. 连续多天刷尤其要注意累积风险。
5. 只做显示/点击，不做指纹伪装、代理轮换、验证码绕过——这些既不该加，也没有证据能降低风险。

---

## 八、代码改动记录

| 文件 | 改动 | 原因 |
|---|---|---|
| `auto-runner.js` | 启动时优先用系统 Chrome（`executablePath`，`fs.existsSync` 探测） | 自带 Chrome for Testing 156 有头启动 SIGTRAP |
| `auto-runner.js` | 新增 `NOMATCH_DETAIL` 诊断（每题第一次认不出时输出现场） | 定位 nomatch 原因，之前日志只有题干前缀 |
| `auto-runner.js` | 停滞错误信息里带上 `result.kind` | 同上 |
| `core.js` | `matchByPrompt` 命中多题干时取最长的 | 法语输入题"短题干是长题干子串"导致 nomatch（"您用卡付吗？" ⊂ "对不起，先生，您用卡付吗？"） |
| `auto-runner.js` | 传奇入口消失的节点本次运行内跳过，不再重试 | TimeoutError 后该节点已传奇，原来反复撞墙直到 8 次或时间到 |
| `read-xp.js` | 优先用系统 Chrome（`executablePath` 探测），加 `--no-proxy-server` | HOME 变了之后 Playwright 自带浏览器缓存找不到 |
| `automation-policy.js` | 新增 `planNormal`（挑 `state==='active'`，含 chest/radio；旧版过滤 TARGET_TYPES 会卡在 radio 上） | 普通课模式选关 |
| `auto-runner.js` | 普通模式：chest 点「打开」、duo_radio 走「稍后选择 → 同 unit 下一节点 `skill-path-state-active` 链接」；接受 `LEXEME_PRACTICE`/`UNIT_PRACTICE`；宝箱结算按 state 变化 | Codex 实测的延后 radio 分支（2026-11-18） |
| `auto-runner.js` | 新增 `--normal` / `--from-level`；普通课入口 `/lesson`、`LESSON` 会话按 skillId+levelIndex 匹配、结算看 XP；`nomatch` 时点 `player-skip` | 普通课模式 |
| `core.js` | `tx()` 支持 `{phrase}`；`planSig()` 配对题按无序 pairs 比较 | 普通课 `select` 题选项是对象；`match` 题同词表重复出题 |
| `lesson-runner.js` | 选项集相同时按题干消歧；接受 `lexemes` 参数，配对题失配用 practice-lexemes 重建 | 普通课"新单词"题；补齐 hint 模式的两条兜底 |
| `auto-runner.js` / `lesson-guard.js` | 无题页面识别 + 无进展超时；去掉周期性 `LESSON_IDLE`，同一屏只记一次，超时抛错并带页面状态 | 法语 radio 后停在只有 token 的页面会无限刷日志（2026-11-18 `auto-normal-run3`） |
| `auto-runner.js` | radio 成功日志推迟到确认推进之后：后续节点打开 + 点「开始」+ 挑战容器出现才记唯一一条 `RADIO_ADVANCED`（带 `next` 和证据）；弹窗收起/无进度、点击失败、误导航、无入口全部按待处理抛错 | 用户验收发现「先记成功、后找下一关」会把未推进误记成跳过（2026-11-18 补正） |
| `auto-runner.js` | 故事封面不再等 `target.data` 才点（先点「开始读故事」触发 stories API，破死锁）；答完后按已知 `data-test`/「结束课程」找结束控件，点后必须看到页面变化，回 `/learn` 才继续结算；不明确/点不动时保留窗口 | 故事入口连续 6 次等不到数据（2026-11-18 真机）；结束后空转 2 分 42 秒 |
| `lesson-dom.js` | 抽出 `hint.js` / `lesson-runner.js` 共用的 `readDom` / `clickMarks` / `fillInput` | 两份复制实现容易漂移 |
| `archive/` | `batch-test.js`、`probe-*`、旧 `prepareLegendary` 移入存档 | 旧调试脚本已无人调用 |
| `auto-summary.js` | 结束行改读 `STOP`（兼容旧 `END`），并打印 `xpGain` | 日志早已改成 `STOP`，摘要读不到结束行 |

`npm test` 全部通过，当前 140 项（core 50 / stories 7 / policy 14 / lesson-runner 6 / lesson-guard 10 / story-done 5 / progress-touch 4 / story-done-main 1 / story-flow 4 / node-entry 8 / story-sig 2 / story-finish 4 / radio-skip 12 / radio-tap 3 / radio-quiz 10）。测试不覆盖浏览器启动参数、真实页面 DOM 和诊断输出。

---

## 九、还没解决 / 要留意

- 英语课偶发 nomatch 仍未确证，等 `NOMATCH_DETAIL` 再触发
- 普通课 `--normal` 的单节成功以 XP 到账为准；一个 skill 节点通常 4 节才 passed，节点变 passed 后下一个节点会自动变 active
- 普通课进课时经常要先等几秒才下发匹配的 `LESSON` session（预加载里有别的 skill），偶发"未收到与目标节点匹配的课程数据"，重试即过
- `course-path.json` 是 11-04 的快照，`--dry-run` 的队列只能粗看；真实队列来自服务器实时进度
- `read-xp.js` 里写死了未加密的 user id `769346152`，换账号要改
- 运行环境变动过两次（Chrome 被卸载、活动课程被切到日语），每次开跑前的三步检查就是为这个

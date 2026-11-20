# 平台事实（法语 DUOLINGO_FR_ZH-CN，2026-11-19 更新）

## 1. `/learn` 的渲染范围（更正旧结论）

- **旧结论（作废）**：「`/learn` 不渲染老段」，依据 `auto-legendary-u30c.log` 的 `screens=120 rendered=[72,127,128]`。
- **更正**：那是 **900px 大步长 + 400ms 检查太快** 造成的误判，虚拟列表还没渲染就取样了。
  - 实测 300px 步长 / 200ms 等待，从顶部滚 400 步，unit **69→128 连续渲染**（证据 `learn-scroll-probe.json`，`SEEN_ALL` 69..128）。
- **真正的限制**：`/learn` 只加载**当前段**（当前是 section 3，渲染从 unit 69 起）。老段（unit ≤ 68）不在这个 DOM 里，往上滚也到不了。

## 2. 老段的平台入口（已用）

- 路径：`/sections` → 第 N 阶段「复习」→ `/learn` 渲染该阶段路径。
  - 实测点「第 2 阶段 复习」后渲染 unit 28–31；点 unit 31 的 skill 节点，气泡里真实出现 `legendary-node-button`「晋升传奇 +40 经验」（证据 `old-section-entry.json`）。
- 属性：这是**页面按钮**，不是构造 URL；但视图是客户端瞬时状态，刷新/重新 `goto /learn` 就回当前段，每次都要重新点。
- 实现：`legendary-entry.js` 的 `openOldSectionPath`（轮询「复习」按钮 15 秒、兜底最多 4 个 tab、进不去抛 `SECTION_UNREACHABLE` 记 unknown），`isOldSegment` 只在「目标 unit 比当前渲染段更早」时走这条。
- 成果：`auto-legendary-u30f.log`，unit 30/31/32 共 10 关 legendary（各 +40）。

## 3. 直达路由（只作对照，未用于批量）

- `/lesson/unit/<unitIndex+1>/level/<crownLevelIndex+1>` 与 `.../legendary/...`：HTTP 200、无错误页；legendary 的 session 是 `LEGENDARY_LEVEL`，`skillId`/`levelIndex` 与目标节点完全对上（证据 `direct-route-probe.json`，`skillId=b304dd10… levelIndex=0`）。
- 结论：路由映射正确、平台接受；但页面上没有链接来源，按约定**不作为入口证明**，老段仍走第 2 节的阶段入口。

## 4. s3u72 的 l11（已解决，2026-11-20）

- 现象：节点定位成功（`skill-path-level-11 skill-path-level-duo_radio`），点击后气泡只有「跳级到这儿？」，**路径气泡里没有可绑定的电台入口**（证据 `l11-probe.json`）。
- **正常课堂路由确实存在**：`/lesson/unit/73/level/<levelIndex+1>`（即 unit 72+1、level 11+1）→ session `elements=13`，元素 `["audio","challenge"]`，页面文案 `VOS IDÉES AVEC BÉA` 与 `duoRadioSummary.episode_wrapper=ideasWithBea` 一致，身份匹配（证据 `l11-route-check.json`、`l11-run2.json`）。注意：路由映射正确，但按约定只用于「已验证节点的一次性完成」，不作为常规入口证明。
- **真正的卡点不是入口，是时序**：进课后约 30 秒都是开场屏，配对题（「选择配对」+ `challenge-tap-token`）才出现，且出现时机不稳定。修复见第 8 节。
- 完成后：`state=passed 1/1`，+30 XP；链路完成时被连带成 legendary；随后 `144216ca` unit_review 由 `locked` 变 `active`，普通流程 `SETTLED legendary +40`；unit 72 13/13 全金，unit 73 首节点 `99e8dc98` 由 locked 变 active。

## 5. 平台连带（链路授予）

- 现象：一个 unit 里可入口的节点陆续完成后，没有独立入口的 radio / 1 节 review / unit_review 会被平台**连带授予** legendary（精确触发条件未定，见第 6 节 TODO）。
- 特征：连带节点 `finishedSessions/totalSessions` 不涨（radio 常是 1/1，unit_test 是 0/1），**不产生 XP、不产生独立结算**。
- 实测：
  - `ac0ae2f8`（unit 34 unit_review，0/1）在 unit 34 链完成后变 legendary。
  - u35 批（`auto-legendary-u35a.log`）：独立结算 10 关（+400 XP），同批连带 15 个节点变金（unit 35 七个、unit 36 八个，含两个 unit_test 0/1），XP 只按 10 关计入。
- 记录口径：连带**单独列**，不混进独立结算数；判定方式 = 每批前后各回读一次老段整链 state，`state` 由非 legendary 变 legendary 且不在本批结算 id 里的，就是平台连带。
- 副作用：新变金的链头会把链内其它节点计入 pending，所以 pending 不是单调下降（u35 批 50→59）。

## 6. 连带条件（实测归纳，机制未定）

**观察到的判据（页面事实）**：unit 39 的路径 DOM 只渲染 9 个节点——level 0/1/3/4/5/6/7/9/10（skill、radio、3 节 practice、unit_review），**level 2、8 缺失**；而 API 里这两个正是 1/1 的 review 节点。也就是说：

- **1 节 review 节点（`learningUnitType` 存在、`finishedSessions/totalSessions = 1/1`）不渲染成路径节点**，点不到、也就没有 `legendary-node-button`，只能由平台连带变金。
- **3 节的 practice 是真实渲染的节点**，气泡里有「晋升传奇 +40 经验」，得自己打（每关 +40）。
- radio / unit_test / 1 节 review：老段实测**全部是连带**，`fin` 不变、无 XP。

**为什么 s3u72 l6 要自己打**：它是 `Course Practice 70`，`fin=3/3`，属于上面第二类（真实 practice 节点）；而 u35 批里的 `05be99dd`、u36 的 `a971dec5` 是 `1/1` 的 review 节点，属于第一类，所以只被连带。

**样本对照（section 0–2，快照 `u35-before/after.json`、`u37-before/after.json`）**：所有 1/1 的 practice/review 都是连带（无例外）；所有我们实际打过的 3/3 practice 都走独立结算 +40（含两次 `NODE_FAIL` 但服务器侧已结算的补记）。

**补充（2026-11-20，section 3）**：故事节点（`pathLevelMetadata.storyId`，`finishedSessions/totalSessions = 1/1`，快照里 type=other）**可以独立走传说课并结算 +40**，实测 `1d0616f9`、`9d910a8f`、`7b24736b`（unit 69/70 故事，各 +40，`answered≈5`）。所以第 6 节「1/1 只能连带」只适用于 **review / practice**，故事要单列——这也是 section 3 候选面比老段大的原因。

**类型口径提醒（2026-11-20）**：宝箱节点 `type=chest` 的元数据里也有 `anchorSkillId/indexSinceAnchorSkill`，只按元数据判断会被误标成 practice/review（unit 72 的 `4841b436`、`dfdc272c` 就是 chest，不是 practice）。节点类型应直接读 API 的 `level.type`；chest 与 duo_radio 一样没有独立传说入口，只能连带。

**TODO**
- 连带触发时点没定：unit 34 的 unit_review `ac0ae2f8` 在 skill l0（`85bafd28`）还没金时就变金了，说明不是「整链所有可入口节点都金」才触发；可能与 anchor lesson 或平台后台任务有关，证据不足不下结论。
- 「1 节 review 一定不渲染」目前只有 unit 39 两个样本 + 全老段 1/1 全是连带这两条间接证据，未逐单元验证。
- units 0–21 的 3/3 practice 也是连带（账号早期进度），无法区分是用户自己打过的还是被连带，未纳入判据。

## 7. 传说单关经验：曾出现每关 +80（2026-11-20，可能有时效）

- **2026-11-20 01:43 批（`auto-legendary-s2u49a.log`，unit 49/50）**：8 关 legendary 每关 **+80**（日志 `delta=80`，总 `xpGain=640`）；此前所有批次都是每关 +40。
- 证据只有两条：日志 `delta` 与 XP 对账（125413→126053，`read-xp` 独立读 126053 一致）。
- **机制未核实**：疑似 2 倍经验加成（Double XP）生效，也可能与活动/时间有关，**不当永久规则**。
- **后续观测（2026-11-20 01:54，`auto-legendary-s2u51a.log`，unit 51/52）**：本批首关仍 `delta=80`（126053→126133），其后回到 `delta=40`，整批 `xpGain=360`（1×80 + 7×40）。说明那个加成是**有期限的**，且可能在批中结束。
- 后续若再变化，继续在这里补一行观测时间点与批号。

## 8. 电台课（duo_radio）的时序（2026-11-20 实测，l11 修复）

- **页面序列**：进入电台课后，先是约 **30 秒开场屏**（显示 `VOS IDÉES AVEC BÉA` 之类标题），之后才出现「选择配对」屏（正文「选择配对」+ 8 个 `challenge-tap-token`），配对完成后再进入判断题/选择题。
- **配对屏出现时机不稳定**：同一路由实测 t≈30s 出现，但不是固定时长；曾出现等 45 秒仍未命中而被误判为「无题」。
- **正确做法（已实现）**：`radio-tap.js` 的 `waitForRadioStart` 每 500ms 轮询真实信号——`challenge-tap-token` 数量 ≥2 **或** 正文出现「选择配对」——命中才进 `radioTap`；开场屏元素消失只作**辅助记录信号**（不触发点击）。总上限 **90 秒**，超时返回 `intro-timeout` 并保留现场（已等待秒数、tap-token 数量、屏幕文本片段），记 `RADIO_INTRO_TIMEOUT`；等待期间**不点击任何东西**，避免打断开场动画。
- **旧做法（作废）**：不用「按正文文案等固定 35 秒」当主判据；`radio-quiz.js` 无卡片时的 30 秒固定等待同样改为同一套 90 秒真实信号等待，超时报 `RADIO_INTRO_TIMEOUT waitedMs=… cards=0`，不再误报 `RADIO_QUIZ_NO_QUESTION`。
- **回归**：`test-radio-tap.js` / `test-radio-quiz.js` 覆盖「开场后出现配对必须等到再走」「一直不出现记 `RADIO_INTRO_TIMEOUT` 不误报 `NO_QUESTION`」「配对立即出现立刻进流程」三种时序；`npm test` 179 项全绿。
- **入口形态**：section 3 的 radio 节点（`level.type=duo_radio`）在路径气泡里同样只有「跳级到这儿？→ /test」，**正常入口在 `duo_radio` 的课堂路由**（unit+1 / level+1 映射）；进课后续按上面的时序等待即可，不需要跳级测试。
- 待观察：其它段/其它 unit 的电台开场时长是否一致（目前只有 l11 一个完整样本：约 30 秒出场、配对 4 组 + 4 题、`RADIO_QUIZ_DONE answered=4`）。

## 9. 普通线（`--normal`）在 section 3 的形态（2026-11-20 unit 73 实测）

- **前提**：unit 73 起是全新链（`locked`），`planNormal` 只取 `state=active` 的节点逐节推进；节点做到 `passed` 后，传说批才有候选。所以 section 3 后半段是「普通线 × N 批 → 单元 passed → 传说批刷金」两段式。
- **skill 课**：每节点 6 节（`finishedSessions/totalSessions` 0/6→6/6），每节 +15 XP，最后一节 +20；`state=active` 到 6/6 才变 `passed`。
- **普通故事课（1/1）**：+20 XP，完成后 `passed`。封面有两种 UI：
  - 旧：`[data-test="story-start"]`「开始读故事」；
  - 新（unit 73 l1 实测）：`/lesson` 路由里的 `stories-element` 封面 + `[data-test="stories-player-continue"]`「继续」；**不点「继续」就不会请求** `stories.duolingo.com/api2/stories/<storyId>`（URL 最后一段 = `pathLevelMetadata.storyId`，200 返回带 `elements`）。
  - 旧代码只认 `story-start`，新 UI 下等于「等数据→不点→没数据」死锁（45 秒 `NODE_FAIL`）。修复：`automation-policy.js` 的 `storyCoverAction`（旧 start 优先于「数据已到」；新 UI 仅在未拿到数据时点一次「继续」），`auto-runner.js` 故事分支改用。
- **普通 radio**：不单独做，普通线跑前一节点时会 `RADIO_ADVANCED` 自动切到后继节点（unit 73 l2 就是这样从 radio 切到 l3 skill 的）。
- **进课首次 `NODE_FAIL` 是常见时序现象**：每节普通课第一次进课常报「未收到与目标节点匹配的课程数据」（等 90 秒），`ENTRY` 重试一次即成功（`SESSION_CACHED`）。不是缺入口，但会浪费每节 ~90 秒；后续可考虑「进课后页面已是题目页但无 session 时快速重进」的优化。
- 实测数字（unit 73 前四节点）：l0 skill 6/6 passed、l1 故事 1/1 passed、l2 radio passed（自动）、l3 skill 2/6；XP 129443→129618。

## 10. 普通练习引导屏与 section 3 其它时序（2026-11-20 unit 73 完整实测）

- **普通练习（practice）/单元复习的引导屏**：点路径节点后进 `/lesson` 先出现 `[data-test="session-splash-title"]`（「来巩固一下你最薄弱的语法知识点吧！」）+ `[data-test="player-next"]`「开始练习」，**session 在点这个按钮后才请求**；不点就永远等不到数据（unit 73 l6/l10 实测连续 `NODE_FAIL`）。修复：`automation-policy.js` 的 `shouldClickSplash`（normal、无 session、未点过、有 splash+player-next 才点），`auto-runner.js` 在超时检查前点一次。
- **进课首帧 session 晚到**：练习课进课后 session 实测 90 秒后才到（`SESSION_SEEN` 出现在 `NODE_FAIL` 之后），题目页等待窗口已从 90 秒加到 **150 秒**；`waitForURL` 从「pathname 全等」改成「`/lesson` 前缀」，避免尾斜杠导致 25 秒误判超时。
- **session 缓存复用**：只对 `skill`/`practice`/`unit_review` 生效。radio/story 的 `pathLevelMetadata` 没有 `skillId`，缓存 key 会落到 `'|'`，误取练习 session 会占住 `active.data`，让真正的 radio `elements` session 不再赋值（l11 判断题 `RADIO_CHOICE_UNMATCHED` 的根因就是它）。
- **radio 题间音频**：配对后判断题/选择题之间会插一段音频/过渡（页面只剩标题、`challenge-choice` 清空），实测有 **35 秒以上**才出下一题的；`radio-quiz.js` 的 `waitAdvance` 上限从 50×700ms（35s）放到 120×700ms（84s）。l11 完整流程：配对 4 组 + 4 题 → `RADIO_QUIZ_DONE answered=4`（+30）。
- **听音选词题型（2026-11-20 s3u73n 结论，已修复）**：3 选 1 提交后其实**已成功跳到第 4 题**「选择你听到的 3 个单词」（5 个 `challenge-tap-token` 单词块），旧 `READ_SRC` 只读 `challenge-choice`，把这一屏读成 `cards=0`，`waitAdvance` 等 35 秒后误判 `RADIO_SUBMIT_NO_ADVANCE`。修复：`READ_SRC` 把 `[data-test*="challenge-tap-token"]` 也当卡片读（innerText 就是单词，能和 session `choices` 对上），`waitAdvance` 的文本签名自动生效；配对阶段由 `radio-tap` 单独处理，不冲突。回归：「卡片清零后出现 tap-token 新题型 → next 而不是 timeout」。
- **传说故事结束按钮**：故事题全部答完后，`stories-player-done` 在最后一段音频播完前是 disabled；`finishStory` 的禁用等待从 15 秒放到 **60 秒**（unit 73 l1 传说故事因此结算 +40）。
- **unit 73 完整结果**：13/13 全 legendary（普通线 13/13 passed → 传说 7 关独立 +40/关 → 6 个 radio/chest/unit_review 连带）；XP 129443→130273；链口径 headsGold/chainsGold 73→74、courseNotGold 6700→6687；section 3 已金 53→66/792；unit 74 首节点 `7a6eae35` 解锁为 active。




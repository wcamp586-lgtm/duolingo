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

## 4. s3u72 的 l11 缺口

- 节点定位成功（`skill-path-level-11 skill-path-level-duo_radio`），点击后气泡只有「跳级到这儿？」，**没有可绑定的电台入口**（证据 `l11-probe.json`）。
- 记为「平台此刻不给该 radio 可绑入口」，保持缺口，不再重试。

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




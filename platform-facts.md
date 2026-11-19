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

# 两仓联调踩过的坑（账本）

这份文件记**插件与本体联调过程中发现过、确认过的问题**，只增不删。
目的只有一个：同一处坑不要踩第二遍，也不要因为「测试是绿的」就把这些约束改回去。

- 前缀约定：`am:` 指本体仓库（与插件仓库并列的 checkout）内的路径，不带前缀的是本仓库路径。
- 每条都写了「怎么锁住的」——即哪条断言会在改坏时变红。断言都在 `tools/integration.mjs`。
- 复跑：在本仓库根跑 `node tools/integration.mjs`（要两份 checkout 并排）。
  共 32 条，约 2 分钟，含跨整分钟的等待；`LIVE` 那条没有真令牌时恒 SKIP。

## F-1 裸 `agent-man` 屏上永远看不到插件行（严重，已修）

本体 → 零件 → 本体 → sense → 零件 成环，整条被 5000ms 超时截断：
`agent-man context show` 有插件 **5696ms**、无插件 **163ms**；单跑插件无参一度 **6511ms**。

- 根因：插件取数要调本体，本体被调时又去问零件，而零件本身就是再调一遍本体。
- 修：本体给子进程盖哨兵 `AGENT_MAN_PART_CALL=1`（`am:src/core/config.mjs:29` 定义常量、
  `am:src/parts/call.mjs:177` 写进 childEnv），`am:src/cli/registry.mjs:795-804` 见到哨兵就不再问零件，
  走 `parts.sense(..., {parts: []})` 同一条空转路。
- 锁：`E-NEST-R`（`context show` 1512ms、输出无嵌套 yuQue 行）、`E2-R`（1231ms）。

## F-2 `AGENT_MAN_PARTS_INJECT=0` 是死配置（中，已修）

有键、无消费点，怎么设都关不掉零件注入（修前设 0 仍 5558ms）。

- 修：`parts.inject=false` 真正生效，并在 stderr 说明一句
  `! 零件注入已关（parts.inject=false）：这次不问零件`。
- 锁：`E-F2-R`（164ms、stderr 含这句开关说明）。

## F-3 插件有一次取数没带 `--json`（中，已修）

四次取数里三次带 `--json`，`context show` 那条没带——面板文本里带着时间戳，于是踩到 F-4。

- 修：`src/sync.mjs:93`。
- 锁：`C2`（四次调用参数逐个断言，全带 `--json`）。

## F-4 处境篇每跨一分钟就被判「内容变了」（中，已修）

幂等只在一分钟内成立：`D2` 之所以绿，是因为两次 sync 落在同一分钟里。

- 根因：处境篇的幂等哈希取的是 `context show` 的**原文**，而原文首行是分钟级时间戳
  `agent-man · 2026-11-20 00:31`；跨分钟必变 → 每次 sync 都重写处境篇。
- 修：`src/render.mjs:232-249` 改成 `renderSituation({ scene, stamp, home, version })`，
  正文走 `situationCore(one)` 从 `context show --json` 的 scene 重排，时间戳只留在页脚
  `> 同步于 ${stamp}`（`:244`）。
- 锁：`D3-R`（真等到下个整分钟再 dry-run，须报「没变，跳过」，零写请求）。

## F-5 插件 `.gitignore` 没覆盖自己的 state（轻，已修）

`AGENT_MAN_YUQUE_HOME` 默认落在 `~/.agent-man-yuque`（`src/config.mjs:86`），
`state.json` 里含 doc url / slug / hash；一旦有人把它指进仓库就会被提交。

- 锁：`F2`（`.gitignore` 覆盖 `state.json` 与自己的 state 目录）。

## F-6 未知 `AGENT_MAN_*` 会在 stderr 刷警告（轻，本体侧，已修）

污染联调输出，看输出判成败时容易误判。

- 修：`am:src/core/config.mjs:453` 的 known 集合纳入 `PART_CALL_ENV`（`PART_HINT_ENVS`）。
- 锁：各条断言对 stderr 的逐字匹配。

## F-7 本体自递归与死配置（第二轮回归实证已修）

即 F-1 + F-2，2026-11-20 01:38 全量回归复跑确认：`E2-R` / `E-F2-R` / `E-NEST-R` 三项全绿。

## F-8 跨分钟幂等（第二轮回归实证已修）

即 F-4，`D3-R` 通过。

## F-9 退出码只有 69，没有 75（第二轮回归实证已修）

本体超时、本体起不来、本体 `exit≠0` 三种情况全报 69，与「找不到」共用一个码。

- 期望：超时 → **75**（本体 `am:src/parts/call.mjs` 的 `classify` 里 75 就是 timeout）；
  找不到 / 本体自己说不行 → **69**。
- 修：`src/sync.mjs` 里 `code === 'ETIMEDOUT' || res.error.killed === true` → `fail(75, …)`。
- 锁：`D9-R`（假本体三种：睡 21s 的 → 75；空 PATH → 69；`failbody` → 69 且 stderr 带原文）。

## F-10 目录树曾是全量替换，不是 `appendNode`（第二轮回归实证已修）

`PUT /repos/{ns}/{repo}` + body `{toc}` 是整树替换：每次 sync 都把整棵树重写一遍，
已挂好的文档也跟着重发 toc，有毁内部 TOC 的风险。

- 修：改发 `PUT /repos/{ns}/toc` + `{action:'appendNode', type:'DOC', doc_ids:[…]}`。
- 锁：`D7-R`（首轮 sync 的 toc 请求体是
  `{"action":"appendNode","action_mode":"sibling","type":"DOC","doc_ids":[0]}`，无全量替换）、
  `D8-R`（已挂好 slug 时 toc 请求 0 个）。

## F-11 `.gitignore` 缺 state 目录（第二轮回归实证已修）

即 F-5，`F2` 通过。

## F-12 D3 的期望与设计冲突（断言侧，已拍板处理）

原来 `D3` 期望「加一条记忆后处境篇零请求」——在当前设计下不可能成立：
处境篇渲「最弱的三条」（`src/render.mjs:240`），那条取自记忆；加一条记忆必然换掉最弱那条，
**处境篇内容确实变了**，重推是对的（`src/render.mjs:97-98` 的作者注已声明过这个取捨：
weakest 按 retention 排序选，时间推移可能换人 → 会触发一次重推，那不是抖动）。

- 处置（2026-11-20 20:00 拍板）：`D3` 期望改成「加记忆后 **situation + memory 两篇都更新**」，
  另补两条守门人——`D3-B`（不动数据再 sync → 零请求，钉幂等）、
  `D3-C`（加记忆后 `--dry-run` 只报这两篇，钉增量）。
- 明确否掉的两条路：①处境篇不再渲「最弱的条」；②测试改用便条（便条同样渲进处境篇，只是换个名字）。

## F-13 测试里有一个「不像假的」假令牌（轻，已修）

`test/sync.test.mjs:336` 写的是 `token: 'other-token'`，不含 `test` / `fake` / `mock`，
按本仓库「凭据必须一眼可辨是假的」的约定算命中，会让隐私扫描多一条要人判的告警。

- 修：改 `mock-token-other`，并在测试里就近写明这条约定（`test/sync.test.mjs:338`）。
- 锁：`F1`（可辨 mock 的凭据一共只许那 3 处：`test/config.test.mjs:14`、`test/helpers.mjs:9`、
  `test/sync.test.mjs:338`）。

## F-14 C2 的假本体转发真本体时把「调了几次」量错（harness 自身的坑，已修）

假本体把收到的调用原样转发给真本体，好让插件拿到真 JSON；结果真本体又把插件叫了一遍，
记录器收到 **8** 条而不是 4 条。

- 修：harness 的假本体在转发时也带零件哨兵（`AGENT_MAN_PART_CALL=1`），真本体不再回头问零件。

## F-15 D9-R「本体找不到」分支被外层环境透传污染（harness 自身的坑，已修）

外层 `AGENT_MAN_REPO` 透进该分支后，「本体找不到」这条跑不到空 PATH 上去。

- 修：该分支显式清掉透传的 `AGENT_MAN_REPO` / `AGENT_MAN_BIN`。
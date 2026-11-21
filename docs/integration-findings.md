# 两仓联调踩过的坑（账本）

这份文件记**插件与本体联调过程中发现过、确认过的问题**，只增不删。
目的只有一个：同一处坑不要踩第二遍，也不要因为「测试是绿的」就把这些约束改回去。

- 前缀约定：`am:` 指本体仓库（与插件仓库并列的 checkout）内的路径，不带前缀的是本仓库路径。
- 每条都写了「怎么锁住的」——即哪条断言会在改坏时变红。断言都在 `tools/integration.mjs`。
- 复跑：在本仓库根跑 `node tools/integration.mjs`（要两份 checkout 并排）。
  共 33 条，约 2 分钟，含跨整分钟的等待；`LIVE` 那条没有真令牌时恒 SKIP。

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

## F-16 联调临时目录曾建在系统临时目录（轻，已修，交付物侧）

入库版 `tools/integration.mjs` 用 `fs.mkdtempSync(path.join(os.tmpdir(), 'agent-man-yuque-int-'))`，
落在 `%TEMP%` 下。异常退出（Ctrl-C、被信号打断且 exit 钩子没跑）会在系统临时目录里留一坨假家目录
与假零件；工作区约定也明确「临时文件一律写 `tmp/`，不用系统临时目录」。

- 修：改成建在**插件仓库自己的 `tmp/`** 下——`tmp/` 已被 `.gitignore` 覆盖（既不进系统临时目录，
  也不污染仓库可见树），名字再带 pid + 随机后缀，同机两份并发仍互不相干（同类教训见 F-14/F-15）。
  仓库内固定目录 `tmp/` 本身不算「写死」：跑不跑都不改 git 可见文件，`git status` 始终干净。
- **没跟着改的**：`test/*.test.mjs` 与本体 `test/*.test.mjs` 仍用 `mkdtemp(os.tmpdir())`。理由：那些
  是既有约定（两仓共 26 个用例文件），每个都在 `finally` 里必删、只活几秒；要改成仓库 `tmp/`
  得在每个文件里额外清理父目录，收益低于风险。长期交付物（这份 harness）才按工作区约定落仓库内。
- 复跑（`F4` 断言已把这两条锁住：`RUN` 必须在 `tmp/` 内、且不在系统临时目录；顺手报上轮残留数）：
  ```powershell
  Get-ChildItem $env:TEMP -Filter 'agent-man-yuque-int-*' -Force -Directory
  Get-ChildItem .\tmp -Filter 'int-*' -Force -Directory      # 跑完后应为空
  ```

## F-17 插件的数据目录变量撞上本体的配置键前缀（中，已修）

真机上把插件的数据目录按工作区约定指到 `data/agent-man-yuque` 时，只能用
`AGENT_MAN_YUQUE_HOME`——而这个前缀是本体的配置键命名空间。本体每次开屏都会多刷一行：

```
! 环境变量 AGENT_MAN_YUQUE_HOME 不对应任何配置键，已忽略（真实键见 agent-man config show --json）
```

（本体侧这条警告是**故意**留的护栏：`am:test/config.test.mjs:164` 有断言「认下入口提示没把整个
前缀放开：陌生的 `AGENT_MAN_` 变量照旧报」。所以不能靠放宽带前缀来解决，只能插件侧避让。）

- 修：`homeOf()` 改成三级回退——① 显式 `AGENT_MAN_YUQUE_HOME` ② **本体数据目录的同级**
  `agent-man-yuque/`（`AGENT_MAN_HOME=<…>/data/agent-man` → `<…>/data/agent-man-yuque`）
  ③ `~/.agent-man-yuque`。于是「数据放 `data/`」这条约定不必再靠设一个 `AGENT_MAN_*` 变量实现，
  警告随之消失，而 state 的落点与原来**逐字节相同**（真机上仍读得到「与本体一致（19h 前）」）。
- 断言：`test/config.test.mjs` 的「数据目录：显式变量优先；没给就落在本体数据目录旁边」；
  实测清掉该用户级变量后 `agent-man context show` 再无那行 `!`，`（yuQue）` 行照常在。

## F-18 这本账自己的 `文件:行号` 会漂（轻，只记录不追）

账里的指针是写下那一刻的快照。测试文件后来长大了，指针就飘。本轮文档巡检按「引用必须点得到」
复核了账内全部指针，三处已漂、落点如下（不改旧文，在此并存）：

- F-3 写的「修：`src/sync.mjs:93`」——`:93` 现在是 `jsonOf()` 的 `catch`；四处取数带 `--json`
  的真身在 `src/sync.mjs:128-131`（`collectSources` 里 `context show` / `memory ls` / `rule ls`
  / `self show`）。
- F-6 写的「`am:src/core/config.mjs:453` 的 known 集合」——`const known = new Set([DATA_HOME_ENV,
  PART_CALL_ENV, ...PART_HINT_ENVS])` 现在在 `src/core/config.mjs:458`。
- F-13 那句「可辨 mock 的凭据一共只许那 3 处」——F 组加了新假令牌后已变 5 处：
  `test/config.test.mjs:15`、`test/helpers.mjs:9`、`test/sync.test.mjs:338`、
  `tools/integration.mjs:44`、外加本文 `docs/integration-findings.md:107`（它引用了旧令牌名）。

为什么数量变了却不会红：`F1` 的名单是**运行期数出来的**，`tools/integration.mjs:1196` 打的是
「可辨 mock ${hits.length} 处：…」，数量本身不是断言，只有「出现不可辨的凭据」才是。

- 教训：账本里写死「只许 N 处」这类数字，等于给自己埋一个迟早过期的断言——要么交给程序数，
  要么只写「名单见 `F1` 报文的动态输出」。

## F-18 本账本自己的 `文件:行号` 会漂（轻，已修，记录用）

这本账里的指针是写下那一刻的快照。后续测试文件长大、源码挪块，指针就会指到别处——本次
文档巡检把全部指针复核了一遍，确认已漂 3 处，逐条给出当前正确落点：

- `F-3` 写的 `src/sync.mjs:93`：现在 `:93` 是 `jsonOf()` 的 `catch` 分支，四份 `--json`
  取数实际在 `src/sync.mjs:128-131`（`collectSources()` 里那四行）。
- `F-6` 写的 `am:src/core/config.mjs:453`：`const known = new Set([…])` 现在是
  `am:src/core/config.mjs:458`。
- `F-13` 写的「可辨 mock 的凭据一共只许那 3 处」：后来又添了 `tools/integration.mjs:44`
  的 `test-token-not-real`，实际已是 5 处。

- 修：指针不逐个追（追完还会漂），改为把「漂过」与正确落点记在这里。真正的防线是 `F1`
  的名单由**运行期算出**（`tools/integration.mjs:1196` 打「可辨 mock N 处」），所以数量
  变了不会让断言变红，只会让报文里的数字变。
- 教训：账本里别写「只许 N 处」这种硬数字，它一定会过期。要么交给程序去数，要么写
  「名单见 `F1` 报文的动态输出」。

## F-19 四份取数串着问，正撞在注入那边的期限上（中，已修）

注入那条路上本体只等 `parts.deadline`（默认 1200ms，`am:src/core/const.mjs` 的 `PART_DEADLINE`）。
插件的无参要问本体四件事（处境 / 记忆 / 规矩 / 自我），原来是一个接一个 `spawnSync` 问的：四份
各 200–300ms，光进程启动就 0.9s，加上插件自身启动与渲染，无参一次 1.3–1.6s——正好越过 1200ms。
实测（本体 `parts.sense(env,{deadline:1200})` 连跑 5 次）**5 次全被丢掉**，
`dropped=[{name:'yuQue',reason:'deadline'}]`，真机首步注入里「建议」那段经常整块消失；
会话开头漏进去的那一次（压在 1.2s 内）纯属运气。

- 修：`collectSources()` 改并行——`runAgentMan` 从 `spawnSync` 换成 `spawn` + Promise，四份
  用 `Promise.allSettled` 一起问；一条坏了用 `AbortController` 把兄弟撤掉，抛的是先坏的那条
  （被取消的 75 不许冒充原因）。`buildDocs` / `senseLine` / `statusView` / `syncRun` 随之 await，
  契约、退出码与三种错误文案一字未改。
- 实测（同一台机器，2026-11-21 21:45）：四份取数串行 941ms → 并行 359ms；插件无参 1.5s 上下
  → **0.57–0.68s**；`deadline:1200` 连跑 5 次全部答上来（814–961ms，`dropped` 空）；CLI 带零件
  `context show` 1.78–1.96s → 1.03–1.13s。联调 harness `E2-R` 顺带记一笔：1105ms（修前 5696ms）。
- 断言：`test/sync.test.mjs` 的「四份取数一起问：不比串行更慢」「本体坏了就撤掉兄弟：抛先坏的
  那条，不陪着别的慢慢等」；顺带把两条按顺序断言的旧用例改成「认这四件事、不认顺序」——并行后
  谁先谁后本来就不该被钉。
- 教训：`parts.deadline` 是**总**期限、不分摊，插件里任何一次多余等待都直接从「建议」那一段的
  预算里扣。互不依赖的取数一律并行，别让期限替判断力兜底。

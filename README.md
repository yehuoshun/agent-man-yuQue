# agent-man-yuQue

把 [agent-man](https://github.com/yehuoshun/agent-man) 的「处境」与「记忆」**反向同步**成语雀文档。

一次单向推送：**agent-man → 语雀**。插件只读本体的 CLI 输出，不 `event add`、不写记忆、
不在语雀那边留任何回写钩子——语雀只是给人一种顺手翻阅的介质，真源始终在本地数据目录。

安装后本体里就有 `agent-man yuQue …`（本体扫 PATH 找 `agent-man-` 前缀的可执行文件，
名字大小写按原样保留，所以这里叫 `yuQue`）。

## 装

不发布 npm（`"private": true`）。两种装法：

```powershell
npm link            # 把 bin/agent-man-yuQue.mjs 链到全局，本体直接能发现
```

或者干脆把 `bin/` 放进 PATH（Windows 上要让 `agent-man-yuQue.cmd` 这类可执行文件可被发现，
本体在 Windows 只认 `.exe` / `.cmd` / `.bat`）。添完 PATH 用 `agent-man context sense` 验一眼：
建议段里出现 `yuQue` 那行，就说明本体已经扫到零件了（本体扫 PATH 上 `agent-man-` 前缀的名字）。
仓库里带着 `bin/agent-man-yuQue.cmd` 就是为了这件事——没有垫片，Windows 上装完发现不了。

要求：Node ≥ 20，零依赖。

## 三种模式

### 1. `--describe`：给本体发现用

```console
$ agent-man-yuQue --describe
{"name":"yuQue","desc":"把处境与记忆同步到语雀","section":"同步","timeout_ms":5000,"side_effects":true}
```

一行 JSON、五字段齐全（design.md §8）。`side_effects` 是 `true`：`sync` 会写语雀、
会写本地 `state.json`。但这不代表无参模式有副作用——见下条。

### 2. 无参：只读一行

被 `agent-man context sense` / `agent-man context show` 收进「建议」段，给人一句
「语雀那边跟本体还一不一致」。**不联网、不写盘**，只翻本地 `state.json` 里记的哈希：

```console
$ agent-man-yuQue
语雀：与本体一致（3h 前）

$ agent-man-yuQue                       # 处境刚改过
语雀：处境待推送（4h 前）

$ agent-man-yuQue                       # 一次都没同步过
语雀：还没同步过，待推送 2 篇
```

这一行有预算：本体按 cost 算（全角 1 / 半角 0.28，每条再加 8），分给零件的是 120。
所以它压在 ~30 cost 以内、只出一行，超了会被整条丢掉。因此这里**不**自己加 `· ` 前缀，
也不折行——本体渲染时会补 `· …（yuQue）`。

库名没配（`YUQUE_NAMESPACE` 没设、`state.json` 里也没记过上次写过哪个库）时，这一行只答一句话：

```console
$ agent-man-yuQue
语雀：没设目标知识库（YUQUE_NAMESPACE）
```

退 **0**，不是 64：本体把零件的无参输出当「答话」，非 0 会被记进 failures 并带出 `! ` 噪声。
缺**配置**退 0、缺**依赖**照旧 69（找不到 `agent-man` 是后端不在，不是"你不知道配哪个库"）；
64 只留给真正要动世界的两个入口——`status` 与 `sync`，它们能让人去改配置。
库名的三条规矩：`sync` 每次都要由 `YUQUE_NAMESPACE` 明说（写操作不许靠"上次往哪写"猜目标，
缺了就 64）；`status` 与无参允许沿用 `state.json` 里记过的上次库名，两者都没有才报缺库。

本体数据读不到（找不到 `agent-man`、或本体自己报错）→ stderr 一行 `! `，退 69。

这一行也有代价，明码标价：判「一致 / 待推送」得按同一套哈希把两篇重算一遍，而两份数据来自
**四份**本体查询（`context show --json`、`memory ls --json`、`rule ls --json`、`self show --json`），
一条命令一个进程、四份各起一个本体进程。实测（装了插件、Win 上真机）：单次 `context show --json`
约 0.14 秒，无参模式整体**约 0.7–1 秒**；`agent-man context sense --json` 单问这一条也差不多是
这个量级。本体没有把四份合成一次的读接口（`--help` 里给记忆的只有 `memory ls`、给规矩的只有
`rule ls`，`context digest` 只照顾处境），所以这里**不合并、也不缓存**：能省的只有进程数，
而省进程就得拿正确性换（缓存会让「本体刚改过」这一行说假话），不如把这 ~1 秒摊开说明。
要更快就只能少问：别让本体在每次开口前都问一遍零件，或接受这一秒。

### 3. `status`：本地状态（不联网）

```console
$ agent-man-yuQue status
上次同步    2026-11-20 00:31（4h 前）
处境        落后：内容变了
  agent-man-situation  https://www.yuque.com/你的登录名/你的库短名/agent-man-situation
记忆        一致：3h 前
  agent-man-memory     https://www.yuque.com/你的登录名/你的库短名/agent-man-memory
```

`status --json` 一行、不缩进，给机器读：

```console
$ agent-man-yuQue status --json
{"lastAt":"2026-11-20T00:31:12+08:00","tocAt":null,"tocPending":false,"docs":[…]}
```

`docs` 里每篇是 `{slug,title,url,hash,syncedAt,stale,why}`，`hash` 是 64 位 sha256。

`why` 只有三种：`还没同步过` / `内容变了` / `一致`。

### 4. `sync`：真同步

```console
$ agent-man-yuQue sync --dry-run
将创建 处境 → agent-man-situation（还没同步过）
将创建 记忆 → agent-man-memory（还没同步过）
（--dry-run：一个语雀请求都没发）

$ agent-man-yuQue sync
已创建 处境 → https://www.yuque.com/你的登录名/你的库短名/agent-man-situation
已创建 记忆 → https://www.yuque.com/你的登录名/你的库短名/agent-man-memory

$ agent-man-yuQue sync                    # 什么都没变：一个请求都不发
没变，跳过 处境
没变，跳过 记忆
```

- `--dry-run`：只打印将要做什么，**一个请求都不发**（连 GET 都不发）。
- `--only situation` / `--only memory`：只推一篇（另一篇照常报「没变，跳过」或不动）。
- 幂等靠 sha256：`state.json` 里记每篇的 `hash`，同一内容不重发。
  哈希只算**正文的稳定内核**，而且这个内核里一个时间都不许有：不含 `同步于 …` 那一行时刻、
  不含页脚，也不含「夜深了」「3 小时前」「还剩多久」这类相对时间文案——它们每过一分钟就变，
  混进去幂等就是假的。处境的 `core` 由 `agent-man context show --json` 的稳定字段拼成，
  字段取舍写在 `src/render.mjs` 顶部的判定表里。
- 每篇写完立刻落 `state.json`（原子写：tmp → fsync → rename）；中途挂掉不会丢掉已完成的那篇。

## 两篇文档

| slug（可用环境变量改） | 默认标题 | 正文从哪来 |
| --- | --- | --- |
| `agent-man-situation` | agent-man 处境 | `agent-man context show --json` 的处境快照重排 |
| `agent-man-memory` | agent-man 记忆 | `memory` / `rule` / `self` 三条 `--json` 拼三块 |

处境那篇排成五块：此刻（`clock` / 静默 / 上次开口 / 积压）、日程、便条、最弱的三条、建议。
**哈希只吃稳定内核**：`lastSaid`、`backlog.unconsolidated`、`plans[{id,due,text}]`、
`notes[{id,at,text,trigger,when}]`、`weakest[{id,text}]`；`at` / `clock` / `quiet` / `since` /
`left` / `late` / `r` / `used` 这些随钟走的东西只进正文、不进哈希。

记忆那篇排三块：结论表（槽位/事实/证据/何时）、规矩表（规矩/为什么/何时）、自我块原文。
每块正文里都写清了字段来自哪条命令，两边对不上时知道该去查哪条。

## 配置（全部走环境变量）

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `YUQUE_TOKEN` | — | 语雀令牌，**只有 `sync` 需要**。绝不落盘、绝不回显、不进仓库 |
| `--token-file <路径>` | — | 用文件里的令牌代替 `YUQUE_TOKEN`（逐次读，不回显） |
| `YUQUE_NAMESPACE` | —（必填） | 目标知识库，形如 `登录名/库短名`。**没有内置默认值**：不给就退 64 |
| `YUQUE_API_BASE` | `https://www.yuque.com/api/v2` | 只接受 `http(s)://`。本地假服务、代理、换域名都改这个 |
| `YUQUE_TIMEOUT_MS` | `15000` | 单次请求超时，超了退 75 |
| `AGENT_MAN_YUQUE_HOME` | `~/.agent-man-yuque` | 里面只有 `state.json` |
| `AGENT_MAN_YUQUE_TOC` | 开 | 设成 `off` 就不碰目录树 |
| `AGENT_MAN_YUQUE_SITUATION_SLUG` / `…_TITLE` | 见上表 | 换 slug / 标题 |
| `AGENT_MAN_YUQUE_MEMORY_SLUG` / `…_TITLE` | 见上表 | 同上 |
| `AGENT_MAN_BIN` | — | 本体可执行文件；缺省在 PATH 找 `agent-man`，再缺省用 `AGENT_MAN_REPO` 下面那个 |
| `AGENT_MAN_REPO` | — | 本体仓库路径（上面那条缺省用） |

数据来源**一律走本体的 CLI**（`agent-man <cmd> --json`），不直接读 `~/.agent-man` 下的文件——
那是第二真源，形状随时会变，绕过 CLI 就是把插件焊死在内部实现上。

## 退出码

| 码 | 含义 |
| --- | --- |
| 0 | 成功 |
| 64 | 参数/用法错（插件自己的事，不该进本体的冷却） |
| 69 | 依赖缺失、或本体说不：没令牌、令牌无效/没写权限、库看不见、找不到 agent-man、本体给 `! ` 原文 |
| 75 | 超时：语雀那边没回，或本体 CLI 超时/被杀 |
| 1 | 其它失败（说明怎么改）；目录树没挂上这种部分成功也退 1 |

所有错误一行 `! ` 走 stderr；stdout 只放结果。

## 幂等、部分成功与限流

- **先 GET 判存在**：`GET /repos/{ns}/docs/{slug}` 200 → 存在（PUT 更新），404 → 不存在（POST 创建）。
  语雀没有「200 + 错误体」这种花活，按 HTTP 状态判。
- **只写 markdown**：读 `data.body`（Markdown 原文），写 `format: "markdown"`。
  `body_html` / `body_lake` / `body_draft` 一概不碰——回写它们等于把文档改成另一种格式。
- **目录树得单独挂，而且只能增量挂**：`POST` 创建后文档不会自己出现在左侧目录里，
  得再 `PUT /repos/{ns}/toc`，body 是 `{"action":"appendNode","action_mode":"sibling","type":"DOC",
  "doc_ids":[<doc id>]}`——一次挂一个节点，不动别人的。
  **绝不**再 `PUT /repos/{ns}` 带 `{toc}` 做全量替换：真实 `toc_yml` 是语雀自己的内部目录树
  （`type: META` / `type: DOC` + `uuid`/`doc_id`/`level`），全量替换会把它整棵盖掉。
  判重按 `type: DOC` 节点的 `doc_id` 与裸 slug `url` 两个条件匹配，已经挂上就一个请求都不发。
- **挂树失败算部分成功**：正文已经写好，不谎报 0。`state.json` 照落、退 1，stderr 说清原因——
  只有 401/403 才叫「缺 repo 写权限（HTTP 403）」，5xx / 网络 / 形状认不出就说那件事本身，
  不冤枉权限。`state.json` 里记 `tocPending`，下次 `sync` 只补目录树、不重发正文。
  `AGENT_MAN_YUQUE_TOC=off` 则整段跳过，连库都不查。
- **不自动重试**：语雀限流是账号级共享额度（5000/小时），撞 429 就停下报原文，不连续轰炸。
- **可见性**：新建时 `public: 0` 显式写死，不让「这篇会不会公开」交给库的默认值去决定；
  更新时**不碰** `public`（不偷偷改已存在文档的可见性）。要不要往公开库写由你配，插件不替你决定。
  接口事实都记在 [docs/yuque-api-facts.md](docs/yuque-api-facts.md) 里。

## 测试

```powershell
npm test                       # == node --test
node scripts/check-style.mjs   # 行宽 ≤110 / UTF-8 无 BOM / 零 CRLF，有命中列 文件:行号 并退 1
```

用例用 `node:http` 起一个假语雀服务（形状照真实响应抄：`{meta,data}` 双层、`_serializer`、
`format: markdown`、404 的 `{status,message}` 无 `code` 字段），再配一个按剧本吐 JSON 的假
`agent-man` 可执行文件，全程不联网、不碰真语雀、只用假令牌 `mock-token-123`。

### 联调（要两份 checkout 一起跑，不在 `npm test` 里）

`npm test` 只测插件自己。要证明「插件放进本体里真的能跑」，跑 [tools/integration.mjs](tools/integration.mjs)：

```powershell
$env:AGENT_MAN_REPO = '<本体仓库根，含 bin/agent-man.mjs>'   # 或把本体放在兄弟目录 ../agent-man
node tools/integration.mjs                                   # 32 条，约 2 分钟
```

它起**真本体 CLI**、**假语雀**（`127.0.0.1:0`）、**真插件**，验 `--describe` 契约、无参模式零请求
零写盘、数据只走本体 CLI、upsert 与跨分钟幂等、目录树只增量挂、退出码 0/64/69/75、以及本体屏上
真出现 `（yuQue）` 那一行。跑一趟两分钟，所以**不进 CI**；改了契约、无参那一行、调用形状或幂等
逻辑再跑。红线与失败怎么读见 [tools/README.md](tools/README.md)。

联调踩过的坑记在 [docs/integration-findings.md](docs/integration-findings.md)：
15 条 F 编号，每条都有根因、修法与锁它的断言，别把那些约束改回去。
从头验一遍（七条命令，不含令牌）照 [docs/acceptance.md](docs/acceptance.md) 走。

## 隐私

令牌、cookie、真实姓名/邮箱一律不进仓库；测试里只有一眼可辨的假令牌。
`state.json` 只记 slug / url / 哈希 / 时刻 / 库名，不含正文。
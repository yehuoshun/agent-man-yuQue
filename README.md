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
本体在 Windows 只认 `.exe` / `.cmd` / `.bat`）。

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

本体数据读不到（找不到 `agent-man`、或本体自己报错）→ stderr 一行 `! `，退 69。

### 3. `status`：本地状态（不联网）

```console
$ agent-man-yuQue status
上次同步    2026-11-20 00:31（4h 前）
处境        落后：内容变了
  agent-man-situation  https://www.yuque.com/mock-user/mock-book/agent-man-situation
记忆        一致：3h 前
  agent-man-memory     https://www.yuque.com/mock-user/mock-book/agent-man-memory
```

`status --json` 一行、不缩进，给机器读：

```console
$ agent-man-yuQue status --json
{"lastAt":"2026-11-20T00:31:12+08:00","tocAt":null,"tocPending":false,"docs":[{"slug":"agent-man-situation","title":"agent-man 处境","url":"https://…","hash":"…","syncedAt":"…","stale":true,"why":"内容变了"}]}
```

`why` 只有三种：`还没同步过` / `内容变了` / `一致`。

### 4. `sync`：真同步

```console
$ agent-man-yuQue sync --dry-run
将创建 处境 → agent-man-situation（还没同步过）
将创建 记忆 → agent-man-memory（还没同步过）
（--dry-run：一个语雀请求都没发）

$ agent-man-yuQue sync
已创建 处境 → https://www.yuque.com/mock-user/mock-book/agent-man-situation
已创建 记忆 → https://www.yuque.com/mock-user/mock-book/agent-man-memory

$ agent-man-yuQue sync                    # 什么都没变：一个请求都不发
没变，跳过 处境
没变，跳过 记忆
```

- `--dry-run`：只打印将要做什么，**一个请求都不发**（连 GET 都不发）。
- `--only situation` / `--only memory`：只推一篇（另一篇照常报「没变，跳过」或不动）。
- 幂等靠 sha256：`state.json` 里记每篇的 `hash`，同一内容不重发。
  哈希只算**正文的稳定内核**——不含 `同步于 …` 那一行时刻、也不含页脚，
  否则每次渲染都「变了」，幂等就是假的。
- 每篇写完立刻落 `state.json`（原子写：tmp → fsync → rename）；中途挂掉不会丢掉已完成的那篇。

## 两篇文档

| slug（可用环境变量改） | 默认标题 | 正文从哪来 |
| --- | --- | --- |
| `agent-man-situation` | agent-man 处境 | `agent-man context show` 的**纯文本原样**（不重排、不造第二份真源），加一行生成时刻与页脚 |
| `agent-man-memory` | agent-man 记忆 | `agent-man memory ls --json` / `agent-man rule ls --json` / `agent-man self show --json` 排成三块：结论表（槽位/事实/证据/何时）、规矩表（规矩/为什么/何时）、自我块原文 |

记忆那层渲染是插件自己的事——语雀是另一种排版介质，但每块正文里都写清了字段来自哪条命令，
两边对不上时知道该去查哪条。

## 配置（全部走环境变量）

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `YUQUE_TOKEN` | — | 语雀令牌，**只有 `sync` 需要**。绝不落盘、绝不回显、不进仓库 |
| `--token-file <路径>` | — | 用文件里的令牌代替 `YUQUE_TOKEN`（逐次读，不回显） |
| `YUQUE_NAMESPACE` | `mock-user/mock-book` | 目标知识库，形如 `登录名/库短名` |
| `YUQUE_API_BASE` | `https://www.yuque.com/api/v2` | 只接受 `http(s)://`。本地假服务、代理、换域名都改这个 |
| `YUQUE_TIMEOUT_MS` | `15000` | 单次请求超时，超了退 75 |
| `AGENT_MAN_YUQUE_HOME` | `~/.agent-man-yuque` | 里面只有 `state.json` |
| `AGENT_MAN_YUQUE_TOC` | 开 | 设成 `off` 就不碰目录树 |
| `AGENT_MAN_YUQUE_SITUATION_SLUG` / `…_TITLE` | 见上表 | 换 slug / 标题 |
| `AGENT_MAN_YUQUE_MEMORY_SLUG` / `…_TITLE` | 见上表 | 同上 |
| `AGENT_MAN_BIN` | — | 本体可执行文件；缺省在 PATH 找 `agent-man`，再缺省 `AGENT_MAN_REPO/bin/agent-man.mjs` |
| `AGENT_MAN_REPO` | — | 本体仓库路径（上面那条缺省用） |

数据来源**一律走本体的 CLI**（`agent-man <cmd> --json`），不直接读 `~/.agent-man` 下的文件——
那是第二真源，形状随时会变，绕过 CLI 就是把插件焊死在内部实现上。

## 退出码

| 码 | 含义 |
| --- | --- |
| 0 | 成功 |
| 64 | 参数/用法错（插件自己的事，不该进本体的冷却） |
| 69 | 依赖缺失：没有令牌、令牌无效/没这个库的写权限、找不到 agent-man、库看不见 |
| 75 | 网络超时 |
| 1 | 其它 API 失败（并说明怎么改） |

所有错误一行 `! ` 走 stderr；stdout 只放结果。

## 幂等、部分成功与限流

- **先 GET 判存在**：`GET /repos/{ns}/docs/{slug}` 200 → 存在（PUT 更新），404 → 不存在（POST 创建）。
  语雀没有「200 + 错误体」这种花活，按 HTTP 状态判。
- **只写 markdown**：读 `data.body`（Markdown 原文），写 `format: "markdown"`。
  `body_html` / `body_lake` / `body_draft` 一概不碰——回写它们等于把文档改成另一种格式。
- **目录树是另一次写**：`POST` 创建后文档不会自己出现在左侧目录里，得再
  `PUT /repos/{ns}` 带 `toc`（全量替换）。我们只往原有 `toc_yml` 末尾追加自己两篇，
  不覆盖别人的节点；解析不出来就跳过并在 stderr 说明。
  缺 `repo` 写权限时这一步会 403——那是**部分成功**：正文已经更新，不谎报 0，
  stderr 写清「正文已更新，目录树未挂上（缺 repo 写权限）」，退 1，
  并且在 `state.json` 里记 `tocPending`，下次 `sync` 只补目录树、不重发正文。
- **不自动重试**：语雀限流是账号级共享额度（5000/小时），撞 429 就停下报原文，不连续轰炸。
- **可见性**：新建时 `public: 0` 显式写死（facts.md §6），不让「这篇会不会公开」交给库的默认值去决定；
  更新时**不碰** `public`（不偷偷改已存在文档的可见性）。默认库 `mock-book` 本身是私密的。

## 测试

```powershell
npm test        # == node --test
```

用例用 `node:http` 起一个假语雀服务（形状照真实响应抄：`{meta,data}` 双层、`_serializer`、
`format: markdown`、404 的 `{status,message}` 无 `code` 字段），再配一个按剧本吐 JSON 的假
`agent-man` 可执行文件，全程不联网、不碰真语雀、只用假令牌 `mock-token-123`。

## 隐私

令牌、cookie、真实姓名/邮箱一律不进仓库；测试里只有一眼可辨的假令牌。
`state.json` 只记 slug / url / 哈希 / 时刻，不含正文。
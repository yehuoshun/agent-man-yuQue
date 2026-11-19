# agent-man-yuQue 项目约定

把 agent-man 的「处境」「记忆」反向同步成语雀文档。**单向**：只往语雀推，不写回本体。
契约（`--describe` 五字段、退出码 0/64/69/75、stdout ≤8KB、无参只读）见
`code/agent-man/docs/design.md` §8——那一节是硬约定，改这里之前先读它。

## 形态

- 零依赖、Node ≥ 20、ESM、全 `.mjs`、`"private": true`（不发布 npm）。
- 无分号、单引号、2 空格缩进、行宽 ≤ 110、全 LF、UTF-8 无 BOM。
- 具名 `export function`；跨目录（`bin/`、`test/`）只 import `src/index.mjs` 门面，
  不直接摸 `src/` 里的零件。
- 目录：`bin/`（薄壳，只接退出码）、`src/`（`main` 分派 + `describe` / `config` / `api` /
  `render` / `sync` / `state` + `index` 门面）、`test/`（一模块一个测试文件 + `helpers.mjs`）、
  `scripts/`（卫生自查）、`docs/`（接口事实）。
  `src/` 与 `test/` 根是平铺的模块表，不再往下分目录。

## 数据来源只许走本体 CLI

`agent-man <cmd> --json`——`AGENT_MAN_BIN` → PATH 上的 `agent-man` → `AGENT_MAN_REPO/bin/agent-man.mjs`。
**不许**直接读 `~/.agent-man` 下的文件：那是第二真源，形状随时会变，绕过 CLI 等于把插件焊死在
内部实现上。

## 语雀接口的事实来源

`docs/yuque-api-facts.md`（实测记录，只搬事实、不含任何 uid/令牌）。要改 `src/api.mjs` 先核这一份：

- `GET /repos/{ns}/docs/{slug}`：200 存在、404 不存在；错误体是 `{status, message}`，**没有 `code`**
  → 一律按 HTTP status 分类，别去读 body。
- 详情 `data.body` 是 Markdown 原文；`body_html` / `body_lake` / `body_draft` 绝不回写。
- 新建带 `public: 0`（不让可见性继承默认值），更新**不碰** `public`（不改已有文档的可见性）。
- 真实 `toc_yml` 是**内部 TOC**：节点是 `type: META` / `type: DOC` + `uuid` / `doc_id` / `level`；
  `DOC` 节点的 `url` 是**裸 slug**（不是 `/ns/slug` 全路径）。
- 挂树只走增量接口 `PUT /repos/{ns}/toc` + `{"action":"appendNode","action_mode":"sibling",
  "type":"DOC","doc_ids":[<doc id>]}`；`doc_id` 取 `POST /repos/{ns}/docs` 回包的 `data.id`
  或详情里的 `data.id`。**禁止**再用 `PUT /repos/{ns}` 带 `{toc}` 全量替换——会盖掉别人的内部目录。
  判重按 `type: DOC` 节点的 `doc_id` 与裸 slug `url` 两个条件，已经挂上就一个请求都不发。
- 挂树 401/403 才是「缺 repo 写权限」，属**部分成功**（正文成功、退 1、state 照落、下次只重试挂树）；
  5xx / 网络 / 形状认不出要说那件事本身，别冤枉权限。
- 限流是账号级共享，撞 429 停下报原文、不自动重试。

改假语雀（`test/helpers.mjs`）时，回包形状必须照 facts 抄（`{meta, data}` 双层、`_serializer`、
`format: markdown`、404 无 `code`），否则测试只挡得住「对着假接口通、对着真接口挂」。

## 测试

`npm test`（== `node --test`）。用例名用中文写**约束**，不写函数名；不写用例条数。
临时目录 `fs.mkdtempSync(path.join(os.tmpdir(), 'agent-man-yuque-fake-'))` + `finally` 清理；
假服务听 `127.0.0.1:0` 取随机端口，不写死端口。

关键约束（改动时别弄丢）：无参零请求零写盘、`--dry-run` 零写请求、同内容不重发、
哈希只算正文稳定内核（不含时刻、页脚与相对时间文案）、state.json 原子写、坏 state.json 当空状态不崩。
卫生三条（行宽 / BOM / CRLF）用 `node scripts/check-style.mjs` 自查，提交前跑一遍。

## 凭据

令牌只从 `YUQUE_TOKEN` 或 `--token-file` 读，不落盘、不回显、不写进日志与提交信息。
测试只用一眼假的 `mock-token-123`。`state.json` 只记 slug / url / 哈希 / 时刻，不含正文。

## Git

分支先行（`feat/`、`fix/`、`docs/`…），一改一提交一 push；提交信息中文
`范围: 改了什么(为什么)`，范围取 `cli` / `plugin` / `api` / `render` / `sync` / `state` / `docs` / `test`。
不 `git add -A`，不 `reset --hard` / `checkout -- .` / `clean -fd` / `push --force`。
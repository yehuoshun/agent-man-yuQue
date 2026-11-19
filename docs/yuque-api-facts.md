# 语雀 API 的事实

这份文件只记**实测过的接口事实**，是 `src/api.mjs` 与 `test/helpers.mjs`（假语雀）的唯一依据。
改接口调用先核这里；发现新事实就往下加，别把猜测写进来。

不含任何 uid / 令牌 / cookie：库名一律写成 `<登录名>/<库短名>`，真实值只在环境变量里。

## 信封与认证

- 基址 `https://www.yuque.com/api/v2`，认证头 `X-Auth-Token: <令牌>`（不接受 `Authorization: Bearer`）。
- 成功回包是 `{ meta, data }` 双层；我们只读 `data`。
- 错误回包是 `{ status, message }`，**没有 `code` 字段** → 一律按 HTTP 状态分类，别去读 body 里的东西。

## 状态码语义

| 状态 | 含义 | 我们怎么退 |
| --- | --- | --- |
| 200 / 201 | 成功（创建走 201 也可能 200） | 继续 |
| 401 | 令牌无效或过期 | 69，提示换令牌 |
| 403 | 令牌没这个库的写权限（含挂目录树） | 69（正文阶段）/ 部分成功（目录树阶段，见下） |
| 404 | 命名空间看不见、或文档不存在 | 69（查库）/ 「不存在」分支（查文档） |
| 429 | 账号级共享额度（5000/小时）撞了 | 1，报原文，**不自动重试** |
| 其它 | 5xx、形状不对等 | 1，报原文 |

401 / 403 才是权限问题；5xx 与「认不出的形状」不许说成缺权限。

## 知识库与目录树

`GET /repos/<登录名>/<库短名>` 回 `{ data: { id, slug, namespace, toc_yml, … } }`。

`toc_yml` 是**内部 TOC**（左侧目录树本身），YAML 文本，节点形如：

```yaml
- type: META
  count: 2
- type: DOC
  uuid: 930001
  doc_id: 900001
  url: welcome
  level: 0
- type: DOC
  uuid: 930002
  doc_id: 900002
  url: notes
  level: 0
```

两条关键事实：

1. 真实 `toc_yml` 是内部 TOC：`type: META` / `type: DOC` 是它的节点类型，`DOC` 节点带
   `uuid` / `doc_id` / `level`。它**不是**随便一棵「标题 + 链接」的树。
2. 真实节点的 `url` 是**裸 slug**（`welcome`、`notes`），不是 `/登录名/库短名/welcome` 这种带前缀的路径。

### 挂树用增量接口

```
PUT /repos/<登录名>/<库短名>/toc
{"action":"appendNode","action_mode":"sibling","type":"DOC","doc_ids":[<doc id>]}
```

回 `{ data: { action, action_mode } }`。这是**增量**追加一个节点，不动别人。

**不要**再用 `PUT /repos/<登录名>/<库短名>` 带 `{ toc }` 做全量替换：那会把整棵内部 TOC
换成我们拼出来的文本，别人的节点一起没了。这条是本节最重要的一句。

判重看 `type: DOC` 节点的 `doc_id` 与 `url`（裸 slug）：只要命中一个，就说明已经挂过，
**一个请求都不发**。

## 文档

- `GET /repos/<登录名>/<库短名>/docs/<slug>`：200 → `{ data: { id, slug, title, body, … } }`；
  404 → 这篇不存在（不是错误，是「要新建」）。
- 详情里的 `data.body` 是 Markdown 原文；`body_html` / `body_lake` / `body_draft` 是语雀自己的
  渲染产物，**绝不回写**（回写等于把文档改成另一种格式）。
- `POST /repos/<登录名>/<库短名>/docs`：新建，body 带 `title` / `slug` / `body` / `format: "markdown"` /
  `public: 0`。回包里的 `data.id` 就是挂树要用的 doc_id。
- `PUT /repos/<登录名>/<库短名>/docs/<id 或 slug>`：更新，只带 `title` / `format: "markdown"` / `body`。
  不回写 `body_html` / `body_lake`。
- 更新**不碰** `public`：不偷偷改已存在文档的可见性。新建显式 `public: 0`，不把「这篇会不会公开」
  交给库的默认值。

## 时序上的坑

- 新建文档**不会**自动进左侧目录树，得单独挂一次（见上）。
- 挂树失败不该让正文白写：正文算成功、`state.json` 照落、退出码 1，下次只重试挂树。
- 语雀没有「200 + 错误体」这种花活，别写「先解析 message 再判成功」的代码。

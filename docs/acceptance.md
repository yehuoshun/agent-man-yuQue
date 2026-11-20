# 早上验收清单

七条，从上往下跑，全部绿就是这波联调通过。命令都在本仓库根（`code/agent-man-yuQue`）执行，
需要本体 checkout 并排放在 `../agent-man`（本次就是 `code/agent-man`）。

不含任何令牌与库名。要真连语雀时自己先 `$env:YUQUE_TOKEN`、`$env:YUQUE_NAMESPACE`。

## 1. 两仓都在远端、没有领先未推的提交

```powershell
git -C ..\agent-man status -sb                     # 期望 ## main...origin/main
git -C . status -sb                                # 期望 ## main...origin/main
git -C ..\agent-man log --oneline -1
git -C . log --oneline -1
```

期望 HEAD：本体 `18a5886`（`main` 与 `v1` 都指向它）、插件 `911a442`。两行都**不带** `ahead`。

## 2. 插件仓库是公开的，且没有隐私泄露

```powershell
# 匿名访问要 200（说明真的 public）
curl.exe -s -o NUL -w "%{http_code}`n" https://github.com/yehuoshun/agent-man-yuQue
```

- 仓库 `visibility=public`，默认分支 `main`。
- 全历史已用 `git filter-repo` 做过字符串替换（库短名/数字 id/登录名）并强推。
- 29 个提交逐版本复扫**零命中**；当前树零命中。详见仓库根 `PRIVACY_DECLARATION.md`。
- 声明里如实留了两条：作者名与邮箱没清；强推后旧对象在 GitHub GC 前可能仍可按旧 sha 访问。

## 3. 插件自己的单测与卫生

```powershell
node --test                    # 期望 tests 54 / pass 54 / fail 0
node scripts/check-style.mjs   # 期望三行 ok
```

## 4. 本体自己的单测

```powershell
npm --prefix ..\agent-man test
```

期望 `pass 490 / fail 0 / skipped 1`（491 条）。

## 5. 两仓联调（最关键的一条）

```powershell
node tools/integration.mjs
```

期望 `PASS 32 / SKIP 1 / FAIL 0`，退出码 0。约两分钟，中间有一条要等跨整分钟。

`SKIP 1` 是 `LIVE` 那条（要真令牌），没配令牌时恒跳过，不算失败。
每条断言验什么、失败怎么读，见 [tools/README.md](../tools/README.md)。

## 6. 本体屏上真的出现插件那一行

```powershell
node ..\agent-man\bin\agent-man.mjs context show
```

期望输出里有一行 `· 语雀：…（yuQue）`，且整条命令**一两秒内**返回（修前是 5 秒超时截断）。

再验开关：

```powershell
$env:AGENT_MAN_PARTS_INJECT='0'
node ..\agent-man\bin\agent-man.mjs context show   # stderr 应报「零件注入已关」，且没有 yuQue 行
```

## 7. 语雀上真有两篇（要令牌，可跳过）

```powershell
$env:YUQUE_TOKEN = (Get-Content <工作区>\config\yuque_token.txt -Raw).Trim()
$env:YUQUE_NAMESPACE = '<登录名>/<库短名>'
node bin\agent-man-yuQue.mjs sync
```

期望 `已创建 处境 / 记忆`（或 `没变，跳过`），库里去看到两篇：处境篇、记忆篇。
再立刻跑一次同一条命令，期望**一个请求都不发**、输出「没变，跳过」。

## 这波改了什么

- **插件**：新建仓库并实现（零依赖、Node ≥ 20）。无参只读一行给本体屏用，`status` 本地状态，
  `sync` 单向推两篇文档。数据只走 `agent-man <cmd> --json`，不读本体数据目录。
- **联调挖出的 15 个问题**全部修掉并有断言锁住，账本在
  [docs/integration-findings.md](integration-findings.md)。其中三条是本体侧（自递归、零件开关
  是死配置、未知 env 刷警告），其余在插件侧。
- **本体**：给零件子进程盖 `AGENT_MAN_PART_CALL=1` 切断「本体→零件→本体」环，`parts.inject`
  真正生效；文档里「默认 namespace 指向作者私密库」这句旧说法改掉了。

## 失败时先看哪里

| 现象 | 先看 |
| --- | --- |
| 第 5 条 `FAIL` | 报文里有 `id`（如 `D3-R`），去 findings.md 找同编号那一节 |
| 第 6 条 5 秒才返回 | 本体 `src/cli/registry.mjs` 的 `senseParts()`，哨兵没生效 |
| 第 6 条没有 yuQue 行 | 插件是否在 PATH / `AGENT_MAN_BIN` 指对 / `--describe` 能否单独跑通 |
| 第 7 条报 429 | 语雀限流是账号级共享额度，停下报原文即可，插件不自动重试 |
| 第 7 条报 401/403 | 令牌或该库的写权限，不是插件 bug |
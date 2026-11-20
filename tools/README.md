# tools/README.md —— 插件↔本体联调（可选跑，不属于 npm test）

## 什么时候跑

改了插件契约（`--describe` 的 name/desc/section/timeout_ms）、无参模式那一行、调本体的命令形状、
upsert/幂等逻辑，或者本体侧改了零件装配/sense/屏幕 —— 跑这一条。日常改文案、改测试不用跑。

## 怎么跑

```powershell
$env:AGENT_MAN_REPO = '<本体仓库根，含 bin/agent-man.mjs>'   # 或把本体放在兄弟目录 ../agent-man
node tools/integration.mjs                      # 全量 A~F 共 32 条，约 2 分钟（有跨整分钟的等待）
node tools/integration.mjs --only=A,B,C2,F      # 只跑选中组/断言，改名后先跑这个（几秒）
```

退出码：`0` 全绿 · `1` 有 FAIL（末尾会列 `失败项：…`）· `2` 找不到本体仓库（按提示设 `AGENT_MAN_REPO`）。

## 失败怎么看

每条 `FAIL 编号  断言` 下面缩进那一行就是证据：真实 stdout/stderr 片段、假语雀收到的请求路径与
方法、耗时、exit code。照着证据和 `REPORT.md` 里的期望值对，就能判断是插件坏了还是断言写错了。

## 和 npm test 的分工

`npm test` 是单元测试：快、纯本地、只测插件自己。这条是**真两仓联调**：起真本体 CLI（临时
`AGENT_MAN_HOME`）、起假语雀（`127.0.0.1:0`）、跑真插件，慢，所以不进 CI 的 `node --test`。

## 一次全量跑出什么

32 条，按组：A 4（契约形状）· B 5（无参模式）· C 2（数据只走本体 CLI）· D 12（upsert / 幂等 /
目录树 / 退出码）· E 6（真本体 + 真插件，含注入通道自递归、哨兵、`sense` deadline）· F 3（隐私与
仓库卫生）。另有 LIVE 一条恒 SKIP（要真令牌，得人工指一个专用测试库）。

**同一台机上别并发跑两份**：每条断言的临时目录是 `mkdtempSync` 出来的（每进程唯一），两份不会
互相踩文件；但两边会同时起一串本体子进程，D3-R / D9-R 这类靠时间量的断言在 CPU 争抢下会假红
（早期版本更糟：目录写死成 `.run`，并发时一方 `freshDir()` 会把另一方的 `state.json` 删掉）。
跑之前先确认没有另一个 `integration.mjs` 在跑。

## 它保证不碰什么

不碰真语雀、不用真令牌（只用 `test-token-not-real`）、不碰 `~/.agent-man`（每个子进程都显式给
`AGENT_MAN_HOME` / `AGENT_MAN_YUQUE_HOME`）、不改两个仓库的任何文件，临时目录全部 `mkdtemp` 后 `finally` 删。
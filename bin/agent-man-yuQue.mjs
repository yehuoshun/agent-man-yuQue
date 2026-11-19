#!/usr/bin/env node
// 薄壳：只接退出码。指令走 argv、结果走 stdout、日志走 stderr（design §8 插件契约）。
import { main } from '../src/index.mjs'

try {
  process.exitCode = await main(process.argv.slice(2))
} catch (e) {
  process.stderr.write(`! ${e?.message ?? e}\n`)
  process.exitCode = 1
}
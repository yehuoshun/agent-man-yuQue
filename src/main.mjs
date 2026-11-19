// 参数分派：一个进程一件事，stdout 只放结果，错误一律一行 "! " 走 stderr（design §8 契约）。
// 退出码只用 0 / 64（参数错）/ 69（依赖缺失）/ 75（超时），其余算 1。
import { describeLine } from './describe.mjs'
import { fail } from './config.mjs'
import { senseLine, statusJson, statusView, syncRun } from './sync.mjs'

const USAGE = [
  '用法：agent-man-yuQue <命令>',
  '',
  '  （无参）          只读一行：语雀上的副本和本体还一不一致（不联网、不写盘）',
  '  status [--json]   本地状态：每篇的 slug / url / 哈希 / 是否落后（不联网）',
  '  sync [--dry-run] [--only situation|memory] [--token-file <路径>]',
  '                    真同步：渲染 → 比哈希 → 没变跳过、变了 upsert 到语雀',
  '  --describe        插件契约回包（一行 JSON，供 agent-man 发现）',
  '  --help            这份说明',
  '',
  '环境变量：YUQUE_TOKEN（sync 必需）· YUQUE_NAMESPACE（默认 mock-user/mock-book）',
  '          YUQUE_API_BASE · AGENT_MAN_YUQUE_HOME · AGENT_MAN_BIN / AGENT_MAN_REPO',
  '',
].join('\n')

function parseStatusFlags(rest) {
  const flags = { json: false }
  for (const one of rest) {
    if (one === '--json') {
      flags.json = true
    } else {
      throw fail(64, `status 不认这个参数「${one}」：只支持 --json`)
    }
  }
  return flags
}

function flagValue(rest, index, name) {
  const inline = rest[index].indexOf(`${name}=`)
  if (inline === 0) return { value: rest[index].slice(name.length + 1), step: 0 }
  const next = rest[index + 1]
  if (typeof next !== 'string' || next === '' || next.startsWith('--')) {
    throw fail(64, `${name} 后面要跟一个值`)
  }
  return { value: next, step: 1 }
}

function parseSyncFlags(rest) {
  const flags = { dryRun: false, only: null, tokenFile: '' }
  for (let i = 0; i < rest.length; i += 1) {
    const one = rest[i]
    if (one === '--dry-run') {
      flags.dryRun = true
    } else if (one === '--only' || one.startsWith('--only=')) {
      const got = flagValue(rest, i, '--only')
      flags.only = got.value
      i += got.step
    } else if (one === '--token-file' || one.startsWith('--token-file=')) {
      const got = flagValue(rest, i, '--token-file')
      flags.tokenFile = got.value
      i += got.step
    } else {
      throw fail(64, `sync 不认这个参数「${one}」：支持 --dry-run / --only / --token-file`)
    }
  }
  return flags
}

export async function main(argv = [], ctx = {}) {
  const args = Array.from(argv, (one) => String(one))
  const env = ctx.env ?? process.env
  const out = typeof ctx.out === 'function' ? ctx.out : (text) => process.stdout.write(text)
  const err = typeof ctx.err === 'function' ? ctx.err : (text) => process.stderr.write(text)
  const now = ctx.now instanceof Date ? ctx.now : new Date(ctx.now ?? Date.now())
  const head = args.length === 0 ? '' : args[0]

  try {
    if (head === '') {
      const sense = senseLine(env, { now })
      for (const one of sense.warnings) err(`! ${one}\n`)
      out(`${sense.line}\n`)
      return 0
    }

    if (head === '--describe' || head === 'describe') {
      if (args.length > 1) {
        throw fail(64, '--describe 不带参数：它只回一行 JSON，多给的口令说明用错了')
      }
      out(`${describeLine()}\n`)
      return 0
    }

    if (head === '--help' || head === '-h' || head === 'help') {
      out(USAGE)
      return 0
    }

    if (head === 'status') {
      const flags = parseStatusFlags(args.slice(1))
      const view = statusView(env, { now })
      for (const one of view.warnings) err(`! ${one}\n`)
      out(flags.json ? `${statusJson(view)}\n` : `${view.lines.join('\n')}\n`)
      return 0
    }

    if (head === 'sync') {
      const flags = parseSyncFlags(args.slice(1))
      const result = await syncRun(env, { now, ...flags })
      for (const one of result.warnings) err(`! ${one}\n`)
      out(`${result.lines.join('\n')}\n`)
      if (flags.dryRun) err('（--dry-run：一个语雀请求都没发）\n')
      if (result.tocProblem !== undefined && result.tocProblem !== null) {
        const why = result.tocProblem.message ?? String(result.tocProblem)
        err(`! 正文已更新，目录树未挂上（缺 repo 写权限）：${why}\n`)
      }
      return result.code
    }

    throw fail(64, `还不认识「${head}」：可用的是 --describe / status / sync（打 --help 看全部）`)
  } catch (e) {
    err(`! ${e?.message ?? e}\n`)
    return typeof e?.exitCode === 'number' ? e.exitCode : 1
  }
}
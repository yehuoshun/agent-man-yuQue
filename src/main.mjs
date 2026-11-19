// 参数分派。骨架阶段只接了 --describe，其余三种模式随实现逐条补上（见 README 的路线）。
import { describeLine } from './describe.mjs'

const USAGE = `用法：
  agent-man yuQue --describe   自报五字段（这一版只实现了它）
`

// 返回退出码，不自己 process.exit：bin 薄壳负责把它交回系统（design §8 的 0/64/69/75）。
export async function main(argv = [], ctx = {}) {
  const out = ctx.out ?? ((s) => process.stdout.write(s))
  const err = ctx.err ?? ((s) => process.stderr.write(s))
  const args = argv.map(String)
  const head = args[0]
  if (head === '--describe' || head === 'describe') {
    if (args.length > 1) {
      err('! --describe 不带别的参数\n')
      return 64
    }
    out(`${describeLine()}\n`)
    return 0
  }
  if (head === '--help' || head === '-h' || head === 'help') {
    out(USAGE)
    return 0
  }
  err(`${head === undefined ? '! 这一版还没接无参模式' : `! 还不认识「${head}」`}\n`)
  err('! 这一版只有 --describe 能用，其余模式还在实现中\n')
  return 64
}
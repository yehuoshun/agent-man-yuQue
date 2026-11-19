// --describe 是零件与主体的唯一契约（design §8）：五字段齐全、一行、不超 8KB。
// 发现器少一个字段就把这个零件判成"还没按契约实现"，所以这里逐条钉住，不靠"看着对"。
import test from 'node:test'
import assert from 'node:assert/strict'

import { main, DESCRIBE, describeLine } from '../src/index.mjs'

function recorder() {
  const out = []
  const err = []
  return { out, err, ctx: { out: (s) => out.push(s), err: (s) => err.push(s) } }
}

test('--describe 输出一行、五字段齐全，name 是 yuQue', async () => {
  const r = recorder()
  const code = await main(['--describe'], r.ctx)
  assert.equal(code, 0)
  assert.equal(r.out.length, 1)
  assert.equal(r.err.length, 0)
  const line = r.out[0]
  assert.equal(line.trimEnd(), line.replace(/\n$/, ''))
  assert.equal(line.split('\n').filter(Boolean).length, 1)
  const got = JSON.parse(line)
  assert.deepEqual(Object.keys(got).sort(), ['desc', 'name', 'section', 'side_effects', 'timeout_ms'])
  assert.equal(got.name, 'yuQue')
  assert.equal(got.section, '同步')
  assert.equal(got.side_effects, true)
  assert.equal(typeof got.desc, 'string')
  assert.equal(got.timeout_ms, 5000)
})

test('--describe 的行不超过 8KB（骨架按字节截断，超了等于回包坏了）', () => {
  const bytes = Buffer.byteLength(`${describeLine()}\n`, 'utf8')
  assert.ok(bytes <= 8192, `回包 ${bytes} 字节`)
  assert.equal(DESCRIBE.timeout_ms > 0, true)
})

test('--describe 带多余参数退 64（参数错是调用方的错，不该进冷却）', async () => {
  const r = recorder()
  const code = await main(['--describe', 'x'], r.ctx)
  assert.equal(code, 64)
  assert.equal(r.out.length, 0)
  assert.match(r.err.join(''), /^! /)
})

test('还不认识的子命令退 64，并说清怎么改', async () => {
  const r = recorder()
  const code = await main(['nope'], r.ctx)
  assert.equal(code, 64)
  assert.match(r.err.join(''), /! /)
  assert.match(r.err.join(''), /--describe/)
})
// 端到端：假 agent-man（按剧本吐 JSON）+ 本地假语雀（形状照 facts.md）。
// 关键约束都在这里钉住：无参零请求、--dry-run 零写请求、幂等跳过、401/403/超时/坏 JSON 的退出码。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { main, loadState, statePath } from '../src/index.mjs'
import { MOCK_TOKEN, SCENARIO_DEFAULT, clearDir, makeAgentMan, startYuque } from './helpers.mjs'

// 本体给一条建议行的预算按 cost 算（半角 0.28 / 全角 1.0，再加 LINE_OVERHEAD 8）；这里按同口径复核。
const WIDE = /[\u2E80-\u303E\uFF00-\uFF60\u2600-\u27BF]|[\u{1F000}-\u{1FAFF}]/u
function cost(text) {
  let sum = 0
  for (const ch of String(text)) sum += WIDE.test(ch) ? 1 : 0.28
  return sum
}

function tempHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agent-man-yuque-home-'))
}

async function harness(options = {}) {
  const agent = makeAgentMan(options.scenario ?? {})
  const yuque = await startYuque()
  const home = tempHome()
  const env = {
    ...options.env,
    AGENT_MAN_BIN: agent.script,
    AGENT_MAN_YUQUE_HOME: home,
    YUQUE_API_BASE: yuque.base,
    YUQUE_TOKEN: options.token ?? MOCK_TOKEN,
    YUQUE_TIMEOUT_MS: options.timeoutMs ?? '5000',
    YUQUE_NAMESPACE: 'mock-user/mock-book',
  }
  const run = async (argv, nowText = '2026-11-20T00:31:12+08:00') => {
    const out = []
    const err = []
    const code = await main(argv, {
      env,
      out: (t) => out.push(t),
      err: (t) => err.push(t),
      now: new Date(nowText),
    })
    return { code, out: out.join(''), err: err.join(''), lines: out.join('').trimEnd().split('\n') }
  }
  return {
    agent,
    yuque,
    home,
    env,
    run,
    cleanup: async () => {
      await yuque.close()
      clearDir(home)
      clearDir(agent.dir)
    },
  }
}

test('无参只读一行：不联网（假语雀零请求）、不写盘、单行、cost 在预算内', async () => {
  const h = await harness()
  try {
    const r = await h.run([])
    assert.equal(r.code, 0)
    assert.equal(r.lines.length, 1, '只出一行（多行会被本体用空格折叠）')
    assert.ok(r.out.endsWith('\n'))
    assert.ok(!r.out.startsWith('· ') && !r.out.startsWith('- '), '本体已经加前缀，别自己再加')
    assert.ok(r.out.includes('语雀'), '要让本体屏幕上看出这是哪个零件的话')
    assert.ok(r.out.includes('还没同步过'), '第一次跑就是"没同步过"')
    assert.ok(cost(r.lines[0]) + 8 <= 120, `一行要装进零件预算，实际 cost ${cost(r.lines[0]) + 8}`)
    assert.ok(r.lines[0].length <= 200)
    assert.equal(h.yuque.requests.length, 0, '无参模式一个请求都不许发')
    assert.deepEqual(fs.readdirSync(h.home), [], '无参模式不许写盘')
  } finally {
    await h.cleanup()
  }
})

test('无参：同步过之后说"一致"，本体内容变了说"待推送"（都靠本地哈希判，不联网）', async () => {
  const h = await harness()
  try {
    const first = await h.run(['sync'])
    assert.equal(first.code, 0, first.err)
    const same = await h.run([])
    assert.ok(same.out.includes('与本体一致'), same.out)
    assert.ok(same.out.includes('刚同步过'), same.out)

    // 隔三小时再算：同内容只换时间，应该说"3h 前"。
    const later = await h.run([], '2026-11-20T03:31:12+08:00')
    assert.ok(later.out.includes('3h 前'), later.out)

    h.agent.set({ context: 'agent-man · 2026-11-20 04:00\n\n新的一天\n' })
    const stale = await h.run([], '2026-11-20T04:31:12+08:00')
    assert.ok(stale.out.includes('处境待推送'), stale.out)
    assert.ok(stale.out.includes('4h 前'), stale.out)
  } finally {
    await h.cleanup()
  }
})

test('无参：本体找不到时打一行 "! " 到 stderr 并退 69（依赖缺失，不是崩溃）', async () => {
  const out = []
  const err = []
  const code = await main([], {
    env: { PATH: '', AGENT_MAN_BIN: '', AGENT_MAN_REPO: '', AGENT_MAN_YUQUE_HOME: os.tmpdir() },
    out: (t) => out.push(t),
    err: (t) => err.push(t),
  })
  assert.equal(code, 69)
  assert.equal(out.join(''), '', '没有结果就不要往 stdout 写东西')
  assert.match(err.join(''), /^! /m)
  assert.ok(err.join('').includes('agent-man'))
})

test('sync 首次：正文 POST + 目录树 PUT，state.json 记下 slug/url/hash', async () => {
  const h = await harness()
  try {
    const r = await h.run(['sync'])
    assert.equal(r.code, 0, r.err)
    assert.equal(r.lines.length, 2)
    assert.match(r.lines[0], /^已创建 处境 → https:\/\/www\.yuque\.com\/yehuoshun\/mock-book\/agent-man-situation$/)
    assert.match(r.lines[1], /^已创建 记忆 → https:\/\/www\.yuque\.com\/yehuoshun\/mock-book\/agent-man-memory$/)
    assert.deepEqual(h.yuque.methods(), ['GET', 'GET', 'POST', 'GET', 'POST', 'PUT'], '一次查库、两次判存在、两次建、一次写目录树')

    const situation = h.yuque.docs.get('agent-man-situation')
    assert.ok(situation.body.includes('夜深了，不主动说'), '正文要带 context show 原文')
    assert.ok(situation.body.includes('agent-man 处境') === false, '正文不该重复标题')
    assert.ok(h.yuque.docs.get('agent-man-memory').body.includes('| 槽位 | 事实 | 证据 | 何时 |'))
    assert.ok(h.yuque.state.repo.toc_yml.includes('/mock-user/mock-book/agent-man-situation'), '目录树要挂上')
    assert.ok(h.yuque.state.repo.toc_yml.includes('type: META'), '原有的 META 节点不许被覆盖掉')

    const state = loadState(h.home)
    assert.equal(Object.keys(state.docs).length, 2)
    assert.equal(state.docs['agent-man-situation'].hash.length, 64)
    assert.equal(state.lastAt, '2026-11-20T00:31:12+08:00')
  } finally {
    await h.cleanup()
  }
})

test('sync 二次同内容：一篇都不写，只说"没变，跳过"（幂等）', async () => {
  const h = await harness()
  try {
    await h.run(['sync'])
    const before = h.yuque.requests.length
    const r = await h.run(['sync'])
    assert.equal(r.code, 0, r.err)
    assert.deepEqual(r.lines, ['没变，跳过 处境', '没变，跳过 记忆'])
    const after = h.yuque.requests.slice(before).map((one) => one.method)
    assert.deepEqual(after, [], '一致时零请求（连 GET 都不需要）')
  } finally {
    await h.cleanup()
  }
})

test('sync 内容变了：走 PUT 而不是 POST，正文换成新的', async () => {
  const h = await harness()
  try {
    await h.run(['sync'])
    h.agent.set({ context: 'agent-man · 2026-11-20 09:00\n\n换了一天\n' })
    const before = h.yuque.requests.length
    const r = await h.run(['sync'], '2026-11-20T09:01:00+08:00')
    assert.equal(r.code, 0, r.err)
    assert.deepEqual(r.lines, [
      '已更新 处境 → https://www.yuque.com/mock-user/mock-book/agent-man-situation',
      '没变，跳过 记忆',
    ])
    const after = h.yuque.requests.slice(before)
    assert.deepEqual(after.map((one) => one.method), ['GET', 'GET', 'PUT'], '先查库、判存在、再更新')
    assert.ok(h.yuque.docs.get('agent-man-situation').body.includes('换了一天'))
    assert.equal(h.yuque.state.repo.items_count, undefined, '创建/更新都不许带 public 字段')
    const created = h.yuque.requests.filter((one) => one.method === 'POST')
    for (const one of created) assert.equal('public' in one.body, false)
  } finally {
    await h.cleanup()
  }
})

test('--only memory 只动记忆一篇，别的篇目一个请求都不发', async () => {
  const h = await harness()
  try {
    await h.run(['sync'])
    h.agent.set({ rules: { items: [{ text: '新规矩', why: '因为', at: 1795105192643 }] } })
    const before = h.yuque.requests.length
    const r = await h.run(['sync', '--only', 'memory'], '2026-11-20T10:00:00+08:00')
    assert.equal(r.code, 0, r.err)
    assert.deepEqual(r.lines, ['已更新 记忆 → https://www.yuque.com/mock-user/mock-book/agent-man-memory'])
    const paths = h.yuque.requests.slice(before).map((one) => `${one.method} ${one.path}`)
    assert.ok(paths.every((one) => !one.includes('situation')), `不该碰处境：${paths.join(' / ')}`)

    // --only 给个不认识的篇名是参数错（64），不是崩溃。
    const bad = await h.run(['sync', '--only', 'nope'])
    assert.equal(bad.code, 64)
    assert.ok(bad.err.includes('--only'), bad.err)
  } finally {
    await h.cleanup()
  }
})

test('--dry-run：一个写请求都不发（断言方法集合里没有 POST/PUT），也不落 state', async () => {
  const h = await harness()
  try {
    const r = await h.run(['sync', '--dry-run'])
    assert.equal(r.code, 0, r.err)
    assert.deepEqual(r.lines, ['将创建 处境 → agent-man-situation（还没同步过）', '将创建 记忆 → agent-man-memory（还没同步过）'])
    assert.deepEqual(h.yuque.requests, [], '--dry-run 连读都不发')
    assert.deepEqual(fs.readdirSync(h.home), [], '--dry-run 不许写盘')
    assert.ok(r.err.includes('--dry-run'), '要说清一个请求都没发')
  } finally {
    await h.cleanup()
  }
})

test('--dry-run 在已同步之后：说清"将更新"，依旧零写请求', async () => {
  const h = await harness()
  try {
    await h.run(['sync'])
    h.agent.set({ context: 'agent-man · 2026-11-20 09:00\n\n换了一天\n' })
    const before = h.yuque.requests.length
    const r = await h.run(['sync', '--dry-run'], '2026-11-20T09:01:00+08:00')
    assert.equal(r.code, 0, r.err)
    assert.deepEqual(r.lines, ['将更新 处境 → agent-man-situation（内容变了）', '没变，跳过 记忆'])
    const writes = h.yuque.requests
      .slice(before)
      .filter((one) => one.method === 'POST' || one.method === 'PUT')
    assert.deepEqual(writes, [])
  } finally {
    await h.cleanup()
  }
})

test('令牌缺失：退 69，一个请求都不发，也不写盘', async () => {
  const h = await harness({ token: '' })
  try {
    const r = await h.run(['sync'])
    assert.equal(r.code, 69)
    assert.match(r.err, /^! /m)
    assert.ok(r.err.includes('YUQUE_TOKEN'))
    assert.ok(!r.err.includes('mock-token'), '错误消息里绝不能出现令牌值')
    assert.deepEqual(h.yuque.requests, [])
    assert.deepEqual(fs.readdirSync(h.home), [])
  } finally {
    await h.cleanup()
  }
})

test('令牌无效（401）：退 69 并说令牌无效或过期，别猜别的', async () => {
  const h = await harness({ token: 'mock-token-wrong' })
  try {
    const r = await h.run(['sync'])
    assert.equal(r.code, 69)
    assert.ok(r.err.includes('令牌无效或过期'), r.err)
    assert.equal(h.yuque.writes().length, 0, '认证失败就不许往下写')
  } finally {
    await h.cleanup()
  }
})

test('库不可见（404）：退 69 并指向命名空间', async () => {
  const h = await harness()
  try {
    h.yuque.state.repoStatus = 404
    const r = await h.run(['sync'])
    assert.equal(r.code, 69)
    assert.ok(r.err.includes('库看不见'), r.err)
    assert.equal(h.yuque.writes().length, 0)
  } finally {
    await h.cleanup()
  }
})

test('超时：退 75（不是 1），并说清多少毫秒没回', async () => {
  const h = await harness({ timeoutMs: '150' })
  try {
    h.yuque.setMode('hang')
    const r = await h.run(['sync'])
    assert.equal(r.code, 75)
    assert.ok(r.err.includes('150ms'), r.err)
  } finally {
    await h.cleanup()
  }
})

test('语雀回的不是 JSON：退 1 并说回包坏了（这不是依赖缺失）', async () => {
  const h = await harness()
  try {
    h.yuque.setMode('badjson')
    const r = await h.run(['sync'])
    assert.equal(r.code, 1)
    assert.ok(r.err.includes('不是 JSON'), r.err)
  } finally {
    await h.cleanup()
  }
})

test('写目录树 403：正文算成功、退出码 1、state 照落（下次只重试目录树）', async () => {
  const h = await harness()
  try {
    h.yuque.state.tocStatus = 403
    const r = await h.run(['sync'])
    assert.equal(r.code, 1, '正文已经写好了，别报 0 也别整轮算失败')
    assert.deepEqual(r.lines, [
      '已创建 处境 → https://www.yuque.com/mock-user/mock-book/agent-man-situation',
      '已创建 记忆 → https://www.yuque.com/mock-user/mock-book/agent-man-memory',
    ])
    assert.ok(r.err.includes('正文已更新，目录树未挂上（缺 repo 写权限）'), r.err)

    const state = loadState(h.home)
    assert.equal(Object.keys(state.docs).length, 2, '正文的 hash 要落盘，否则下次会重发')

    // 下一次：正文不重发，只补目录树；成功就回到 0。
    h.yuque.state.tocStatus = null
    const again = await h.run(['sync'], '2026-11-20T01:00:00+08:00')
    assert.equal(again.code, 0, again.err)
    assert.deepEqual(again.lines, ['没变，跳过 处境', '没变，跳过 记忆'])
    assert.ok(h.yuque.state.repo.toc_yml.includes('/mock-user/mock-book/agent-man-memory'), '这次该挂上了')
  } finally {
    await h.cleanup()
  }
})

test('AGENT_MAN_YUQUE_TOC=off：正文写完就不碰目录树（缺 repo 写权限时的兜底）', async () => {
  const h = await harness({ env: { AGENT_MAN_YUQUE_TOC: 'off' } })
  try {
    const r = await h.run(['sync'])
    assert.equal(r.code, 0, r.err)
    const tocWrites = h.yuque.requests.filter((one) => one.method === 'PUT' && one.body?.toc)
    assert.deepEqual(tocWrites, [], 'TOC=off 时不该写目录树')
    assert.ok(!h.yuque.state.repo.toc_yml.includes('agent-man-situation'), '不该动目录树')
  } finally {
    await h.cleanup()
  }
})

test('status 不联网：--json 只出一行且字段齐全，纯文本给人看', async () => {
  const h = await harness()
  try {
    await h.run(['sync'])
    const before = h.yuque.requests.length
    const json = await h.run(['status', '--json'])
    assert.equal(json.code, 0, json.err)
    assert.equal(json.lines.length, 1, '--json 出口只许一行')
    const doc = JSON.parse(json.out)
    assert.equal(doc.namespace, 'mock-user/mock-book')
    assert.equal(doc.docs.length, 2)
    assert.equal(doc.lastAt, '2026-11-20T00:31:12+08:00')
    assert.equal(doc.docs[0].slug, 'agent-man-situation')
    assert.equal(doc.docs[0].stale, false)
    assert.match(doc.docs[0].url, /^https:\/\/www\.yuque\.com\//)
    assert.equal(doc.docs[0].hash.length, 64)

    const human = await h.run(['status'])
    assert.equal(human.code, 0)
    assert.ok(human.lines[0].includes('语雀'), human.out)
    assert.ok(human.out.includes('上次同步'))

    h.agent.set({ context: 'agent-man · 2026-11-20 09:00\n\n换了一天\n' })
    const stale = JSON.parse((await h.run(['status', '--json'], '2026-11-20T09:01:00+08:00')).out)
    assert.equal(stale.docs[0].stale, true)
    assert.equal(stale.docs[0].why, '内容变了')
    assert.equal(stale.docs[1].stale, false)

    assert.deepEqual(h.yuque.requests.slice(before), [], 'status 不许联网')
  } finally {
    await h.cleanup()
  }
})

test('status 在没有同步记录时说"还没同步过"，而不是给个假时间', async () => {
  const h = await harness()
  try {
    const json = JSON.parse((await h.run(['status', '--json'])).out)
    assert.equal(json.lastAt, null)
    assert.equal(json.docs[0].url, null)
    assert.equal(json.docs[0].stale, true)
    const human = await h.run(['status'])
    assert.ok(human.out.includes('还没同步过'), human.out)
  } finally {
    await h.cleanup()
  }
})

test('坏的 state.json 当空状态：照常同步成功，并在 stderr 说明白（不许崩）', async () => {
  const h = await harness()
  try {
    fs.mkdirSync(h.home, { recursive: true })
    fs.writeFileSync(statePath(h.home), '{ 坏掉了', 'utf8')
    const r = await h.run(['sync'])
    assert.equal(r.code, 0, r.err)
    assert.match(r.err, /^! .*state\.json/m)
    assert.equal(loadState(h.home).docs['agent-man-situation'].hash.length, 64, '整份重写回来')
  } finally {
    await h.cleanup()
  }
})

test('本体说不行（exit≠0）：退 69 并把本体那句 "! " 带上，别自己编原因', async () => {
  const h = await harness({ scenario: { fail: 2 } })
  try {
    const r = await h.run([])
    assert.equal(r.code, 69)
    assert.ok(r.err.includes('假 agent-man 照剧本失败'), r.err)
  } finally {
    await h.cleanup()
  }
})

test('stdout 单行 ≤8KB：两篇正文再大也只回几行结果，不许把正文打到屏上', async () => {
  const big = `${'x'.repeat(60000)}\n`
  const h = await harness({ scenario: { context: big, self: { text: big } } })
  try {
    for (const argv of [[], ['--describe'], ['status', '--json'], ['sync', '--dry-run']]) {
      const r = await h.run(argv)
      const bytes = Buffer.byteLength(r.out, 'utf8')
      assert.ok(bytes <= 8192, `${argv.join(' ') || '无参'} 的回包超了 8KB：${bytes}`)
      const lineCount = r.out.trimEnd().split('\n').length
      const mustOneLine = argv.length === 0 || argv[0] === '--describe' || argv[0] === 'status'
      if (mustOneLine) assert.equal(lineCount, 1, `${argv.join(' ') || '无参'} 只许一行`)
    }
  } finally {
    await h.cleanup()
  }
})
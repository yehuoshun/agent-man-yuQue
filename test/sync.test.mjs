// 同步用例：真跑 main(argv, ctx)，只打 127.0.0.1 上的假语雀、只调假 agent-man。
// 时间一律用假 now 推进，不真 sleep——"隔 61 秒"这种复现也是演出来的。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { collectSources, createApi, main, runAgentMan, stampOf } from '../src/index.mjs'
import {
  MOCK_TOKEN,
  SCENARIO_DEFAULT,
  SCENE_AT,
  clearDir,
  closeAllFakes,
  makeAgentMan,
  sceneOf,
  startYuque,
} from './helpers.mjs'

// 起点：处境那一刻 + 12 秒（和真机一样，同步时刻比处境晚一点）。
const T0 = new Date(SCENE_AT + 12 * 1000)
const STAMP = stampOf(T0)
const NS = 'mock-user/mock-repo'

// 用具例自己建出来的目录要在文件末尾统一删；假服务由 closeAllFakes 兜底。
const STRAY = []

async function harness(options = {}) {
  const agent = makeAgentMan(options.scenario ?? {})
  const yuque = await startYuque(options.yuque ?? {})
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-man-yuque-state-'))
  STRAY.push(home, agent.dir)
  const env = {
    AGENT_MAN_BIN: agent.script,
    AGENT_MAN_YUQUE_HOME: home,
    YUQUE_API_BASE: yuque.base,
    YUQUE_TOKEN: MOCK_TOKEN,
    YUQUE_TIMEOUT_MS: options.timeoutMs ?? '5000',
    YUQUE_NAMESPACE: NS,
    ...(options.env ?? {}),
  }
  let now = T0
  return {
    agent,
    yuque,
    home,
    env,
    statePath: path.join(home, 'state.json'),
    later(minutes) {
      now = new Date(T0.getTime() + minutes * 60 * 1000)
      return now
    },
    // 请求序列：去掉 /api/v2 前缀，断言看着像人话。
    calls: () => yuque.requests.map((one) => `${one.method} ${one.path.replace('/api/v2', '')}`),
    async run(argv, at = null) {
      if (at !== null) now = at instanceof Date ? at : new Date(at)
      const out = []
      const err = []
      const code = await main(argv, { env, now, out: (one) => out.push(one), err: (one) => err.push(one) })
      const outText = out.join('')
      const errText = err.join('')
      return {
        code,
        out: outText,
        err: errText,
        lines: outText.split('\n').filter((one) => one !== ''),
      }
    },
    stateFile() {
      return JSON.parse(fs.readFileSync(path.join(home, 'state.json'), 'utf8'))
    },
  }
}

function changedMemory() {
  const next = JSON.parse(JSON.stringify(SCENARIO_DEFAULT.memory))
  next.items[0].fact = '空调从来不调 24 度以下'
  return next
}

test.after(async () => {
  await closeAllFakes()
  for (const dir of STRAY) clearDir(dir)
})

test('无参：只读一行，零请求零写盘', async () => {
  const h = await harness()
  const r = await h.run([])
  assert.equal(r.code, 0)
  assert.deepEqual(r.lines, ['语雀：还没同步过，待推送 2 篇'], '骨架只吃一行')
  assert.equal(h.yuque.requests.length, 0, '无参不许联网')
  assert.equal(fs.existsSync(h.statePath), false, '无参不许写盘')
})

test('调本体四份取数一律带 --json，少一个就拿不到数据', async () => {
  const h = await harness()
  const r = await h.run(['status'])
  assert.equal(r.code, 0, r.err)
  const calls = h.agent.calls()
  // 四份是并行问的，谁先谁后不定；这里只认"问的是这四件事"，不认顺序。
  assert.deepEqual(calls.map((one) => one.slice(0, 2).join(' ')).sort(), [
    'context show',
    'memory ls',
    'rule ls',
    'self show',
  ])
  for (const one of calls) assert.equal(one[2], '--json', `${one[0]} ${one[1]} 少了 --json`)
})

test('调本体只带筛过的 env：令牌不出本进程，插件自己的变量也不透给本体', async () => {
  const dataHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-man-home-'))
  STRAY.push(dataHome)
  // AGENT_MAN_YUQUE_TOC 也给上：插件自己的开关同样不许进本体。
  const h = await harness({ env: { AGENT_MAN_HOME: dataHome, AGENT_MAN_YUQUE_TOC: 'off' } })
  assert.equal(h.env.YUQUE_TOKEN, MOCK_TOKEN, '前提：插件自己手里是有令牌的')
  const r = await h.run(['status'])
  assert.equal(r.code, 0, r.err)
  const seen = h.agent.envs()
  assert.equal(seen.length, 4, '四份取数，每回都该记一笔')
  for (const one of seen) {
    assert.ok(!one.keys.includes('YUQUE_TOKEN'), `${one.argv.join(' ')} 看到了令牌`)
    const leaked = one.keys.filter((key) => /^AGENT_MAN_YUQUE_/i.test(key))
    assert.deepEqual(leaked, [], `${one.argv.join(' ')} 看到了插件变量`)
    assert.ok(one.keys.includes('AGENT_MAN_HOME'), '本体的数据目录要留着')
    assert.equal(one.home, dataHome, 'AGENT_MAN_HOME 要原样递过去，本体靠它找数据')
  }
  // 假本体照真本体的脾气：env 里有看不懂的 AGENT_MAN_* 就刷一行警告。这行不该出现在输出里。
  assert.ok(!r.err.includes('不对应任何配置键'), r.err)
  assert.ok(!r.out.includes('不对应任何配置键'), r.out)
})

test('AGENT_MAN_BIN 指到 .cmd 垫片也能跑：路径带空格也一样（真机装在 Program Files 下）',
  { skip: process.platform !== 'win32' }, async () => {
    const h = await harness({
      env: {
        PATH: process.env.PATH,
        ComSpec: process.env.ComSpec,
        SystemRoot: process.env.SystemRoot,
        PATHEXT: process.env.PATHEXT,
      },
    })
    // 目录名故意带空格：不加引号时 cmd.exe 会把路径截断在第一段（实测会报 not recognized）。
    const shimDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-man shim-'))
    STRAY.push(shimDir)
    const shim = path.join(shimDir, 'agent-man.cmd')
    fs.writeFileSync(shim, `@echo off\n"${process.execPath}" "${h.agent.script}" %*\n`, 'utf8')
    h.env.AGENT_MAN_BIN = shim
    const r = await h.run(['status'])
    assert.equal(r.code, 0, r.err)
    // 第一行是抬头（库名 + 数据目录），「上次同步」在第二行（前面两个空格）。
    assert.equal(r.lines[1], '  上次同步  还没同步过', r.out)
    const calls = h.agent.calls()
    assert.equal(calls.length, 4, '垫片要把四份取数原样转给假本体')
    const lines = calls.map((one) => one.join(' '))
    assert.ok(lines.includes('context show --json'), lines.join(' / '))
  })

test('首次 sync：新建两篇后各挂一次树，且绝不整棵替换 toc', async () => {
  const h = await harness()
  const r = await h.run(['sync'])
  assert.equal(r.code, 0, r.err)
  assert.equal(r.lines.length, 2)
  assert.deepEqual(r.lines.map((one) => one.split(' → ')[0]), ['已创建 处境', '已创建 记忆'])
  assert.deepEqual(h.calls(), [
    `GET /repos/${NS}/docs/agent-man-situation`,
    `POST /repos/${NS}/docs`,
    `GET /repos/${NS}/docs/agent-man-memory`,
    `POST /repos/${NS}/docs`,
    `GET /repos/${NS}`,
    `PUT /repos/${NS}/toc`,
    `PUT /repos/${NS}/toc`,
  ], '先写正文（增量），最后才挂树')
  const tocWrites = h.yuque.requests.filter((one) => one.method === 'PUT')
  assert.equal(tocWrites.length, 2, '两篇各挂一次')
  for (const one of tocWrites) {
    assert.equal(one.body.action, 'appendNode')
    assert.equal(one.body.action_mode, 'sibling')
    assert.equal(one.body.type, 'DOC')
    assert.equal(one.body.doc_ids.length, 1)
  }
  assert.deepEqual(tocWrites.map((one) => one.body.doc_ids[0]), [1000, 1001], 'doc_ids 用新建回包的 id')
  const whole = h.yuque.requests.filter((one) => one.method === 'PUT' && one.path.endsWith(`/${NS}`))
  assert.equal(whole.length, 0, 'PUT /repos/{ns} 会盖掉真实内部目录，一个都不许发')
  const types = h.yuque.tocNodes.map((one) => one.type)
  assert.deepEqual(types, ['META', 'DOC', 'DOC', 'DOC', 'DOC'], 'META 留着，只在末尾追加节点')
  const slugs = h.yuque.tocNodes.filter((one) => one.type === 'DOC').map((one) => one.url)
  assert.deepEqual(slugs.slice(2), ['agent-man-situation', 'agent-man-memory'], '真实节点 url 是裸 slug')
  const state = h.stateFile()
  assert.equal(state.docs['agent-man-situation'].hash.length, 64)
  assert.equal(state.docs['agent-man-memory'].hash.length, 64)
  assert.equal(state.tocPending, false)
  assert.equal(state.lastAt, STAMP)
})

test('幂等：同一份数据隔 61 秒再 sync，一个请求都不发', async () => {
  const h = await harness()
  assert.equal((await h.run(['sync'])).code, 0)
  const sent = h.yuque.requests.length
  // 61 秒后：本体那屏的抬头、剩余时间都变了（只进正文，不进哈希）。
  h.agent.set({ scene: sceneOf({ minutes: 1, left: '明天 09:59' }) })
  const again = await h.run(['sync'], new Date(T0.getTime() + 61 * 1000))
  assert.equal(again.code, 0, again.err)
  assert.deepEqual(again.lines, ['没变，跳过 处境', '没变，跳过 记忆'])
  assert.equal(h.yuque.requests.length, sent, '同内容一个请求都不发')
  // 再推十分钟也一样。
  h.agent.set({ scene: sceneOf({ minutes: 10, left: '明天 09:50', r: 0.38 }) })
  const later = await h.run(['sync'], h.later(10))
  assert.deepEqual(later.lines, ['没变，跳过 处境', '没变，跳过 记忆'])
  assert.equal(h.yuque.requests.length, sent, '十分钟后仍然零请求')
  assert.equal(h.stateFile().docs['agent-man-situation'].hash.length, 64, '哈希没动')
})

test('改一条记忆：只有记忆那篇发 PUT，处境那篇连 GET 都不该多', async () => {
  const h = await harness()
  assert.equal((await h.run(['sync'])).code, 0)
  const sent = h.yuque.requests.length
  h.agent.set({ memory: changedMemory() })
  const r = await h.run(['sync'], h.later(10))
  assert.equal(r.code, 0, r.err)
  assert.deepEqual(r.lines, [
    '没变，跳过 处境',
    `已更新 记忆 → https://www.yuque.com/${NS}/agent-man-memory`,
  ])
  assert.deepEqual(h.calls().slice(sent), [
    `GET /repos/${NS}/docs/agent-man-memory`,
    `PUT /repos/${NS}/docs/agent-man-memory`,
    `GET /repos/${NS}`,
  ], '正文一次 PUT，顺手查一眼目录树判重（不追加）')
  const puts = h.yuque.requests.slice(sent).filter((one) => one.method === 'PUT')
  assert.equal(puts.length, 1, '只许动记忆那篇')
  assert.equal(puts[0].path, `/api/v2/repos/${NS}/docs/agent-man-memory`)
})

test('目录里已有同 slug 的 DOC 节点：零 appendNode，节点数不变', async () => {
  const h = await harness({
    yuque: {
      tocNodes: [
        { type: 'META', version_id: 0, count: 2 },
        { type: 'DOC', uuid: 'mock-uuid-s', doc_id: 7, level: 1, url: 'agent-man-situation' },
        { type: 'DOC', uuid: 'mock-uuid-m', doc_id: 8, level: 1, url: 'agent-man-memory' },
      ],
    },
  })
  const r = await h.run(['sync'])
  assert.equal(r.code, 0, r.err)
  const toc = h.yuque.requests.filter((one) => one.path.includes('/toc'))
  assert.equal(toc.length, 0, '已经挂过了就别再挂')
  assert.equal(h.yuque.tocNodes.length, 3, '节点数不许变')
})

test('toc 403：正文算成功、退出码 1、state 照落，下次只重试挂树', async () => {
  const h = await harness({ yuque: { tocStatus: 403 } })
  const first = await h.run(['sync'])
  assert.equal(first.code, 1, '部分成功要显式非零')
  assert.equal(first.lines.length, 2, '正文那两行照出')
  assert.ok(first.err.includes('缺 repo 写权限'), first.err)
  assert.ok(first.err.includes('HTTP 403'), first.err)
  const state = h.stateFile()
  assert.equal(state.tocPending, true, '欠着挂树')
  assert.equal(Object.keys(state.docs).length, 2, '正文成功就得落 state')
  // 下次：正文没变，只补挂树（补 id 时各查一次详情）。
  h.yuque.state.tocStatus = null
  const sent = h.yuque.requests.length
  const second = await h.run(['sync'], h.later(10))
  assert.equal(second.code, 0, second.err)
  assert.deepEqual(h.calls().slice(sent), [
    `GET /repos/${NS}`,
    `GET /repos/${NS}/docs/agent-man-situation`,
    `PUT /repos/${NS}/toc`,
    `GET /repos/${NS}/docs/agent-man-memory`,
    `PUT /repos/${NS}/toc`,
  ], '只补挂树，不重发正文')
  assert.equal(h.stateFile().tocPending, false)
})

test('toc 5xx：说清是语雀那边没让挂，别冤枉成缺权限', async () => {
  const h = await harness({ yuque: { tocStatus: 500 } })
  const r = await h.run(['sync'])
  assert.equal(r.code, 1)
  assert.ok(r.err.includes('HTTP 500'), r.err)
  assert.ok(!r.err.includes('权限'), `不该提权限：${r.err}`)
})

test('AGENT_MAN_YUQUE_TOC=off：目录树一个请求都不发', async () => {
  const h = await harness({ env: { AGENT_MAN_YUQUE_TOC: 'off' } })
  const r = await h.run(['sync'])
  assert.equal(r.code, 0, r.err)
  assert.deepEqual(h.calls(), [
    `GET /repos/${NS}/docs/agent-man-situation`,
    `POST /repos/${NS}/docs`,
    `GET /repos/${NS}/docs/agent-man-memory`,
    `POST /repos/${NS}/docs`,
  ], '连查库都不必')
  assert.equal(h.yuque.requests.filter((one) => one.path.includes('/toc')).length, 0)
  assert.equal(h.yuque.tocNodes.length, 3, '目录树没被动过')
})

test('--dry-run：只报打算做什么，一个写请求都不发', async () => {
  const h = await harness()
  const first = await h.run(['sync', '--dry-run'])
  assert.equal(first.code, 0)
  assert.deepEqual(first.lines, [
    '将创建 处境 → agent-man-situation（还没同步过）',
    '将创建 记忆 → agent-man-memory（还没同步过）',
  ])
  assert.equal(first.err.includes('一个语雀请求都没发'), true, first.err)
  assert.equal(h.yuque.requests.length, 0)
  const second = await h.run(['sync', '--dry-run'])
  assert.deepEqual(second.lines, first.lines, 'dry-run 不落 state，第二次仍是"将创建"')
  assert.equal(fs.existsSync(h.statePath), false)
})

test('--only memory：只动记忆那篇，处境一个字都不碰', async () => {
  const h = await harness()
  const r = await h.run(['sync', '--only', 'memory'])
  assert.equal(r.code, 0, r.err)
  assert.deepEqual(r.lines, ['已创建 记忆 → https://www.yuque.com/' + NS + '/agent-man-memory'])
  assert.equal(h.yuque.requests.filter((one) => one.path.includes('agent-man-situation')).length, 0)
  assert.equal(h.stateFile().docs['agent-man-situation'], undefined)
})

test('--only 给了不认识的名字：用法错（64）', async () => {
  const h = await harness()
  const r = await h.run(['sync', '--only', 'both'])
  assert.equal(r.code, 64)
  assert.ok(r.err.includes('--only'), r.err)
})

test('缺令牌：依赖缺失（69），不发任何请求', async () => {
  const h = await harness({ env: { YUQUE_TOKEN: '' } })
  const r = await h.run(['sync'])
  assert.equal(r.code, 69)
  assert.ok(r.err.includes('缺语雀令牌'), r.err)
  assert.equal(h.yuque.requests.length, 0)
})

test('令牌无效 401：69 并说清怎么换令牌', async () => {
  // 与仓库约定一致：凭据一律一眼可辨是假的（mock-token-*），别留 'other-token' 这种
  // 分不清真假的字面量——隐私扫描在真仓库里认不出它。
  const h = await harness({ yuque: { token: 'mock-token-other' } })
  const r = await h.run(['sync'])
  assert.equal(r.code, 69)
  assert.ok(r.err.includes('令牌无效或过期'), r.err)
})

test('查库 404 直接说"库看不见"，不是网络问题', async () => {
  const yuque = await startYuque({ repoStatus: 404 })
  const api = createApi({ base: yuque.base, namespace: NS, token: MOCK_TOKEN, timeoutMs: 2000 })
  await assert.rejects(
    () => api.getRepo(),
    (e) => e.exitCode === 69 && e.httpStatus === 404 && /库看不见/.test(e.message),
  )
})

test('语雀那边超时：75（不是缺失，也不是 1）', async () => {
  const h = await harness({ yuque: { mode: 'hang' }, timeoutMs: '150' })
  const r = await h.run(['sync'])
  assert.equal(r.code, 75, r.err)
  assert.ok(r.err.includes('没回'), r.err)
})

test('语雀回的不是 JSON：1，并且不装懂', async () => {
  const h = await harness({ yuque: { mode: 'badjson' } })
  const r = await h.run(['sync'])
  assert.equal(r.code, 1)
  assert.ok(r.err.includes('不是 JSON'), r.err)
})

test('本体超时算超时（75），不算缺失', async () => {
  const agent = makeAgentMan({ sleep: 1500 })
  STRAY.push(agent.dir)
  const bin = { cmd: process.execPath, prefix: [agent.script] }
  await assert.rejects(
    () => runAgentMan(bin, ['context', 'show', '--json'], { env: { ...process.env }, timeoutMs: 120 }),
    (e) => e.exitCode === 75 && /超过 120ms/.test(e.message),
  )
})

test('四份取数一起问：不比串行更慢', async () => {
  // 假本体每次调用先 sleep 300ms。串行要四倍（1200ms 起），并行只比一次多一点点。
  // 钉的是"注入那边只等 parts.deadline（1200ms）"这个前提，不是某个实现细节。
  const agent = makeAgentMan({ sleep: 300 })
  STRAY.push(agent.dir)
  const started = Date.now()
  const env = { ...process.env, AGENT_MAN_BIN: agent.script, AGENT_MAN_HOME: agent.dir }
  const sources = await collectSources(env)
  const spent = Date.now() - started
  assert.ok(spent < 900, `四份取数花了 ${spent}ms：串行会到 1200ms 以上`)
  assert.equal(sources.scene.budget, 550)
  assert.equal(sources.memory.items.length, 1)
  assert.equal(sources.rules.live, 1)
  assert.ok(sources.self.text.includes('搭子'), sources.self.text)
  assert.equal(agent.calls().length, 4, '四份一份不少')
})

test('本体坏了就撤掉兄弟：抛先坏的那条，不陪着别的慢慢等', async () => {
  // 剧本：每次调用先 sleep 600ms 再退 64。串行要 2400ms 才见到第一条错，
  // 并行则在第一份坏掉时就收场，剩下的直接取消（它们的 75 不许冒充原因）。
  const agent = makeAgentMan({ sleep: 600, fail: 64 })
  STRAY.push(agent.dir)
  const started = Date.now()
  await assert.rejects(
    () => collectSources({ ...process.env, AGENT_MAN_BIN: agent.script, AGENT_MAN_HOME: agent.dir }),
    (e) => e.exitCode === 69 && /exit 64/.test(e.message) && e.cancelled !== true,
  )
  const spent = Date.now() - started
  assert.ok(spent < 1500, `等了 ${spent}ms：说明还在串着等`)
})

test('本体找不到算缺失（69），并说清起不来的是什么', async () => {
  const h = await harness({ env: { AGENT_MAN_BIN: path.join(os.tmpdir(), 'no-such-agent-man.mjs') } })
  const r = await h.run(['sync'])
  assert.equal(r.code, 69, r.err)
  assert.ok(r.err.includes('agent-man'), r.err)
})

test('本体说不（非 0）：69，且把它的 ! 原文带上', async () => {
  const h = await harness({ scenario: { fail: 64 } })
  const r = await h.run(['sync'])
  assert.equal(r.code, 69)
  assert.ok(r.err.includes('! 假 agent-man 照剧本失败'), r.err)
  assert.ok(r.err.includes('exit 64'), r.err)
})

test('status：纯文本摊开每篇，--json 只出一行', async () => {
  const h = await harness()
  assert.equal((await h.run(['sync'])).code, 0)
  const text = await h.run(['status'], h.later(3))
  assert.equal(text.code, 0)
  assert.equal(text.lines.length, 4, '抬头 + 上次同步 + 两篇')
  assert.ok(text.lines[0].includes(`语雀 · ${NS}`), text.lines[0])
  assert.ok(text.lines[1].includes('上次同步') && text.lines[1].includes('3m 前'), text.lines[1])
  assert.ok(text.lines[2].includes('agent-man-situation'), text.lines[2])
  const json = await h.run(['status', '--json'], h.later(3))
  const doc = JSON.parse(json.lines[0])
  assert.equal(doc.docs.length, 2)
  assert.equal(doc.docs[0].hash.length, 64)
  assert.equal(doc.tocPending, false)
})

test('无参三态：待推送 → 一致（刚同步过）→ 记忆待推送', async () => {
  const h = await harness()
  assert.deepEqual((await h.run([])).lines, ['语雀：还没同步过，待推送 2 篇'])
  assert.equal((await h.run(['sync'])).code, 0)
  assert.deepEqual((await h.run([])).lines, ['语雀：与本体一致（刚同步过）'])
  h.agent.set({ memory: changedMemory() })
  assert.deepEqual((await h.run([])).lines, ['语雀：记忆待推送（刚同步过）'])
})

test('坏 state.json：当空状态、警告一句，该推的还是照推', async () => {
  const h = await harness()
  fs.writeFileSync(h.statePath, '{不是 JSON', 'utf8')
  const r = await h.run(['sync'])
  assert.equal(r.code, 0, r.err)
  assert.ok(r.err.includes('state.json'), r.err)
  assert.equal(r.lines.length, 2, '当成从没同步过')
  assert.equal(h.stateFile().docs['agent-man-situation'].hash.length, 64)
})

test('sync 的输出只占几行，不会把骨架的预算撑爆', async () => {
  const h = await harness()
  const r = await h.run(['sync'])
  assert.ok(Buffer.byteLength(r.out, 'utf8') <= 8 * 1024, 'stdout 控制在 8KB 内')
  assert.equal(r.lines.length, 2)
})

// cost 口径与本体一致：CJK / 全角按 1.0、ASCII 按 0.28，按码点累加（零依赖，不复刻整张表，
// 只收这一行真会出现的字符区间就够了）。无参那一行要能塞进骨架的一屏预算。
const WIDE_CH = /[\u2E80-\u303E\u4E00-\u9FFF\uFF00-\uFF60\uFFE0-\uFFE6\u2600-\u27BF]/u

function costOf(text) {
  let used = 0
  for (const ch of text) used += WIDE_CH.test(ch) ? 1 : 0.28
  return used
}

test('无参：库名没设、state 里也没记过 → 退 0 只差一句话，不联网不写盘', async () => {
  const h = await harness({ env: { YUQUE_NAMESPACE: '' } })
  const r = await h.run([])
  assert.equal(r.code, 0, '无参是"答话"：缺配置也退 0，否则会被本体记成插件失败')
  assert.deepEqual(r.lines, ['语雀：没设目标知识库（YUQUE_NAMESPACE）'])
  assert.ok(costOf(r.lines[0]) <= 30, `这一行要塞进骨架预算，现在 ${costOf(r.lines[0])}`)
  assert.equal(h.yuque.requests.length, 0, '无参不许联网')
  assert.equal(h.agent.calls().length, 0, '配置都不全，连本体进程都别起')
  assert.equal(fs.existsSync(h.statePath), false, '无参不许写盘')
})

test('库名只记在 state 里：无参与 status 沿用，sync 一律退 64（写操作的目标要每次明说）',
  async () => {
    const h = await harness()
    assert.equal((await h.run(['sync'])).code, 0, '先真写一趟，库名才会落进 state')
    assert.equal(h.stateFile().namespace, NS, '真 sync 必须把"这次写了哪个库"记下来')
    const sent = h.yuque.requests.length

    // 干净 env：YUQUE_NAMESPACE 整个拿掉，只剩 state.json 里那条记录。
    delete h.env.YUQUE_NAMESPACE
    assert.deepEqual((await h.run([])).lines, ['语雀：与本体一致（刚同步过）'])
    const text = await h.run(['status'])
    assert.equal(text.code, 0, text.err)
    assert.ok(text.lines[0].includes(NS), `抬头要说出上次那个库：${text.lines[0]}`)
    const json = JSON.parse((await h.run(['status', '--json'])).lines[0])
    assert.equal(json.namespace, NS)

    const sync = await h.run(['sync'])
    assert.equal(sync.code, 64, 'sync 不许靠"上次往哪写"猜目标')
    assert.ok(sync.err.includes('没设目标知识库'), sync.err)
    assert.ok(sync.err.includes('登录名/库短名'), sync.err)
    assert.equal(h.yuque.requests.length, sent, '这四趟一个请求都不该发')
  })

// 缺**配置**退 0、缺**依赖**照旧 69：这两件事在骨架那边的后果不同（前者只是一句建议，
// 后者要进 failures 攒冷却）。别把"本体不在"混成一句答话——那会让真故障悄悄消失。
test('无参遇到本体找不到：仍是依赖缺失（69），不许被"一行答话"吞掉', async () => {
  const h = await harness({ env: { AGENT_MAN_BIN: path.join(os.tmpdir(), 'no-such-agent-man.mjs') } })
  const r = await h.run([])
  assert.equal(r.code, 69, '本体起不来是依赖问题，不是"你没配库"')
  assert.ok(r.err.includes('! '), r.err)
  assert.ok(r.err.includes('agent-man'), r.err)
  assert.deepEqual(r.lines, [], '不许一边说 69 一边还吐一行答话')
  assert.equal(h.yuque.requests.length, 0)
})

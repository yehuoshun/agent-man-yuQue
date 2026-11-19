// 测试两道假件：一个只会按剧本吐 JSON 的假 agent-man，一个按 docs/yuque-api-facts.md 形状回话的假语雀。
// 假件一律写在系统临时目录（mkdtemp），用例结束就删；只用假 token，真凭据不进仓库。
import test from 'node:test'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'

export const MOCK_TOKEN = 'mock-token-123'

const FAKE_SOURCE = `import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
const here = path.dirname(fileURLToPath(import.meta.url))
const data = JSON.parse(fs.readFileSync(path.join(here, 'scenario.json'), 'utf8'))
const argv = process.argv.slice(2)
const say = (value) => process.stdout.write(JSON.stringify(value) + '\\n')
// 每次调用都记账：用例要能证明"四份取数一律带 --json"（处境曾经漏过）。
fs.appendFileSync(path.join(here, 'calls.jsonl'), JSON.stringify(argv) + '\\n', 'utf8')
// 真本体对看不懂的 AGENT_MAN_* 会刷一行警告：假件照这个行为演，用例才钉得住"别再把插件的变量透过去"。
const unknownEnv = Object.keys(process.env).filter((key) => /^AGENT_MAN_YUQUE_/i.test(key)).sort()
if (unknownEnv.length > 0) {
  process.stderr.write('! 环境变量 ' + unknownEnv[0] + ' 不对应任何配置键，已忽略\\n')
}
// 只记键名与本体的数据目录：令牌的值不落盘，也不进任何一条断言。
const seenEnv = Object.keys(process.env).filter((key) => /^(?:YUQUE_|AGENT_MAN_)/i.test(key)).sort()
fs.appendFileSync(path.join(here, 'env.jsonl'), JSON.stringify({
  argv,
  keys: seenEnv,
  home: process.env.AGENT_MAN_HOME ?? '',
}) + '\\n', 'utf8')
const sleep = Number(data.sleep ?? 0)
if (sleep > 0) {
  const until = Date.now() + sleep
  while (Date.now() < until) { /* 忙等：给超时映射用，外面会把这个进程杀掉 */ }
}
if (data.fail !== undefined && data.fail !== null) {
  process.stderr.write('! 假 agent-man 照剧本失败\\n')
  process.exit(Number(data.fail))
}
if (argv[0] === 'context' && argv[1] === 'show') {
  // 处境只有一条路：--json（纯文本首行是分钟级时间戳，拿它当哈希输入就不幂等）。
  if (argv.indexOf('--json') === -1) {
    process.stderr.write('! context show 少了 --json\\n')
    process.exit(64)
  }
  say(data.scene)
  process.exit(0)
}
if (argv[0] === 'memory' && argv[1] === 'ls' && argv[2] === '--json') {
  say(data.memory)
  process.exit(0)
}
if (argv[0] === 'rule' && argv[1] === 'ls' && argv[2] === '--json') {
  say(data.rules)
  process.exit(0)
}
if (argv[0] === 'self' && argv[1] === 'show' && argv[2] === '--json') {
  say(data.self)
  process.exit(0)
}
process.stderr.write('! 假 agent-man 不认识 ' + argv.join(' ') + '\\n')
process.exit(64)
`

// 剧本里的时刻写成 Date.parse 而不是裸毫秒：13 位毫秒数以 1 开头，隐私扫描会当成手机号。
export const FAKE_AT = Date.parse('2026-11-19T16:19:52.643Z')
export const FAKE_UPDATED_AT = Date.parse('2026-11-19T16:19:52.799Z')
// 处境那一刻的基准（本地时区）：用例靠"只推进时间派生字段"来钉住幂等，基准必须写死。
export const SCENE_AT = Date.parse('2026-11-20T00:31:00+08:00')

function pad2(value) {
  return String(value).padStart(2, '0')
}

function clockOf(at) {
  const d = new Date(at)
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ` +
    `${pad2(d.getHours())}:${pad2(d.getMinutes())}`
}

function numOr(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

// 造一份形状照真机抄的处境 JSON（`AGENT_MAN_HOME=<假数据> agent-man context show --json` 的回包）。
// 稳定字段与时间派生字段故意一起摆着：用例靠"只动后者、哈希不变"证明核心只算稳定内核。
export function sceneOf(options = {}) {
  const at = SCENE_AT + numOr(options.minutes, 0) * 60 * 1000
  return {
    at,
    clock: clockOf(at),
    quiet: options.quiet !== false,
    since: { at: SCENE_AT - 3 * 60 * 60 * 1000, text: options.sinceText ?? '3 小时前', fresh: 2 },
    lastSaid: SCENE_AT - 3 * 60 * 60 * 1000,
    backlog: { unconsolidated: 2, overdue: numOr(options.overdue, 0) },
    debts: { at, unconsolidated: 2, unreflected: 1, lastAt: null, idle: 0, due: false, why: '' },
    plans: [
      {
        id: 'p-1',
        at: SCENE_AT,
        due: SCENE_AT + 33 * 60 * 60 * 1000,
        text: '交房租',
        when: '',
        left: options.left ?? '明天 10:00',
        late: options.late === true,
      },
    ],
    notes: [{ id: 'n-1', at: SCENE_AT, text: '问问她吃了没', trigger: '她说累', when: null }],
    weakest: [
      {
        id: 'm-1',
        at: SCENE_AT,
        text: options.weakText ?? '空调从来不调 22 度以下',
        r: numOr(options.r, 0.42),
        seen: numOr(options.seen, 0),
      },
    ],
    suggest: [{ name: 'yuQue', text: options.suggest ?? '语雀：与本体一致（3h 前）' }],
    budget: 550,
    used: 107,
    over: false,
    head: { lines: 2, cost: 29 },
    dropped: [],
    expired: 0,
    later: 0,
    bad: { events: 0, notes: 0, plans: 0, memory: 0, meta: 0 },
    warnings: [],
  }
}

export const SCENARIO_DEFAULT = {
  scene: sceneOf(),
  memory: {
    items: [
      {
        id: 'm-1',
        key: '她怕冷',
        fact: '空调从来不调 22 度以下',
        imp: 3,
        at: FAKE_AT,
        evidence: { ids: ['e-1', 'e-2'] },
      },
    ],
    skipped: 0,
    since: 0,
    until: null,
    live: true,
    all: false,
  },
  rules: {
    items: [
      {
        id: 'r-1',
        at: FAKE_AT,
        text: '夜里十一点后不提工作',
        why: '昨天 23:40 提加班，她只回了个嗯',
        supersedes: [],
        seen: 0,
        live: true,
      },
    ],
    live: 1,
    total: 1,
    over: 0,
    limit: 20,
    skipped: 0,
  },
  self: {
    text: '## 2026-11-19\n我是她的搭子，不是她的老板。\n',
    cost: 18,
    updatedAt: FAKE_UPDATED_AT,
    limit: 600,
    over: false,
  },
}

// 造一个假 agent-man：写 scenario.json 当剧本，脚本支持 context show --json / memory ls /
// rule ls / self show（四份都只认 --json），并把每次调用的 argv 记进 calls.jsonl。
export function makeAgentMan(scenario = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-man-yuque-fake-'))
  const script = path.join(dir, 'fake-agent-man.mjs')
  const file = path.join(dir, 'scenario.json')
  const callsFile = path.join(dir, 'calls.jsonl')
  const envFile = path.join(dir, 'env.jsonl')
  fs.writeFileSync(script, FAKE_SOURCE, 'utf8')
  const api = {
    dir,
    script,
    file,
    current: {},
    set(next) {
      const merged = { ...SCENARIO_DEFAULT, ...api.current, ...next }
      api.current = merged
      fs.writeFileSync(file, JSON.stringify(merged), 'utf8')
    },
    calls() {
      if (!fs.existsSync(callsFile)) return []
      return fs.readFileSync(callsFile, 'utf8').split('\n').filter(Boolean).map((one) => JSON.parse(one))
    },
    // 每次调用看到的 env（只记键名与本体的数据目录，令牌的值一个字都不落盘）。
    envs() {
      if (!fs.existsSync(envFile)) return []
      return fs.readFileSync(envFile, 'utf8').split('\n').filter(Boolean).map((one) => JSON.parse(one))
    },
    resetCalls() {
      fs.writeFileSync(callsFile, '', 'utf8')
      fs.writeFileSync(envFile, '', 'utf8')
    },
  }
  api.set(scenario)
  return api
}

// 真机 toc_yml 是语雀内部目录：META 节点 + 若干 DOC 节点，DOC 的 url 是**裸 slug**。
// 假语雀照这个形状存节点列表，GET /repos/{ns} 时再拼成 YAML 文本回去。
const DEFAULT_TOC_NODES = [
  { type: 'META', version_id: 0, count: 2, display_level: 1, tail_type: 'UPDATED_AT' },
  { type: 'DOC', uuid: 'mock-uuid-1', doc_id: 900001, level: 1, url: 'welcome', title: '欢迎' },
  { type: 'DOC', uuid: 'mock-uuid-2', doc_id: 900002, level: 1, url: 'notes', title: '随手记' },
]

function tocYmlOf(nodes) {
  const lines = []
  for (const node of nodes) {
    const keys = Object.keys(node)
    lines.push(`- ${keys[0]}: ${node[keys[0]]}`)
    for (const key of keys.slice(1)) lines.push(`  ${key}: ${node[key]}`)
  }
  return `${lines.join('\n')}\n`
}

// 所有活着假件的登记簿：用例文件末尾的 test.after 用它兜底关服务（句柄泄漏比断言失败更难查）。
const LIVE = new Set()

export async function closeAllFakes() {
  for (const one of [...LIVE]) {
    try {
      await one.close()
    } catch {
      // 已经关掉的假件再关一次不算错
    }
  }
  LIVE.clear()
}

// 假语雀：形状照 docs/yuque-api-facts.md 抄（{"meta","data"} 双层、format: markdown、404 无 code）。
export async function startYuque(options = {}) {
  const state = {
    docs: new Map(),
    nextId: 1000,
    requests: [],
    repo: { id: 12345678, slug: 'mock-book', namespace: 'mock-user/mock-book', public: 0 },
    tocNodes: (options.tocNodes ?? DEFAULT_TOC_NODES).map((one) => ({ ...one })),
    mode: options.mode ?? 'ok',
    repoStatus: options.repoStatus ?? null,
    tocStatus: options.tocStatus ?? null,
    docStatus: new Map(options.docStatus ?? []),
    token: options.token ?? MOCK_TOKEN,
  }
  const sockets = new Set()

  const server = http.createServer(async (req, res) => {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', async () => {
      const text = Buffer.concat(chunks).toString('utf8')
      const body = text === '' ? null : JSON.parse(text)
      state.requests.push({ method: req.method, path: req.url, body, token: req.headers['x-auth-token'] })

      if (state.mode === 'hang') return
      if (state.mode === 'badjson') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end('这不是 JSON')
        return
      }
      const send = (status, payload) => {
        res.writeHead(status, { 'Content-Type': 'application/json', 'X-RateLimit-Limit': '5000' })
        res.end(JSON.stringify(payload))
      }
      if (req.headers['x-auth-token'] !== state.token) {
        send(401, { status: 401, message: 'bad X-Auth-Token' })
        return
      }

      const url = new URL(req.url, 'http://127.0.0.1')
      const parts = url.pathname.split('/').filter(Boolean) // api v2 repos ns docs slug
      const after = parts.slice(5)

      if (after.length === 0) {
        if (req.method === 'GET') {
          if (state.repoStatus !== null) {
            return send(state.repoStatus, { status: state.repoStatus, message: 'repo' })
          }
          return send(200, { data: { ...state.repo, toc_yml: tocYmlOf(state.tocNodes) } })
        }
        if (req.method === 'PUT') {
          // 全量替换 toc 的老路子：插件绝不该再走这条（会盖掉真实内部目录），留个记录给用例断言。
          if (state.tocStatus !== null) {
            return send(state.tocStatus, { status: state.tocStatus, message: 'no write' })
          }
          send(200, { data: { ...state.repo, toc_yml: tocYmlOf(state.tocNodes) } })
          return
        }
      }

      // 官方增量接口：只追加节点，不整棵替换。
      if (after.length === 1 && after[0] === 'toc') {
        if (req.method !== 'PUT') return send(404, { status: 404, message: 'not found' })
        if (state.tocStatus !== null) {
          return send(state.tocStatus, { status: state.tocStatus, message: 'no write' })
        }
        if (body === null || body.action !== 'appendNode' || !Array.isArray(body.doc_ids)) {
          return send(400, { status: 400, message: 'toc action 不认识' })
        }
        for (const id of body.doc_ids) {
          const hit = [...state.docs.values()].find((one) => String(one.id) === String(id))
          state.tocNodes.push({
            type: 'DOC',
            uuid: `mock-uuid-${state.tocNodes.length + 1}`,
            doc_id: id,
            level: 1,
            url: hit === undefined ? '' : hit.slug,
            title: hit === undefined ? '' : hit.title,
          })
        }
        return send(200, { data: { action: body.action, action_mode: body.action_mode } })
      }

      if (after.length === 1 && after[0] === 'docs') {
        if (req.method === 'GET') {
          return send(200, { meta: { total: state.docs.size }, data: [...state.docs.values()] })
        }
        if (req.method === 'POST') {
          const id = state.nextId
          state.nextId += 1
          const doc = { id, slug: body.slug, title: body.title, body: body.body, format: body.format }
          state.docs.set(doc.slug, doc)
          return send(200, { data: doc })
        }
      }

      if (after.length === 2 && after[0] === 'docs') {
        const key = after[1]
        const hit = state.docs.get(key) ?? [...state.docs.values()].find((one) => String(one.id) === key)
        if (req.method === 'GET') {
          const forced = state.docStatus.get(key)
          if (forced !== undefined) return send(forced, { status: forced, message: 'doc' })
          if (hit === undefined) return send(404, { status: 404, message: 'doc not found' })
          return send(200, {
            data: {
              ...hit,
              format: 'markdown',
              body_html: '<p>…</p>',
              body_lake: '<lake/>',
              _serializer: 'v2.doc_detail',
            },
          })
        }
        if (req.method === 'PUT') {
          if (hit === undefined) return send(404, { status: 404, message: 'doc not found' })
          hit.title = body.title ?? hit.title
          hit.body = body.body ?? hit.body
          return send(200, { data: hit })
        }
      }

      send(404, { status: 404, message: 'not found' })
    })
  })

  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port

  const handle = {
    base: `http://127.0.0.1:${port}/api/v2`,
    port,
    state,
    docs: state.docs,
    requests: state.requests,
    tocNodes: state.tocNodes,
    methods: () => state.requests.map((one) => one.method),
    writes: () => state.requests.filter((one) => one.method === 'POST' || one.method === 'PUT'),
    setMode: (mode) => {
      state.mode = mode
    },
    close: async () => {
      LIVE.delete(handle)
      for (const socket of sockets) socket.destroy()
      await new Promise((resolve) => server.close(resolve))
    },
  }
  LIVE.add(handle)
  return handle
}

export function clearDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true })
}

// 兜底：用例哪怕在 finally 之前就抛了，也别把假服务和临时目录留在机器上。
// helpers.mjs 自己也会被 `node --test` 当成用例文件跑（test/ 目录下所有文件都算），所以这里也挂一份。
test.after(closeAllFakes)

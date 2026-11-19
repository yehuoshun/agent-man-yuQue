// 测试两道假件：一个只会按剧本吐 JSON 的假 agent-man，一个按 facts.md 形状回话的假语雀。
// 假件一律写在系统临时目录（mkdtemp），用例结束就删；只用假 token，真凭据不进仓库。
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
if (data.fail !== undefined && data.fail !== null) {
  process.stderr.write('! 假 agent-man 照剧本失败\\n')
  process.exit(Number(data.fail))
}
if (argv[0] === 'context' && argv[1] === 'show') {
  process.stdout.write(String(data.context ?? ''))
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

export const SCENARIO_DEFAULT = {
  context: 'agent-man · 2026-11-20 00:16\n\n建议\n  夜深了，不主动说\n',
  memory: {
    items: [
      {
        id: 'm-1',
        key: '她怕冷',
        fact: '空调从来不调 22 度以下',
        imp: 3,
        at: 1795105192643,
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
        at: 1795105192643,
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
    updatedAt: 1795105192799,
    limit: 600,
    over: false,
  },
}

// 造一个假 agent-man：写 scenario.json 当剧本，脚本支持 context show / memory ls / rule ls / self show。
export function makeAgentMan(scenario = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-man-yuque-fake-'))
  const script = path.join(dir, 'fake-agent-man.mjs')
  const file = path.join(dir, 'scenario.json')
  fs.writeFileSync(script, FAKE_SOURCE, 'utf8')
  const api = {
    dir,
    script,
    file,
    set(next) {
      const merged = { ...SCENARIO_DEFAULT, ...api.current, ...next }
      api.current = merged
      fs.writeFileSync(file, JSON.stringify(merged), 'utf8')
    },
    current: {},
  }
  api.set(scenario)
  return api
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8')
      resolve(text === '' ? null : JSON.parse(text))
    })
  })
}

const DEFAULT_TOC = '- type: META\n  version_id: 0\n  count: 0\n  display_level: 1\n  tail_type: UPDATED_AT\n'

// 假语雀：形状照 facts.md 抄（{"meta","data"} 双层、format: markdown、404 是 {status,message} 无 code）。
export async function startYuque(options = {}) {
  const state = {
    docs: new Map(),
    nextId: 1000,
    requests: [],
    repo: { id: 12345678, slug: 'mock-book', namespace: 'mock-user/mock-book', toc_yml: DEFAULT_TOC, public: 0 },
    mode: 'ok',
    repoStatus: null,
    tocStatus: null,
    docStatus: new Map(),
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
      const ns = parts.length > 4 ? `${parts[3]}/${parts[4]}` : ''
      const after = parts.slice(5)

      if (after.length === 0) {
        if (req.method === 'GET') {
          if (state.repoStatus !== null) {
            return send(state.repoStatus, { status: state.repoStatus, message: 'repo' })
          }
          return send(200, { data: state.repo })
        }
        if (req.method === 'PUT') {
          if (state.tocStatus !== null) {
            return send(state.tocStatus, { status: state.tocStatus, message: 'no write' })
          }
          if (body !== null && typeof body.toc === 'string') state.repo.toc_yml = body.toc
          send(200, { data: state.repo })
          return
        }
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

  return {
    base: `http://127.0.0.1:${port}/api/v2`,
    port,
    state,
    docs: state.docs,
    requests: state.requests,
    methods: () => state.requests.map((one) => one.method),
    writes: () => state.requests.filter((one) => one.method === 'POST' || one.method === 'PUT'),
    setMode: (mode) => {
      state.mode = mode
    },
    close: async () => {
      for (const socket of sockets) socket.destroy()
      await new Promise((resolve) => server.close(resolve))
    },
  }
}

export function clearDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true })
}
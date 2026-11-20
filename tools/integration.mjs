// 插件↔本体联调验证（零依赖，零线上副作用）。在插件仓库根跑：
//   AGENT_MAN_REPO=<本体仓库根> node tools/integration.mjs
//   node tools/integration.mjs --only=A,B,C2,F     # 只跑选中的断言（组名/断言名都认）
//
// 纪律：不碰真语雀（假服务只 listen 127.0.0.1:0）、不用真令牌（test-token-not-real）、
// 不读写 ~/.agent-man 与 ~/.agent-man-yuque（每个子进程都显式给 AGENT_MAN_HOME /
// AGENT_MAN_YUQUE_HOME）、不修改两个仓库里的任何文件（只读；临时目录建在插件仓库自己的
// tmp/ 下——已被 .gitignore 覆盖，不进系统临时目录，跑完 finally 里整个删掉）。
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'          // 只给 F4 用：证明临时目录不在系统临时目录里
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { setTimeout as sleep } from 'node:timers/promises'

const HERE = path.dirname(fileURLToPath(import.meta.url))
// 本体仓库按三条线索依次找，都不中就说清楚退 2：
//   1) AGENT_MAN_REPO  2) 兄弟目录 ../agent-man  3) 当前目录自己就是本体仓库
// 默认插件仓库根就是 tools/ 的上一级；AGENT_MAN_YUQUE_REPO 是给「从别处跑同一份 harness」留的口子。
const YQ = process.env.AGENT_MAN_YUQUE_REPO
  ? path.resolve(process.env.AGENT_MAN_YUQUE_REPO)
  : path.resolve(HERE, '..')
const AM = (() => {
  const cands = [process.env.AGENT_MAN_REPO, path.resolve(YQ, '..', 'agent-man'), process.cwd()]
  for (const cand of cands) {
    if (!cand) continue
    const root = path.resolve(cand)
    if (fs.existsSync(path.join(root, 'bin', 'agent-man.mjs'))) return root
  }
  process.stderr.write('! 找不到本体仓库：设 AGENT_MAN_REPO 指到 agent-man 仓库根（含 bin/agent-man.mjs）\n')
  process.exit(2)
})()
const AM_BIN = path.join(AM, 'bin', 'agent-man.mjs')
const YQ_BIN = path.join(YQ, 'bin', 'agent-man-yuQue.mjs')
// 全部临时产物（假零件、假家目录、记录器日志）都生在这一个目录里，跑完全删。
// 落点选插件仓库自己的 tmp/（.gitignore 已覆盖）：不进系统临时目录（工作区约定），
// 也不污染仓库可见树；名字带 pid + 随机后缀，同机两份并发互不相干。
const RUN_TRUNK = path.join(YQ, 'tmp')
fs.mkdirSync(RUN_TRUNK, { recursive: true })
const RUN = fs.mkdtempSync(path.join(RUN_TRUNK, `int-${process.pid}-`))

const NODE = process.execPath
const FAKE_TOKEN = 'test-token-not-real'

// ── 选择器：node integration.mjs --only=A,B,C2,F ───────────────────────────
// 没被选中的断言记 pending（不算失败），这样修前/修后可以分组跑，一条命令仍是全量。
const ONLY = (() => {
  const hit = process.argv.find((one) => one.startsWith('--only='))
  if (hit === undefined) return null
  return hit.slice('--only='.length).split(',').map((one) => one.trim()).filter(Boolean)
})()

function chosen(id) {
  if (ONLY === null) return true
  return ONLY.includes(id) || ONLY.includes(id.charAt(0))
}

// ── 断言账本
// ───────────────────────────────────────────
const R = []
class Fail extends Error {}
class Skip extends Error {}

function record(id, title, status, evidence) {
  R.push({ id, title, status, evidence })
  const tag = status === 'pass' ? 'PASS' : status === 'fail' ? 'FAIL' : status === 'skip' ? 'SKIP' : 'PEND'
  process.stdout.write(`${tag} ${id}  ${title}\n      ${evidence}\n`)
}

async function check(id, title, fn) {
  if (!chosen(id)) return record(id, title, 'pending', '本次未跑：--only 没选它（待修完回归）')
  try {
    const evidence = await fn()
    record(id, title, 'pass', evidence)
  } catch (e) {
    if (e instanceof Skip) return record(id, title, 'skip', e.message)
    record(id, title, 'fail', e instanceof Fail ? e.message : `异常：${e && e.stack ? e.stack.split('\n')[
      0] : e}`)
  }
}

// ── 进程工具
// ────────────────────────────────────────────
function runNode(script, args, { env = {}, cwd, timeout = 20000 } = {}) {
  return new Promise((resolve) => {
    const started = Date.now()
    const child = spawn(NODE, [script, ...args], {
      cwd,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    const out = []
    const err = []
    child.stdout.on('data', (c) => out.push(c))
    child.stderr.on('data', (c) => err.push(c))
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
    }, timeout)
    child.on('close', (code, signal) => {
      clearTimeout(timer)
      resolve({
        code: code ?? (signal ? 128 : 1),
        signal,
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(err).toString('utf8'),
        ms: Date.now() - started,
      })
    })
    child.on('error', (e) => {
      clearTimeout(timer)
      resolve({ code: 127, stdout: '', stderr: String(e && e.message), ms: Date.now() - started })
    })
  })
}

function runAm(homeDir, args, env = {}) {
  return runNode(AM_BIN, args, { env: { AGENT_MAN_HOME: homeDir, ...env } })
}

function runPlugin(args, env = {}, opts = {}) {
  return runNode(YQ_BIN, args, {
    timeout: opts.timeout ?? 20000,
    env: {
      YUQUE_API_BASE: fake.base,
      YUQUE_TOKEN: FAKE_TOKEN,
      YUQUE_API_TOKEN: FAKE_TOKEN,
      YUQUE_NAMESPACE: 'e2e-ns/e2e-book',
      YUQUE_REPO: 'e2e-book',
      AGENT_MAN_YUQUE_HOME: path.join(RUN, 'homes', 'yuque'),
      ...env,
    },
  })
}

function mkdirp(p) {
  fs.mkdirSync(p, { recursive: true })
  return p
}

function freshDir(p) {
  fs.rmSync(p, { recursive: true, force: true })
  return mkdirp(p)
}

function listFiles(dir) {
  const out = []
  const walk = (d, rel) => {
    for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
      const r = rel ? `${rel}/${ent.name}` : ent.name
      if (ent.isDirectory()) walk(path.join(d, ent.name), r)
      else out.push(r)
    }
  }
  if (fs.existsSync(dir)) walk(dir, '')
  return out
}

// 一行报价：半角 × 0.28 + 全角 × 1.0（本体 src/core/cost.mjs，常量 COST_ASCII/COST_WIDE）。
const WIDE_SRC =
  '[\\u1100-\\u115F\\u2E80-\\u303E\\u3041-\\u33FF\\u3400-\\u4DBF\\u4E00-\\u9FFF' +
  '\\uA000-\\uA4CF\\uAC00-\\uD7A3\\uF900-\\uFAFF\\uFE10-\\uFE19\\uFE30-\\uFE6F' +
  '\\uFF00-\\uFF60\\uFFE0-\\uFFE6\\u2600-\\u27BF\\u{1F000}-\\u{1FAFF}]'
const WIDE_RE = new RegExp(WIDE_SRC, 'u')
function lineCost(s) {
  let used = 0
  for (const ch of String(s)) used += WIDE_RE.test(ch) ? 1.0 : 0.28
  return used
}

// ── 假语雀服务
// ──────────────────────────────────────────────
const fake = {
  server: null,
  base: '',
  mode: 'normal', // normal | 429 | 401
  requests: [],
  docs: new Map(), // 已存在的文档路径 → body
  idToSlug: new Map(), // 语雀 updateDoc 用的是 doc_id 不是 slug：id → slug 才能把 PUT 认成哪一篇
  slugToId: new Map(), // 反方向：GET 详情要回 data.id，插件拿它去 PUT
  repoToc: null, // D8-R：GET /repos/{ns}/{repo} 要回的 toc_yml 原文（模拟「已经挂过」）
  seq: 0,
  hitsByPath() {
    const m = new Map()
    for (const r of this.requests) m.set(r.path, (m.get(r.path) ?? 0) + 1)
    return m
  },
  writes() {
    return this.requests.filter((r) => r.method === 'POST' || r.method === 'PUT')
  },
  reset() {
    this.mode = 'normal'
    this.requests = []
    this.docs = new Map()
    this.idToSlug = new Map()
    this.slugToId = new Map()
    this.repoToc = null
    this.seq = 0
  },
}

function json(res, status, body) {
  const text = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) })
  res.end(text)
}

async function startFake() {
  fake.server = http.createServer((req, res) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8')
      const rec = { method: req.method, path: req.url, body, at: Date.now() }
      fake.requests.push(rec)

      if (fake.mode === '429') {
        res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '1' })
        res.end(JSON.stringify({ status: 429, message: 'too many requests' }))
        return
      }
      if (fake.mode === '401') return json(res, 401, { status: 401, message: 'unauthorized' })

      const p = req.url.split('?')[0]
      if (req.method === 'GET') {
        if (fake.docs.has(p)) {
          const slug = p.split('/').pop()
          const raw = fake.docs.get(p)
          let parsed = null
          try {
            parsed = JSON.parse(raw)
          } catch {}
          return json(res, 200, {
            data: {
              id: fake.slugToId.get(slug) ?? 1,
              slug,
              title: parsed?.title ?? slug,
              format: parsed?.format ?? 'markdown',
              body: parsed?.body ?? raw,
              body_html: '',
            },
          })
        }
        // 列表接口：/docs 结尾（不带 slug）→ 空列表，让插件走创建
        if (/\/docs\/?$/.test(p)) return json(res, 200, { data: [] })
        // 查库：GET /repos/{ns}/{repo}（恰好两段）→ 库存在，否则插件会以为命名空间看不见
        if (/\/repos\/[^/]+\/[^/]+$/.test(p)) {
          const data = { slug: p.split('/').pop(), name: p.split('/').pop(), namespace: p.split('/')[3] }
          if (typeof fake.repoToc === 'string') data.toc_yml = fake.repoToc
          return json(res, 200, { data })
        }
        return json(res, 404, { status: 404, message: 'doc not found' })
      }
      if (req.method === 'POST') {
        let parsed = null
        try {
          parsed = JSON.parse(body)
        } catch {}
        // 真实语雀用 payload.slug 建文档并回显 slug；假服务必须照这个来，否则上游拿不到 slug
        const slug = /\/docs\/[^/]+$/.test(p) ? p.split('/').pop() : (parsed?.slug ?? `doc-${++fake.seq}`)
        const stored = `${p.replace(/\/+$/, '')}/${slug}`
        fake.docs.set(stored, body)
        rec.createdSlug = slug
        rec.storedPath = stored
        fake.idToSlug.set(String(fake.seq), slug)
        fake.slugToId.set(slug, fake.seq)
        return json(res, 200, { data: { id: fake.seq, slug, title: parsed?.title ?? slug } })
      }
      if (req.method === 'PUT') {
        const seg = p.split('/').pop()
        const slug = fake.idToSlug.get(seg) ?? seg
        fake.docs.set(`${p.replace(/\/[^/]+$/, '')}/${slug}`, body)
        rec.createdSlug = slug
        return json(res, 200, { data: { slug, id: seg } })
      }
      return json(res, 405, { message: 'method not allowed' })
    })
  })
  await new Promise((resolve) => fake.server.listen(0, '127.0.0.1', resolve))
  const addr = fake.server.address()
  fake.base = `http://127.0.0.1:${addr.port}`
}

function stopFake() {
  return new Promise((resolve) => {
    if (!fake.server) return resolve()
    fake.server.close(() => resolve())
    fake.server = null
  })
}

// ── 假零件 / 假本体 / 包装脚本
// ─────────────────────────────────────────────
function writeCmd(file, scriptFile, extra = '') {
  const text = `@echo off\r\n${extra}"${NODE}" "${scriptFile}" %*\r\n`
  fs.writeFileSync(file, text, 'utf8')
  return file
}

function prepareBins() {
  const slow = mkdirp(path.join(RUN, 'bin', 'slow'))
  const plug = mkdirp(path.join(RUN, 'bin', 'plugin'))
  const rec = mkdirp(path.join(RUN, 'bin', 'rec'))

  // E4：故意睡 3s 的假零件（--describe 与无参都睡）
  const slowJs = path.join(RUN, 'slowtest.mjs')
  fs.writeFileSync(slowJs, [
    "import { setTimeout as sleep } from 'node:timers/promises'",
    'await sleep(3000)',
    "process.stdout.write('慢零件醒了 # e2e slowtest\\n')",
    '',
  ].join('\n'), 'utf8')
  writeCmd(path.join(slow, 'agent-man-slowtest.cmd'), slowJs)

  // C2：记录器假本体 —— 记 argv 到 RECORDER_LOG，然后原样转发真本体
  const recJs = path.join(RUN, 'recorder.mjs')
  fs.writeFileSync(recJs, [
    "import fs from 'node:fs'",
    "import { spawnSync } from 'node:child_process'",
    'const args = process.argv.slice(2)',
    'const log = process.env.RECORDER_LOG',
    "if (log) fs.appendFileSync(log, JSON.stringify(args) + '\\n')",
    'const real = process.env.RECORDER_REAL',
    'if (!real) process.exit(0)',
    'const r = spawnSync(process.execPath, [real, ...args], { stdio: "inherit" })',
    'process.exit(r.status ?? 1)',
    '',
  ].join('\n'), 'utf8')
  writeCmd(path.join(rec, 'agent-man.cmd'), recJs)

  // E2：npm link 在 Windows 上留下的 shim 形状（无扩展名对 parseName 不可见，
  // .mjs 会被 parseName 的「名字里不许有 .」拒掉，所以真实的发现路径只能是 .cmd shim）
  writeCmd(path.join(plug, 'agent-man-yuQue.cmd'), YQ_BIN)

  // E-NEST-R：哨兵假零件 —— 无参模式里再问一次本体 context show。
  // 内层能不能被哨兵挡住，就看它印的那一行（不印全角括号，免得污染 E-NEST 的「不出现嵌套 yuQue 行」判据）。
  const nest = mkdirp(path.join(RUN, 'bin', 'nest'))
  const nestJs = path.join(RUN, 'nesttest.mjs')
  fs.writeFileSync(nestJs, [
    "import { spawnSync } from 'node:child_process'",
    `const real = ${JSON.stringify(AM_BIN)}`,
    // 本体先问 --describe 再抓无参：假零件必须两个都答，否则连描述都过不了（首轮 E-NEST-R 就栽在这）。
    "if (process.argv.includes('--describe')) {",
    "  process.stdout.write(JSON.stringify({ name: 'nesttest'," +
      " desc: '哨兵：内部再问一次本体', section: '同步'," +
      " timeout_ms: 5000, side_effects: false }) + '\\n')",
    '} else {',
    "  const r = spawnSync(process.execPath, [real, 'context', 'show']," +
      " { env: process.env, encoding: 'utf8', timeout: 20000 })",
    "  const out = r.stdout ?? ''",
    "  const nested = out.includes('\\uFF08yuQue\\uFF09') ? '\\u51FA\\u73B0' : '\\u65E0'",
    "  process.stdout.write(`nesttest 内层 exit=${r.status} 内层 yuQue" +
      " 行=${nested} # e2e nesttest\\n`)",
    '}',
    '',
  ].join('\n'), 'utf8')
  writeCmd(path.join(nest, 'agent-man-nesttest.cmd'), nestJs)

  // D9-R：三个假本体 —— 超时 / 炸掉 / （「找不到」用空目录即可）
  const d9 = mkdirp(path.join(RUN, 'bin', 'd9'))
  const slowBodyJs = path.join(RUN, 'slowbody.mjs')
  fs.writeFileSync(slowBodyJs, [
    "import { setTimeout as sleep } from 'node:timers/promises'",
    "await sleep(Number(process.env.E2E_SLOWBODY_MS ?? 21000))",
    "process.stdout.write('agent-man \\u00B7 e2e \\u6162\\u672C\\u4F53\\n')",
    '',
  ].join('\n'), 'utf8')
  writeCmd(path.join(d9, 'agent-man-slowbody.cmd'), slowBodyJs)

  const failBodyJs = path.join(RUN, 'failbody.mjs')
  fs.writeFileSync(failBodyJs, [
    "process.stderr.write('! E2E 本体炸了：原文样本（e2e failbody）\\n')",
    'process.exit(2)',
    '',
  ].join('\n'), 'utf8')
  writeCmd(path.join(d9, 'agent-man-failbody.cmd'), failBodyJs)

  const empty = mkdirp(path.join(RUN, 'bin', 'empty'))

  return { slow, plug, rec, recJs, slowJs, nest, nestJs, d9, slowBodyJs, failBodyJs, empty }
}

// ── F1/F2/F3 静态扫描
// ─────────────────────────────────────────────────────
function repoFiles(dir) {
  return listFiles(dir)
    .filter((f) => !f.startsWith('.git/') && !f.startsWith('node_modules/'))
    .map((f) => path.join(dir, f))
    .filter((f) => fs.statSync(f).isFile())
}

function scanSecrets(dir) {
  // 只抓「疑似真实凭据的字符串字面量」，不抓变量名/错误消息里的 token 字样：
  //   1) key = "长字面量"（key 含 token/secret/password/api_key/bearer）
  //   2) Bearer <长串>
  //   3) 手机号 1[3-9]\d{9}
  //   4) 裸的高熵长字面量（≥24 位十六进制 / ≥32 位 base64 字符）
  // 字面量里出现 test|fake|example|mock|demo|占位|假|${ 视为清晰 mock，放行。
  const mockRe = /(test|fake|example|mock|demo|placeholder|占位|假|\$\{)/i
const ASSIGN_SRC =
  '(token|secret|password|passwd|api_key|apikey|access_key|bearer)[\'"\`\\s]*' +
  '[:=]\\s*[\'"\`]([^\'"\`\\n]{8,})[\'"\`]'
const assignRe = new RegExp(ASSIGN_SRC, 'i')
  const bearerRe = /Bearer\s+([A-Za-z0-9._~+/=-]{12,})/i
  const phoneRe = /(^|[^\d])1[3-9]\d{9}($|[^\d])/
  const hexRe = /['"`]([0-9a-fA-F]{24,})['"`]/
  const b64Re = /['"`]([A-Za-z0-9+/]{32,}={0,2})['"`]/
  const hits = []
  for (const file of repoFiles(dir)) {
    const rel = path.relative(dir, file)
    if (rel === 'package-lock.json') continue
    // tmp/ 是被 .gitignore 覆盖的工作目录（F2 已单独验），里面的 state.json 只有哈希，不算凭据
    if (/^tmp[\\/]/.test(rel)) continue
    let text = ''
    try {
      text = fs.readFileSync(file, 'utf8')
    } catch {
      continue
    }
    const lines = text.split('\n')
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i]
      if (line.trim().startsWith('//') || line.trim().startsWith('*') || line.trim().startsWith('#')) continue
      // hash/digest/sha 的十六进制是摘要，不是凭据
      if (/['"]?(hash|digest|sha256|sha1|checksum)['"]?\s*:/.test(line)) continue
      const m = assignRe.exec(line)
      const b = bearerRe.exec(line)
      const h = hexRe.exec(line)
      const s = b64Re.exec(line)
      if (!m && !b && !h && !s && !phoneRe.test(line)) continue
      const value = m?.[2] ?? b?.[1] ?? h?.[1] ?? s?.[1] ?? line
      const mock = mockRe.test(value) || mockRe.test(line)
      hits.push({ file: rel, line: i + 1, text: line.trim().slice(0, 160), mock })
    }
  }
  return hits
}

// ── 数据准备
// ────────────────────────────────────────────
async function seedHome(homeDir, memoryText) {
  fs.rmSync(homeDir, { recursive: true, force: true })
  mkdirp(homeDir)
  const event = await runAm(homeDir, ['event', 'add', 'E2E 事件：今晚九点做插件联调', '--imp', '2', '--json'])
  if (event.code !== 0) throw new Fail(`seed event add 失败：exit ${event.code} ${event.stderr.trim()}`)
  let eventId = ''
  try {
    eventId = JSON.parse(event.stdout).id
  } catch {}
  const memArgs = ['memory', 'add', memoryText, '--key', '工程·联调', '--json']
  if (eventId) memArgs.push('--from', eventId)
  const mem = await runAm(homeDir, memArgs)
  if (mem.code !== 0) throw new Fail(`seed memory add 失败：exit ${mem.code} ${mem.stderr.trim()}`)
  const note = await runAm(homeDir, ['note', 'add', 'E2E 便条：同步前先跑 dry-run', '--trigger', '下次联调',
    '--json'])
  if (note.code !== 0) throw new Fail(`seed note add 失败：exit ${note.code} ${note.stderr.trim()}`)
  return { eventId, event, mem, note }
}

// 零件那行只有情绪够高才上屏（src/mind/situation.mjs:117-128 的 affect 门：v≥65 且 e≥76），
// 而基线是 (50,60)——所以想验证「零件行真的上了屏」，必须先用本体 CLI 把两轴抬上去。
async function raiseAffect(homeDir) {
  const v = await runAm(homeDir, ['affect', 'set', '愉悦', '80', '--why', 'E2E：验证零件行上屏', '--json'])
  if (v.code !== 0) throw new Fail(`affect set 愉悦 失败：exit ${v.code} ${v.stderr.trim()}`)
  const e = await runAm(homeDir, ['affect', 'set', '精力', '90', '--why', 'E2E：验证零件行上屏', '--json'])
  if (e.code !== 0) throw new Fail(`affect set 精力 失败：exit ${e.code} ${e.stderr.trim()}`)
  let snap = null
  try {
    snap = JSON.parse(e.stdout).snapshot ?? null
  } catch {}
  return `affect 已抬到 v=${snap?.v ?? '?'} e=${snap?.e ?? '?'}（门槛 v≥65 e≥76）`
}

function docSlugOf(rec) {
  if (rec.createdSlug) return rec.createdSlug
  const m = /\/docs\/([^/?]+)/.exec(rec.path)
  if (!m) return null
  const seg = decodeURIComponent(m[1])
  // PUT /docs/{doc_id}：语雀拿 id 更新，不是 slug —— 查 id→slug 表还原成人能认的篇名
  return fake.idToSlug.get(seg) ?? seg
}

// ── 主流程
// ──────────────────────────────────────────
const pluginPresent = fs.existsSync(YQ_BIN)

async function main() {
  await startFake()
  const bins = prepareBins()
  freshDir(path.join(RUN, 'homes'))

  // ============ A. 契约形状（--describe）============
  await check('A1', '--describe 退出 0、stdout 是纯 JSON、五字段齐全', async () => {
    if (!pluginPresent) throw new Skip(`插件 bin 不存在：${YQ_BIN}`)
    const r = await runPlugin(['--describe'])
    if (r.code !== 0) throw new Fail(`exit ${r.code}；stdout=${JSON.stringify(r.stdout.slice(0, 200)
      )} stderr=${JSON.stringify(r.stderr.slice(0, 200))}`)
    let data
    try {
      data = JSON.parse(r.stdout)
    } catch {
      throw new Fail(`JSON.parse 失败；stdout=${JSON.stringify(r.stdout.slice(0, 300))}`)
    }
    const keys = Object.keys(data).sort()
    const want = ['desc', 'name', 'section', 'side_effects', 'timeout_ms'].sort()
    if (JSON.stringify(keys) !== JSON.stringify(want)) throw new Fail(`字段=${keys.join(',')}`)
    return `exit 0；JSON=${JSON.stringify(data)}`
  })

  await check('A2', 'name 恰好是 yuQue（parseName 只认 agent-man- 前缀后那段，且不许有 .）', async () => {
    if (!pluginPresent) throw new Skip('插件不存在')
    const r = await runPlugin(['--describe'])
    const data = JSON.parse(r.stdout)
    if (data.name !== 'yuQue') throw new Fail(`name=${JSON.stringify(data.name)}（要求 "yuQue"）`)
    // 用本体真实 parseName 复核：把名字做成 agent-man-<name>.cmd 形状再扫描
    const scan = await import(pathToFileURL(path.join(AM, 'src', 'parts', 'discover.mjs')).href)
    const hit = scan.scan({ PATH: bins.plug }).find((one) => one.file.includes('yuQue'))
    if (!hit || hit.name !== data.name) throw new Fail(`本体 scan 得到 ${JSON.stringify(hit && hit.name)}`)
    return `--describe name="yuQue"；本体 scan 发现 name="${hit.name}" file=${path.basename(hit.file)}`
  })

  await check('A3', 'timeout_ms 是正数且 ≤ 30000（PART_TIMEOUT_MAX）', async () => {
    if (!pluginPresent) throw new Skip('插件不存在')
    const data = JSON.parse((await runPlugin(['--describe'])).stdout)
    if (!(typeof data.timeout_ms === 'number' && data.timeout_ms > 0)) throw new Fail(
      `timeout_ms=${JSON.stringify(data.timeout_ms)}`)
    if (data.timeout_ms > 30000) throw new Fail(`timeout_ms=${data.timeout_ms} > 30000，本体会夹`)
    return `timeout_ms=${data.timeout_ms}`
  })

  await check('A4', 'desc ≤ 20 字、section 非空', async () => {
    if (!pluginPresent) throw new Skip('插件不存在')
    const data = JSON.parse((await runPlugin(['--describe'])).stdout)
    const len = Array.from(data.desc ?? '').length
    if (len > 20) throw new Fail(`desc=${JSON.stringify(data.desc)}（${len} 字）`)
    if (!data.section || !String(data.section).trim()) throw new Fail(`section=${JSON.stringify(
      data.section)}`)
    return `desc="${data.desc}"（${len} 字）；section="${data.section}"`
  })

  // ============ B. 无参模式 ============
  const bHome = path.join(RUN, 'homes', 'b')
  const yqHome = path.join(RUN, 'homes', 'yuque')
  freshDir(bHome)
  freshDir(yqHome)
  // 无参模式也要能问本体拿数据：给 AGENT_MAN_BIN + 一个灌了一条记忆的临时本体家目录。
  try {
    await seedHome(bHome, 'E2E-B 记忆：无参模式只报状态')
  } catch (e) {
    record('B0', '准备 B 段本体数据', 'fail', e.message)
  }

  const bRequestsBefore = fake.requests.length
  const bRun = pluginPresent
    ? await runPlugin([], { AGENT_MAN_YUQUE_HOME: yqHome, AGENT_MAN_BIN: AM_BIN, AGENT_MAN_HOME: bHome })
    : { code: null, stdout: '', stderr: '插件不存在' }
  const bRequestsAfter = fake.requests.length
  const bWrote = listFiles(yqHome)
  const bLines = bRun.stdout.split('\n').filter((one) => one !== '')
  const bLine = bLines[0] ?? ''

  await check('B1', '无参模式退出 0、只输出一行（\\n 计数 ≤ 1）', async () => {
    if (!pluginPresent) throw new Skip('插件不存在')
    if (bRun.code !== 0) throw new Fail(`exit ${bRun.code}；stdout=${JSON.stringify(bRun.stdout.slice(0,
      200))} stderr=${JSON.stringify(bRun.stderr.slice(0, 300))}`)
    const newlines = (bRun.stdout.match(/\n/g) ?? []).length
    if (newlines > 1) throw new Fail(`stdout 有 ${newlines} 个 \\n：${JSON.stringify(bRun.stdout.slice(0,
      300))}`)
    if (bLine.trim() === '') throw new Fail(`stdout 为空；stderr=${JSON.stringify(bRun.stderr.slice(0, 200
      ))}`)
    return `exit 0；stdout=${JSON.stringify(bRun.stdout.trim())}`
  })

  await check('B2', '无参模式不发任何网络请求（假服务收到 0 条）', async () => {
    if (!pluginPresent) throw new Skip('插件不存在')
    const seen = fake.requests.slice(bRequestsBefore, bRequestsAfter)
    if (seen.length > 0) throw new Fail(`服务端收到 ${seen.length} 条：${seen.map((x
      ) => `${x.method} ${x.path}`).join(' | ')}`)
    return `本次无参调用前后请求数：${bRequestsBefore}→${bRequestsAfter}（0 条新请求）`
  })

  await check('B3', '无参模式不写盘（AGENT_MAN_YUQUE_HOME 空目录无新增）', async () => {
    if (!pluginPresent) throw new Skip('插件不存在')
    if (bWrote.length > 0) throw new Fail(`新增文件：${bWrote.join(', ')}`)
    return `AGENT_MAN_YUQUE_HOME 内文件：${JSON.stringify(bWrote)}`
  })

  await check('B4', '无参那一行 cost ≤ 30（半角×0.28 + 全角×1.0）', async () => {
    if (!pluginPresent) throw new Skip('插件不存在')
    if (!bLine) throw new Fail('没有输出行可算（B1 失败）')
    const c = lineCost(bLine.replace(/\n$/, ''))
    if (c > 30) throw new Fail(`cost=${c.toFixed(2)} > 30；行=${JSON.stringify(bLine)}`)
    return `cost=${c.toFixed(2)} ≤ 30；行=${JSON.stringify(bLine)}`
  })

  await check('B5', '无参那一行不含 \\n、不以 "· " / "- " 开头', async () => {
    if (!pluginPresent) throw new Skip('插件不存在')
    if (!bLine) throw new Fail('没有输出行可检查')
    if (bLine.includes('\n')) throw new Fail('行内还有 \\n')
    if (/^\s*[·-]\s/.test(bLine)) throw new Fail(`行以段格式开头：${JSON.stringify(bLine)}`)
    return `行=${JSON.stringify(bLine)}`
  })

  // ============ C. 数据只走本体 CLI ============
  await check('C1', '插件不直读 ~/.agent-man 下 events/ memory/ rules/', async () => {
    if (!pluginPresent) throw new Skip('插件不存在')
    // 只抓「真的去读本体数据」的代码：注释行跳过；本体数据是 events//memory//rules/ 下的
    // *.jsonl（见 src/store/paths.mjs），所以命中条件=非注释行里出现这些目录段或 .jsonl 文件名，
    // 或者用 fs 读 .agent-man 家目录。允许它把 AGENT_MAN_HOME 原样传给本体 CLI（config.mjs:150 就是这种）。
    const dirPat = /[\\/](events|memory|rules)[\\/]/
    // .jsonl 只是文件名形状：只有同一行还提到本体家目录（.agent-man / AGENT_MAN_HOME）才算
    // 「去读本体数据」；插件自己的测试 helper 把假体调用记进 calls.jsonl 不算（C1 首轮误报就是这条）。
    const jsonlPat = /\.jsonl/
    const homePat = /\.agent-man\b|AGENT_MAN_HOME/
    const readHomePat = /readFile(Sync)?\([^)]*\.agent-man/
    const hits = []
    for (const file of repoFiles(YQ)) {
      if (!/\.(mjs|js|cjs|json|md)$/.test(file)) continue
      const lines = fs.readFileSync(file, 'utf8').split('\n')
      for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i]
        const t = line.trim()
        if (t.startsWith('//') || t.startsWith('*') || t.startsWith('#')) continue
        const jsonlHit = jsonlPat.test(line) && homePat.test(line)
        if (dirPat.test(line) || jsonlHit || readHomePat.test(line)) hits.push(`${path.relative(YQ,
          file)}:${i + 1}: ${t.slice(0, 120)}`)
      }
    }
    if (hits.length > 0) throw new Fail(`命中：\n        ${hits.join('\n        ')}`)
    return `扫描 ${repoFiles(YQ).length} 个文件，0 命中（没有直读 events/ memory/ rules/ *.jsonl 的代码）`
  })

  await check('C2', '插件调本体带 --json（PATH 里放记录器假本体）', async () => {
    if (!pluginPresent) throw new Skip('插件不存在')
    const log = path.join(RUN, 'recorder.log')
    fs.writeFileSync(log, '')
    const recEnv = {
      // 只留记录器目录：否则假本体转发真本体时，真本体 sensing 会把插件再叫一遍（多出 4 条同形状调用）。
      PATH: `${bins.rec}${path.delimiter}${bins.empty}`,
      Path: `${bins.rec}${path.delimiter}${bins.empty}`,
      AGENT_MAN_BIN: bins.recJs,
      RECORDER_LOG: log,
      RECORDER_REAL: AM_BIN,
      AGENT_MAN_HOME: bHome,
    }
    const r = await runPlugin(['sync'], recEnv)
    const lines = fs.readFileSync(log, 'utf8').split('\n').filter(Boolean)
    if (lines.length === 0) {
      throw new Fail(
        `记录器 0 条调用（插件没走 AGENT_MAN_BIN/PATH 调本体）；sync exit ${r.code} stderr=${JSON.stringify(
        r.stderr.slice(0, 300))}`)
    }
    const parsed = lines.map((one) => {
      try {
        return JSON.parse(one)
      } catch {
        return null
      }
    })
    // 收紧（F-3）：每一条本体调用的 argv 都必须以 --json 收尾；不许把 context 与 show 拆成两次调用。
    const bad = parsed.filter((a) => a && a[a.length - 1] !== '--json')
    if (bad.length > 0) throw new Fail(`${bad.length}/${parsed.length} 次调用不是 --json 收尾：${bad.map((
      a) => a.join(' ')).join(' | ')}`)
    const split = parsed.filter((a) => a && a.length === 1 && ['context', 'show'].includes(a[0]))
    if (split.length > 0) throw new Fail(`把 context/show 拆成两次调用了：${split.map((a) => a.join(' ')
      ).join(' | ')}`)
    const ctxCalls = parsed.filter((a) => a && a[0] === 'context')
    if (ctxCalls.length !== 1) throw new Fail(
      `context 调用有 ${ctxCalls.length} 次（期望 1 次 context show --json）：${ctxCalls.map((a) => a.join(' '
      )).join(' | ')}`)
    if (ctxCalls[0].join(' ') !== 'context show --json') throw new Fail(`context 调用形状不对：${ctxCalls[
      0].join(' ')}（期望 context show --json）`)
    return `${parsed.length} 次本体调用，全部 --json 收尾：${parsed.map((a) => a.join(' ')).join(' | ')}`
  })

  // ============ D. upsert 判据与幂等 ============
  const dHome = path.join(RUN, 'homes', 'd')
  let dSeed = null
  const D_MEM1 = 'E2E-D1 记忆：客户偏好周五交付'
  const D_MEM2 = 'E2E-D3 新记忆：验收改到周四'
  const D_MEM3 = 'E2E-D3C 再一条记忆：验收改到周三'
  try {
    dSeed = await seedHome(dHome, D_MEM1)
  } catch (e) {
    record('D0', '准备 D 段数据（本体 CLI 灌入事件/记忆/便条）', 'fail', e.message)
  }
  const dEnv = { AGENT_MAN_HOME: dHome, AGENT_MAN_BIN: AM_BIN, AGENT_MAN_YUQUE_HOME: yqHome }

  let d1 = null
  let memorySlug = null
  let situationSlug = null
  await check('D1', '两篇都不存在 → sync 后 2 个 POST，format=markdown、正文非空', async () => {
    if (!pluginPresent) throw new Skip('插件不存在')
    if (!dSeed) throw new Skip('D 段数据没备好')
    fake.reset()
    const r = await runPlugin(['sync'], dEnv)
    d1 = r
    if (r.code !== 0) throw new Fail(`sync exit ${r.code}；stdout=${JSON.stringify(r.stdout.slice(0, 300)
      )} stderr=${JSON.stringify(r.stderr.slice(0, 400))}`)
    const posts = fake.requests.filter((one) => one.method === 'POST')
    if (posts.length !== 2) throw new Fail(`POST 数=${posts.length}（期望 2）；请求=${fake.requests.map((x
      ) => `${x.method} ${x.path}`).join(' | ')}`)
    for (const p of posts) {
      let body = null
      try {
        body = JSON.parse(p.body)
      } catch {}
      if (!body) throw new Fail(`POST ${p.path} body 不是 JSON：${JSON.stringify(p.body.slice(0, 200))}`)
      if (body.format !== 'markdown') throw new Fail(`POST ${p.path} format=${JSON.stringify(body.format)}`)
      if (!body.body || String(body.body).trim() === '') throw new Fail(`POST ${p.path} 正文为空`)
    }
    for (const p of posts) {
      // 用 payload.slug 认篇：正文互相包含（处境页里也有记忆原文），靠正文分不开
      let payload = null
      try {
        payload = JSON.parse(p.body)
      } catch {}
      const slug = payload?.slug ?? docSlugOf(p)
      if (slug === 'agent-man-memory') memorySlug = slug
      if (slug === 'agent-man-situation') situationSlug = slug
    }
    if (!memorySlug || !situationSlug) throw new Fail(
      `没认出两篇 slug（memory=${memorySlug} situation=${situationSlug}）；POST slug=${posts.map((p
      ) => { try { return JSON.parse(p.body).slug } catch { return '?' } }).join(' | ')}`)
    return `${posts.map((p) => `POST ${p.path} (format=markdown, body ${Buffer.byteLength(p.body)}B)`
      ).join('；')}`
  })

  await check('D2', '紧接着再 sync → 没有新的 POST/PUT（幂等）、exit 0、输出含「一致」', async () => {
    if (!pluginPresent) throw new Skip('插件不存在')
    if (!d1 || d1.code !== 0) throw new Skip('D1 未通过，幂等前提不成立')
    const before = fake.requests.length
    const r = await runPlugin(['sync'], dEnv)
    const after = fake.requests.slice(before)
    const writes = after.filter((one) => one.method === 'POST' || one.method === 'PUT')
    if (writes.length > 0) throw new Fail(`又写了 ${writes.length} 次：${writes.map((x
      ) => `${x.method} ${x.path}`).join(' | ')}`)
    if (r.code !== 0) throw new Fail(`exit ${r.code}；stderr=${JSON.stringify(r.stderr.slice(0, 300))}`)
    // 「一致」类字样：一致 / 没变 / 已是最新 / 无变化 / 相同 / 跳过（“没变，跳过 处境”就是同义表达）
    if (!/一致|没变|已是最新|无变化|相同|跳过/.test(r.stdout + r.stderr)) throw new Fail(
      `输出没有「一致」类字样：${JSON.stringify(r.stdout.slice(0, 300))}`)
    return `第二次 sync 请求 ${after.length} 个、写 0 个；exit 0；stdout=${JSON.stringify(r.stdout.trim(
      ).slice(0, 160))}`
  })

// D3 的期望（lead 2026-11-20 拍板：走「两篇都更新」，不是「只写 memory 那篇」）：
  //   处境页**真的**会渲染「最弱的三条」（code/agent-man-yuQue/src/render.mjs:240），
  //   而最弱那条是从记忆里挑的（render.mjs:132-156 situationCore 里 weakest 只留 {id,text} 并进 core）——
  //   加一条记忆必然把「最弱」换人，处境页内容确实变了，所以重推处境是**正确行为**，不是幂等破了。
  //   幂等由 D2 / D3-B（同一份数据再 sync 一次 → 零请求）钉住；增量语义由 D3-C 的 dry-run 报告钉住。
  //   （lead 明确否决「改用便条」：便条同样会渲染进处境页，换汤不换药。）
  let d3Ok = null
  await check('D3', '加一条记忆后 sync → 处境 + 记忆两篇都更新（处境页含「最弱的三条」，加记忆必然换人）',
    async () => {
    if (!pluginPresent) throw new Skip('插件不存在')
    if (!memorySlug || !situationSlug) throw new Skip(
      `D1 未定位到两篇 slug（memory=${memorySlug} situation=${situationSlug}）`)
    const memArgs = ['memory', 'add', D_MEM2, '--key', '工程·验收', '--json']
    if (dSeed?.eventId) memArgs.push('--from', dSeed.eventId)
    const add = await runAm(dHome, memArgs)
    if (add.code !== 0) throw new Fail(`memory add 失败：exit ${add.code} ${add.stderr.trim()}`)
    const before = fake.requests.length
    const r = await runPlugin(['sync'], dEnv)
    const after = fake.requests.slice(before)
    d3Ok = r
    if (r.code !== 0) throw new Fail(`exit ${r.code}；stderr=${JSON.stringify(r.stderr.slice(0, 300))}`)
    const docWrites = after.filter((one) => (one.method === 'POST' || one.method === 'PUT')
      && /\/docs(\/|$)/.test(one.path))
    const slugs = [...new Set(docWrites.map(docSlugOf))]
    if (docWrites.length !== 2 || !slugs.includes(memorySlug) || !slugs.includes(situationSlug)) {
      const seq = after.map((x) => `${x.method} ${x.path} -> ${x.status ?? '?'}`).join(' | ')
      throw new Fail(`正文写请求 ${docWrites.length} 个、slug=${slugs.join(' | ')
        || '(无)'}（期望恰好两篇：${situationSlug} + ${memorySlug}）；请求序列=${seq}`)
    }
    const sit = docWrites.find((one) => docSlugOf(one) === situationSlug)
    const sitBody = (() => {
      try {
        return JSON.parse(sit.body).body ?? ''
      } catch {
        return ''
      }
    })()
    const hasWeak = sitBody.includes('最弱的三条')
    return `正文写两篇：${docWrites.map((x) => `${x.method} ${x.path}`).join(' | '
      )}；处境正文含「最弱的三条」=${hasWeak ? '是' : '否'}；exit 0`
  })

  // D3-B：真正的增量保护——数据一个字都没动，再 sync 一次必须一个请求都不发（写请求 0 是最低要求）。
  await check('D3-B', '不动任何数据再 sync 一次 → 两篇都零请求（增量保护）', async () => {
    if (!pluginPresent) throw new Skip('插件不存在')
    if (!d3Ok || d3Ok.code !== 0) throw new Skip('D3 未通过，增量前提不成立')
    const before = fake.requests.length
    const r = await runPlugin(['sync'], dEnv)
    const after = fake.requests.slice(before)
    const writes = after.filter((one) => one.method === 'POST' || one.method === 'PUT')
    if (writes.length > 0) throw new Fail(`又写了 ${writes.length} 次：${writes.map((x
      ) => `${x.method} ${x.path}`).join(' | ')}`)
    if (after.length > 0) throw new Fail(`发了 ${after.length} 个请求（期望 0）：${after.map((x
      ) => `${x.method} ${x.path}`).join(' | ')}`)
    if (r.code !== 0) throw new Fail(`exit ${r.code}；stderr=${JSON.stringify(r.stderr.slice(0, 300))}`)
    if (!/没变|跳过|一致|相同/.test(r.stdout + r.stderr)) throw new Fail(
      `输出没说明「没变/跳过」：${JSON.stringify(r.stdout.slice(0, 300))}`)
    return `再 sync：请求 ${after.length} 个、写 ${writes.length} 个；exit 0；stdout=${JSON.stringify(
      r.stdout.trim().slice(0, 160))}`
  })

  // D3-C：加记忆后 --dry-run 只报这两篇会更新——不报「将创建」、不多报第三篇、也不发任何写请求。
  await check('D3-C', '加记忆后 --dry-run 只报这两篇会更新（不多报、不创建、不发写请求）', async () => {
    if (!pluginPresent) throw new Skip('插件不存在')
    if (!d3Ok || d3Ok.code !== 0) throw new Skip('D3 未通过，dry-run 前提不成立')
    const memArgs = ['memory', 'add', D_MEM3, '--key', '工程·验收', '--json']
    if (dSeed?.eventId) memArgs.push('--from', dSeed.eventId)
    const add = await runAm(dHome, memArgs)
    if (add.code !== 0) throw new Fail(`memory add 失败：exit ${add.code} ${add.stderr.trim()}`)
    const before = fake.requests.length
    const r = await runPlugin(['sync', '--dry-run'], dEnv)
    const after = fake.requests.slice(before)
    const writes = after.filter((one) => one.method === 'POST' || one.method === 'PUT')
    if (writes.length > 0) throw new Fail(`dry-run 发了写请求：${writes.map((x) => `${x.method} ${x.path}`
      ).join(' | ')}`)
    if (r.code !== 0) throw new Fail(`exit ${r.code}；stderr=${JSON.stringify(r.stderr.slice(0, 300))}`)
    const lines = r.stdout.split('\n').map((one) => one.trim()).filter(Boolean)
    const will = lines.filter((one) => /^将(更新|创建)/.test(one))
    if (will.some((one) => /^将创建/.test(one))) throw new Fail(
      `报了「将创建」（文档都已存在，期望只更新）：${will.join(' | ')}`)
    if (will.length !== 2) throw new Fail(`报了 ${will.length} 篇要动（期望恰好 2）：${lines.join(' | ')}`)
    for (const want of [situationSlug, memorySlug]) {
      if (!will.some((one) => one.includes(want))) throw new Fail(`报告里没有 ${want}：${will.join(' | ')}`)
    }
    return `--dry-run 只报两篇：${will.join(' | ')}；服务端写请求 ${writes.length} 个`
  })

  await check('D4', '--dry-run：服务端方法集合里没有 POST/PUT、exit 0', async () => {
    if (!pluginPresent) throw new Skip('插件不存在')
    fake.reset()
    if (dSeed) fake.docs.set('/api/v2/repos/e2e-ns/e2e-book/docs/x', '{"body":"旧内容"}')
    const r = await runPlugin(['sync', '--dry-run'], dEnv)
    const methods = [...new Set(fake.requests.map((one) => one.method))]
    const bad = methods.filter((m) => m === 'POST' || m === 'PUT')
    if (bad.length > 0) throw new Fail(`dry-run 仍发写请求：${fake.requests.filter((x
      ) => x.method === 'POST' || x.method === 'PUT').map((x) => `${x.method} ${x.path}`).join(' | ')}`)
    if (r.code !== 0) throw new Fail(`exit ${r.code}；stderr=${JSON.stringify(r.stderr.slice(0, 300))}`)
    return `方法集合=${JSON.stringify(methods)} 无 POST/PUT；exit 0；stdout=${JSON.stringify(
      r.stdout.trim().slice(0, 120))}`
  })

  await check('D5', '429：不重试轰炸（单路径 ≤ 2 次）、exit 非 0、stderr 有明确提示', async () => {
    if (!pluginPresent) throw new Skip('插件不存在')
    fake.reset()
    fake.mode = '429'
    // 用全新的 AGENT_MAN_YUQUE_HOME：否则 state 里哈希没变，sync 会整体跳过、一个请求都不发
    const r = await runPlugin(['sync'], { ...dEnv, AGENT_MAN_YUQUE_HOME: path.join(RUN, 'homes',
      'yuque-429') })
    const hits = fake.hitsByPath()
    const worst = [...hits.entries()].sort((a, b) => b[1] - a[1])[0] ?? ['(无)', 0]
    if (worst[1] === 0) throw new Fail(
      `插件没发出任何请求，429 分支无从验证；exit ${r.code} stderr=${JSON.stringify(r.stderr.slice(0, 300))}`)
    if (worst[1] > 2) throw new Fail(`路径 ${worst[0]} 被请求 ${worst[1]} 次（> 2）`)
    if (r.code === 0) throw new Fail(`exit 0（期望非 0）；stdout=${JSON.stringify(r.stdout.slice(0, 200))}`)
    if (!r.stderr.trim()) throw new Fail(`stderr 为空；exit ${r.code}`)
    return `请求分布=${JSON.stringify(Object.fromEntries(hits))}；exit ${r.code}；stderr=${JSON.stringify(
      r.stderr.trim().slice(0, 200))}`
  })

  await check('D6', '401：提示令牌无效/过期，exit 69（本体 classify: 69=missing）', async () => {
    if (!pluginPresent) throw new Skip('插件不存在')
    fake.reset()
    fake.mode = '401'
    const r = await runPlugin(['sync'], { ...dEnv, AGENT_MAN_YUQUE_HOME: path.join(RUN, 'homes',
      'yuque-401') })
    const msg = r.stdout + r.stderr
    if (r.code !== 69) throw new Fail(`exit ${r.code}（期望 69）；stdout=${JSON.stringify(r.stdout.slice(
      0, 200))} stderr=${JSON.stringify(r.stderr.slice(0, 300))}`)
    if (!/令牌|token|无效|过期/i.test(msg)) throw new Fail(
      `提示里没有「令牌无效/过期」类字样：${JSON.stringify(msg.slice(0, 300))}`)
    return `exit 69；stderr=${JSON.stringify(r.stderr.trim().slice(0, 200))}`
  })

  // ============ E. 真本体 + 真插件 ============
  const eHome = path.join(RUN, 'homes', 'e1')
  const E_MEM = 'E2E-E1 记忆：语雀同步前先跑 dry-run'
  let eSeed = null
  await check('E1', '本体 CLI 灌入一条事件、一条记忆、一条便条（并把情绪抬到建议门槛以上）', async () => {
    try {
      eSeed = await seedHome(eHome, E_MEM)
      eSeed.affect = await raiseAffect(eHome)
    } catch (e) {
      throw new Fail(e.message)
    }
    const files = listFiles(eHome)
    return `${files.join(', ')}；event=${JSON.parse(eSeed.event.stdout).id}；${eSeed.affect}`
  })

  // 联调用环境：PATH 最前面放插件的 .cmd shim（本体 parseName 只认这种形状）
  function partEnv(extra = {}) {
    const dirs = extra.__dirs ?? [bins.plug]
    const joined = `${dirs.join(path.delimiter)}${path.delimiter}${process.env.PATH}`
    const out = {
      AGENT_MAN_HOME: eHome,
      AGENT_MAN_BIN: AM_BIN,
      PATH: joined,
      Path: joined,
      ComSpec: process.env.ComSpec,
      SystemRoot: process.env.SystemRoot,
      PATHEXT: process.env.PATHEXT,
      YUQUE_API_BASE: fake.base,
      YUQUE_TOKEN: FAKE_TOKEN,
      YUQUE_API_TOKEN: FAKE_TOKEN,
      YUQUE_NAMESPACE: 'e2e-ns/e2e-book',
      YUQUE_REPO: 'e2e-book',
      AGENT_MAN_YUQUE_HOME: yqHome,
    }
    for (const [k, v] of Object.entries(extra)) if (k !== '__dirs') out[k] = v
    return out
  }

  // E2-R / E-NEST-R 的前置已在 E1 里做完：本体「建议」段有情绪门（AFFECT_ACTIVE_V=65 /
  // AFFECT_ACTIVE_E=76，见 src/mind/situation.mjs:117-128）。默认 v=50 e=60 会把零件行整段丢掉
  // （stderr: ! 建议 丢：此刻 v=50 e=60，不到 v≥65 且 e≥76，不主动提建议）。E1 用本体 CLI 把两轴
  // 抬到 80/90，这里才验得到「插件那行能上屏」——不是放宽断言，是把门打开。

  await check('E2-R', '自递归已断：PATH 放插件后 context show < 2000ms、屏上出现（yuQue）、--json 仍是一行',
    async () => {
    if (!pluginPresent) throw new Skip('插件不存在')
    if (!eSeed) throw new Skip('E1 未通过')
    const env = partEnv()
    const plain = await runNode(AM_BIN, ['context', 'show'], { env })
    const jr = await runNode(AM_BIN, ['context', 'show', '--json'], { env })
    if (plain.ms >= 2000) {
      throw new Fail(
        `context show 用了 ${plain.ms}ms（期望 < 2000ms，修前 5696ms）；stdout=${JSON.stringify(
        plain.stdout.slice(0, 400))} stderr=${JSON.stringify(plain.stderr.slice(0, 300))}`)
    }
    if (!plain.stdout.includes('（yuQue）')) {
      throw new Fail(`${plain.ms}ms 返回，但屏上没有「（yuQue）」那行；stdout=${JSON.stringify(
        plain.stdout.slice(0, 600))} stderr=${JSON.stringify(plain.stderr.slice(0, 400))}`)
    }
    const rows = jr.stdout.trim().split('\n')
    if (rows.length !== 1) throw new Fail(
      `context show --json 的 stdout 有 ${rows.length} 行（期望恰好 1 行）：${JSON.stringify(jr.stdout.slice(
      0, 300))}`)
    let parsed = null
    try {
      parsed = JSON.parse(jr.stdout)
    } catch (e) {
      throw new Fail(`context show --json 的 stdout 不是合法 JSON：${JSON.stringify(jr.stdout.slice(0,
        300))}（${e.message}）`)
    }
    const hitLine = plain.stdout.split('\n').find((one) => one.includes('（yuQue）')) ?? ''
    return `context show ${plain.ms}ms（修前 5696ms）、命中行=${JSON.stringify(hitLine.trim()
      )}；--json 一行可解析（键=${Object.keys(parsed).join(',')}）`
  })

  await check('E3', 'AGENT_MAN_BIN=真本体 → 插件 sync 发出的正文含 E1 记忆原文', async () => {
    if (!pluginPresent) throw new Skip('插件不存在')
    if (!eSeed) throw new Skip('E1 未通过')
    fake.reset()
    const r = await runPlugin(['sync'], { AGENT_MAN_HOME: eHome, AGENT_MAN_BIN: AM_BIN,
      AGENT_MAN_YUQUE_HOME: yqHome })
    const writes = fake.writes()
    if (writes.length === 0) throw new Fail(
      `服务端没有收到写请求；exit ${r.code}；stderr=${JSON.stringify(r.stderr.slice(0, 400))}`)
    const hit = writes.find((one) => one.body.includes(E_MEM))
    if (!hit) throw new Fail(`写请求正文里没有 E1 记忆原文 "${E_MEM}"；请求=${writes.map((x
      ) => `${x.method} ${x.path} ${x.body.slice(0, 120)}`).join(' | ')}`)
    return `${hit.method} ${hit.path} 正文含记忆原文；写请求共 ${writes.length} 个`
  })

  await check('E4', 'sense(env,{deadline:300}) 在 ~300ms 返回，slowtest 记 dropped/deadline', async () => {
    const senseUrl = pathToFileURL(path.join(AM, 'src', 'parts', 'sense.mjs')).href
    const mod = await import(senseUrl)
    const t0 = Date.now()
    // spawn 的 env 会被整体替换：必须带上 ComSpec/SystemRoot，否则 .cmd 零件会 ENOENT（首轮就踩了这个坑）。
    // PATH 里把慢零件的目录放在最前，后面接原 PATH 保证 cmd.exe/node 可解析。
    const env4 = {
      PATH: `${bins.slow}${path.delimiter}${process.env.PATH}`,
      Path: `${bins.slow}${path.delimiter}${process.env.Path ?? process.env.PATH}`,
      ComSpec: process.env.ComSpec,
      SystemRoot: process.env.SystemRoot,
      PATHEXT: process.env.PATHEXT,
    }
    const got = await mod.sense(env4, { deadline: 300 })
    const ms = Date.now() - t0
    const hit = (got.dropped ?? []).find((one) => one && one.name === 'slowtest')
    if (!hit || hit.reason !== 'deadline') {
      throw new Fail(`dropped=${JSON.stringify(got.dropped)}；failures=${JSON.stringify(got.failures
        )}；${ms}ms`)
    }
    if (ms > 1000) throw new Fail(`返回耗时 ${ms}ms（期望 300ms 量级）`)
    return `${ms}ms 返回；dropped=${JSON.stringify(got.dropped)}；lines=${JSON.stringify(got.lines)}`
  })

  // ============ 修后回归段（对应 REGRESSION.md） ============
  // E-F2-R（修前 F-2：`parts.inject` 有键无消费点，AGENT_MAN_PARTS_INJECT=0 仍 5558ms、插件照跑）
  await check('E-F2-R', 'AGENT_MAN_PARTS_INJECT=0 → 屏上/JSON 里都没有零件行、exit 0、stderr 有说明',
    async () => {
    if (!pluginPresent) throw new Skip('插件不存在')
    if (!eSeed) throw new Skip('E1 未通过')
    const env = partEnv({ AGENT_MAN_PARTS_INJECT: '0' })
    const plain = await runNode(AM_BIN, ['context', 'show'], { env })
    const jr = await runNode(AM_BIN, ['context', 'show', '--json'], { env })
    if (plain.code !== 0) throw new Fail(
      `context show exit ${plain.code}（期望 0）；stderr=${JSON.stringify(plain.stderr.slice(0, 400))}`)
    if (jr.code !== 0) throw new Fail(
      `context show --json exit ${jr.code}（期望 0）；stderr=${JSON.stringify(jr.stderr.slice(0, 400))}`)
    if (plain.stdout.includes('yuQue')) throw new Fail(`关掉注入后屏上还有插件行：${JSON.stringify(
      plain.stdout.slice(0, 600))}`)
    if (jr.stdout.includes('yuQue')) throw new Fail(`关掉注入后 --json 里还有插件：${JSON.stringify(
      jr.stdout.slice(0, 600))}`)
    if (!/零件|注入|parts/i.test(plain.stderr)) throw new Fail(
      `stderr 没有说明为什么没零件：${JSON.stringify(plain.stderr.slice(0, 400))}`)
    const note = plain.stderr.split('\n').find((one) => /零件|注入|parts/i.test(one)) ?? ''
    return `context show ${plain.ms}ms、--json ${jr.ms}ms，都不含 yuQue；stderr 说明=${JSON.stringify(
      note.trim())}`
  })

  // E-NEST-R（修前 F-1 的第二面：外层零件自己再问一次本体，必须被哨兵挡住，不再扫零件）
  await check('E-NEST-R', '哨兵：nesttest 内部调 context show 不再嵌套扫零件（< 2500ms、无嵌套 yuQue 行）',
    async () => {
    if (!pluginPresent) throw new Skip('插件不存在')
    if (!eSeed) throw new Skip('E1 未通过')
    const env = partEnv({ __dirs: [bins.nest, bins.plug] })
    const r = await runNode(AM_BIN, ['context', 'show'], { env })
    if (r.ms >= 2500) throw new Fail(
      `外层 context show 用了 ${r.ms}ms（期望 < 2500ms）；stdout=${JSON.stringify(r.stdout.slice(0, 400))}`)
    if (!r.stdout.includes('# e2e nesttest')) throw new Fail(
      `屏上没有 nesttest 自己的行：${JSON.stringify(r.stdout.slice(0, 600))} stderr=${JSON.stringify(
      r.stderr.slice(0, 400))}`)
    const nest = r.stdout.split('\n').find((one) => one.includes('# e2e nesttest')) ?? ''
    if (!nest.includes('内层 yuQue 行=无')) throw new Fail(`嵌套调用里又发现了插件：${JSON.stringify(
      nest.trim())}（期望「内层 yuQue 行=无」）`)
    if (r.stdout.includes('（yuQue）')) throw new Fail(`外层屏上出现了嵌套的（yuQue）行：${JSON.stringify(
      r.stdout.slice(0, 600))}`)
    return `${r.ms}ms；nesttest 行=${JSON.stringify(nest.trim())}；屏上无（yuQue）`
  })

  // D7-R（修前 F-7：`PUT /repos/{ns}/{repo}` 整棵 toc 全量替换）
  const YQ_NS = '/api/v2/repos/e2e-ns/e2e-book'
  await check('D7-R', 'toc 只追加：首个 sync 发 appendNode、无全量替换；二次 sync 0 请求', async () => {
    if (!pluginPresent) throw new Skip('插件不存在')
    const home = freshDir(path.join(RUN, 'homes', 'd7r'))
    const yqh = freshDir(path.join(RUN, 'homes', 'd7r-yuque'))
    try {
      await seedHome(home, 'E2E-D7R 记忆：toc 只追加')
    } catch (e) {
      throw new Fail(`灌数据失败：${e.message}`)
    }
    fake.reset()
    const env = { AGENT_MAN_HOME: home, AGENT_MAN_BIN: AM_BIN, AGENT_MAN_YUQUE_HOME: yqh }
    const first = await runPlugin(['sync'], env)
    if (first.code !== 0) throw new Fail(`第一次 sync exit ${first.code}；stdout=${JSON.stringify(
      first.stdout.slice(0, 300))} stderr=${JSON.stringify(first.stderr.slice(0, 400))}`)
    const seq = fake.requests.map((one) => `${one.method} ${one.path}`)
    const tocReqs = fake.requests.filter((one) => one.method === 'PUT' && new RegExp(
      `/repos/e2e-ns/e2e-book/toc$`).test(one.path))
    if (tocReqs.length === 0) throw new Fail(`没有 PUT .../toc 请求；请求序列=${seq.join(' | ')}`)
    const bad = tocReqs.map((one) => {
      try {
        return JSON.parse(one.body)
      } catch {
        return null
      }
    }).filter((b) => !b || b.action !== 'appendNode' || b.type !== 'DOC' || !Array.isArray(b.doc_ids))
    if (bad.length > 0) throw new Fail(
      `toc body 形状不对（期望 action=appendNode/type=DOC/doc_ids 数组）：${JSON.stringify(bad)}`)
    const wholeRepl = fake.requests.filter((one) => one.method === 'PUT' && one.path === YQ_NS)
    if (wholeRepl.length > 0) throw new Fail(`出现了整棵替换的 PUT ${YQ_NS}（body=${JSON.stringify((
      wholeRepl[0].body ?? '').slice(0, 200))}）`)
    const before = fake.requests.length
    const second = await runPlugin(['sync'], env)
    const after = fake.requests.length - before
    if (second.code !== 0) throw new Fail(`第二次 sync exit ${second.code}；stderr=${JSON.stringify(
      second.stderr.slice(0, 300))}`)
    if (after !== 0) throw new Fail(`第二次 sync 又发了 ${after} 个请求：${fake.requests.slice(before
      ).map((one) => `${one.method} ${one.path}`).join(' | ')}`)
    const body = JSON.parse(tocReqs[0].body)
    return `首次 ${seq.join(' | ')}；toc body=${JSON.stringify(body)}；二次 sync 新请求 0 个`
  })

  // D8-R（已经挂过的文档不许再挂一遍）
  await check('D8-R', '已挂不重复挂：toc_yml 里已有两个裸 slug → sync 不发任何 toc 请求', async () => {
    if (!pluginPresent) throw new Skip('插件不存在')
    const home = freshDir(path.join(RUN, 'homes', 'd8r'))
    const yqh = freshDir(path.join(RUN, 'homes', 'd8r-yuque'))
    try {
      await seedHome(home, 'E2E-D8R 记忆：已挂过就别再挂')
    } catch (e) {
      throw new Fail(`灌数据失败：${e.message}`)
    }
    fake.reset()
    const mounted = ['agent-man-situation', 'agent-man-memory']
    for (const slug of mounted) fake.docs.set(`${YQ_NS}/docs/${slug}`, '{"title":"旧正文"}')
    fake.repoToc = [
      'META',
      '- title: agent-man 处境',
      '  url: agent-man-situation',
      '  type: DOC',
      '- title: agent-man 记忆',
      '  url: agent-man-memory',
      '  type: DOC',
      '',
    ].join('\n')
    const env = { AGENT_MAN_HOME: home, AGENT_MAN_BIN: AM_BIN, AGENT_MAN_YUQUE_HOME: yqh }
    const r = await runPlugin(['sync'], env)
    if (r.code !== 0) throw new Fail(`sync exit ${r.code}；stdout=${JSON.stringify(r.stdout.slice(0, 300)
      )} stderr=${JSON.stringify(r.stderr.slice(0, 400))}`)
    const tocReqs = fake.requests.filter((one) => /\/toc$/.test(one.path) || one.path === YQ_NS)
    if (tocReqs.length > 0) throw new Fail(`已经挂过却还发了 ${tocReqs.length} 个 toc 请求：${tocReqs.map(
      (one) => `${one.method} ${one.path}`).join(' | ')}`)
    return `toc_yml 已含 ${mounted.join('、')}（裸 slug）；请求=${fake.requests.map((one
      ) => `${one.method} ${one.path}`).join(' | ') || '（无）'}；toc 请求 0 个`
  })

  // D3-R（修前 F-4：context show 首行带分钟时间戳 → 跨分钟必判「内容变了」）
  await check('D3-R', '幂等跨分钟：sync 后跨过整分钟再 sync --dry-run → 「没变，跳过 处境」、0 请求',
    async () => {
    if (!pluginPresent) throw new Skip('插件不存在')
    const home = freshDir(path.join(RUN, 'homes', 'd3r'))
    const yqh = freshDir(path.join(RUN, 'homes', 'd3r-yuque'))
    try {
      await seedHome(home, 'E2E-D3R 记忆：跨分钟别重写')
    } catch (e) {
      throw new Fail(`灌数据失败：${e.message}`)
    }
    fake.reset()
    const env = { AGENT_MAN_HOME: home, AGENT_MAN_BIN: AM_BIN, AGENT_MAN_YUQUE_HOME: yqh }
    const first = await runPlugin(['sync'], env)
    if (first.code !== 0) throw new Fail(`第一次 sync exit ${first.code}；stderr=${JSON.stringify(
      first.stderr.slice(0, 400))}`)
    // 等到下一个整分钟（最多 ~61s）：context show 首行是 `agent-man · YYYY-MM-DD HH:MM`
    const wait = 60000 - (Date.now() % 60000) + 1200
    await sleep(wait)
    fake.reset()
    const second = await runPlugin(['sync', '--dry-run'], env)
    if (second.code !== 0) throw new Fail(`跨分钟 dry-run exit ${second.code}；stdout=${JSON.stringify(
      second.stdout.slice(0, 400))} stderr=${JSON.stringify(second.stderr.slice(0, 400))}`)
    const line = second.stdout.split('\n').find((one) => /处境/.test(one)) ?? ''
    if (!/没变|跳过|一致/.test(second.stdout)) throw new Fail(
      `跨分钟后没有说「没变/跳过」：${JSON.stringify(second.stdout.slice(0, 600))}`)
    if (fake.requests.length !== 0) throw new Fail(
      `cross-minute dry-run 发了 ${fake.requests.length} 个请求：${fake.requests.map((one
      ) => `${one.method} ${one.path}`).join(' | ')}`)
    return `等了 ${wait}ms 跨分钟；dry-run 输出=${JSON.stringify(second.stdout.replace(/\n/g, ' / '
      ).slice(0, 240))}；请求 0 个`
  })

  // D9-R（修前 F-9：本体超时也报 69「没答上来」，与「找不到」混成一个码）
  await check('D9-R', '退出码：本体超时→75（不是 69）、本体找不到→69、本体炸了→69 且带原文', async () => {
    if (!pluginPresent) throw new Skip('插件不存在')
    if (!eSeed) throw new Skip('E1 未通过')
    const base = {
      AGENT_MAN_HOME: eHome,
      YUQUE_API_BASE: fake.base,
      YUQUE_TOKEN: FAKE_TOKEN,
      YUQUE_API_TOKEN: FAKE_TOKEN,
      YUQUE_NAMESPACE: 'e2e-ns/e2e-book',
      YUQUE_REPO: 'e2e-book',
    }
    const fresh = (name) => freshDir(path.join(RUN, 'homes', name))

    const slow = await runPlugin(['sync'], { ...base, AGENT_MAN_YUQUE_HOME: fresh('d9r-slow'),
      AGENT_MAN_BIN: bins.slowBodyJs }, { timeout: 45000 })
    if (slow.code !== 75) throw new Fail(`本体超时 exit ${slow.code}（期望 75）；stderr=${JSON.stringify(
      slow.stderr.slice(0, 400))} stdout=${JSON.stringify(slow.stdout.slice(0, 300))}`)

    const missing = await runPlugin(['sync'], { ...base, AGENT_MAN_YUQUE_HOME: fresh('d9r-missing'),
      PATH: bins.empty, Path: bins.empty, AGENT_MAN_REPO: '', AGENT_MAN_BIN: '' }, { timeout: 30000 })
    if (missing.code !== 69) throw new Fail(
      `本体找不到 exit ${missing.code}（期望 69）；stderr=${JSON.stringify(missing.stderr.slice(0, 400))}`)

    const boom = await runPlugin(['sync'], { ...base, AGENT_MAN_YUQUE_HOME: fresh('d9r-boom'),
      AGENT_MAN_BIN: bins.failBodyJs })
    if (boom.code !== 69) throw new Fail(`本体炸了 exit ${boom.code}（期望 69）；stderr=${JSON.stringify(
      boom.stderr.slice(0, 400))}`)
    if (!boom.stderr.includes('E2E 本体炸了')) throw new Fail(`stderr 里没有本体原文：${JSON.stringify(
      boom.stderr.slice(0, 400))}`)
    return `超时=${slow.code}（${slow.ms}ms）、找不到=${missing.code}、炸了=${boom
      .code} 且 stderr 含原文═${JSON.stringify((boom.stderr.split('\n').find((one) => one.includes(
      'E2E 本体炸了')) ?? '').trim())}`
  })

  // 需要真令牌的线上联调：默认跳过——本 harness 只用 127.0.0.1 假服务，绝不写线上文档。
  await check('LIVE', '真语雀冒烟：需要真令牌，默认跳过', async () => {
    throw new Skip('需要真令牌，默认跳过（要在真语雀上验，请指一个专用测试库人工跑，别用日常库）')
  })

  // ============ F. 隐私与仓库卫生 ============
  await check('F1', '插件仓库无真实令牌/密码/手机号（mock 必须一眼可辨）', async () => {
    if (!fs.existsSync(YQ)) throw new Skip('插件仓库不存在')
    const hits = scanSecrets(YQ)
    const bad = hits.filter((one) => !one.mock)
    if (bad.length > 0) throw new Fail(`可疑命中：\n        ${bad.map((h
      ) => `${h.file}:${h.line}: ${h.text}`).join('\n        ')}`)
    return `扫描 ${repoFiles(YQ).length} 个文件；可疑 0 个${hits.length
      ? `；可辨 mock ${hits.length} 处：${hits.map((h) => `${h.file}:${h.line}`).join('、')}` : ''}`
  })

  await check('F2', '.gitignore 覆盖 node_modules/、tmp/、自己的 state 目录', async () => {
    if (!fs.existsSync(YQ)) throw new Skip('插件仓库不存在')
    const file = path.join(YQ, '.gitignore')
    const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : ''
    const lines = text.split('\n').map((one) => one.trim()).filter(Boolean)
    const checks = {
      'node_modules/': lines.some((l) => /^\/?node_modules\/?$/.test(l)),
      'tmp/': lines.some((l) => /^\/?tmp\/?$/.test(l)),
      state: lines.some((l) => /state|yuque/i.test(l)),
    }
    const missing = Object.entries(checks).filter(([, ok]) => !ok).map(([k]) => k)
    if (missing.length > 0) throw new Fail(`缺少 ${missing.join(', ')}；现有=${JSON.stringify(lines)}`)
    return `现有行=${JSON.stringify(lines)}`
  })

  await check('F3', 'package.json：private/type=module/engines≥20/零依赖/bin 指向真实文件', async () => {
    if (!fs.existsSync(YQ)) throw new Skip('插件仓库不存在')
    const pkgFile = path.join(YQ, 'package.json')
    const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'))
    const problems = []
    if (pkg.private !== true) problems.push(`private=${JSON.stringify(pkg.private)}`)
    if (pkg.type !== 'module') problems.push(`type=${JSON.stringify(pkg.type)}`)
    const eng = String(pkg.engines?.node ?? '')
    const major = Number((/(\d+)/.exec(eng) ?? [])[1])
    if (!(major >= 20)) problems.push(`engines.node=${JSON.stringify(eng)}`)
    if (Object.keys(pkg.dependencies ?? {}).length > 0) problems.push(`dependencies=${JSON.stringify(
      pkg.dependencies)}`)
    if (Object.keys(pkg.devDependencies ?? {}).length > 0) problems.push(
      `devDependencies=${JSON.stringify(pkg.devDependencies)}`)
    const bin = pkg.bin ?? {}
    const targets = typeof bin === 'string' ? [bin] : Object.values(bin)
    if (targets.length === 0) problems.push('没有 bin')
    for (const rel of targets) {
      const target = path.resolve(YQ, rel)
      if (!fs.existsSync(target)) problems.push(`bin 目标不存在：${rel}`)
    }
    if (problems.length > 0) throw new Fail(problems.join('；'))
    return `private=true type=module engines=${eng} 依赖 0 个；bin=${JSON.stringify(bin)} 目标存在`
  })

  await check('F4', 'harness 的临时目录在仓库 tmp/ 内、不落系统临时目录（工作区约定）',
    async () => {
      const trunk = path.resolve(YQ, 'tmp')
      const rel = path.relative(trunk, RUN)
      if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
        throw new Fail(`临时目录不在仓库 tmp/ 内：RUN=${RUN}，期望在 ${trunk} 下`)
      }
      const inSysTmp = path.resolve(RUN).startsWith(path.resolve(os.tmpdir()))
      if (inSysTmp) throw new Fail(`临时目录落在系统临时目录：RUN=${RUN}`)
      // 跑到这里时上一轮的残留应当已被 finally 清掉；有残留说明退出钩子漏了（不判定为失败，只报数）
      const leftovers = fs.existsSync(trunk)
        ? fs.readdirSync(trunk).filter((one) => one.startsWith('int-') && path.join(trunk, one) !== RUN)
        : []
      return `RUN=${path.relative(YQ, RUN)}；不在系统临时目录；tmp/ 里上轮残留 ${leftovers.length} 个`
    })

  // ── 收尾 ──
  await stopFake()
  const counts = {}
  for (const one of R) counts[one.status] = (counts[one.status] ?? 0) + 1
  const bad = R.filter((one) => one.status === 'fail').map((one) => one.id)
  process.stdout.write(
    `\n合计：通过 ${counts.pass ?? 0}，失败 ${counts.fail ?? 0}，跳过 ${counts.skip ?? 0}，待跑 ${counts
    .pending ?? 0}\n`)
  if (bad.length > 0) process.stdout.write(`失败项：${bad.join(', ')}\n`)
  process.exitCode = bad.length > 0 ? 1 : 0
}

// Ctrl-C 或被信号打断时 finally 不一定跑，靠 exit 钩子兜底把 mkdtemp 目录删掉。
process.on('exit', () => fs.rmSync(RUN, { recursive: true, force: true }))
try {
  await main()
} finally {
  await stopFake()
  fs.rmSync(RUN, { recursive: true, force: true })
}

// 编排：先问本体要数据（一律走 CLI，不直接读 ~/.agent-man），渲染成两篇，再决定要不要推。
// 三种用途共用同一套"取数 + 判断落后"：无参的一行、status 的表格、sync 的真实推送。
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { createApi } from './api.mjs'
import { dataHomeOf, fail, requireToken, resolveAgentMan, resolveConfig } from './config.mjs'
import { renderMemory, renderSituation, stampOf } from './render.mjs'
import { hashOf, loadState, saveState } from './state.mjs'

const RUN_TIMEOUT_MS = 20000

function toDate(value) {
  if (value instanceof Date) return value
  if (typeof value === 'number' && Number.isFinite(value)) return new Date(value)
  return new Date()
}

function firstLine(text) {
  const lines = String(text ?? '').split(/\r?\n/).map((one) => one.trim()).filter(Boolean)
  return lines.length === 0 ? '' : lines[0]
}

// 调本体：一条命令一个进程，stdout 只当数据用。
// 退出码契约要分清三件事：本体超时（timeout / 被杀）是 75（超时，不是缺失），
// 本体找不到是 69（依赖缺失），本体自己说不（非 0 且 stderr 有原文）也是 69，但要把原文带上。
export function runAgentMan(bin, args, options = {}) {
  const env = options.env ?? process.env
  const timeoutMs = options.timeoutMs ?? RUN_TIMEOUT_MS
  const bulk = [...bin.prefix, ...args]
  const useShell = process.platform === 'win32' && /\.(cmd|bat)$/i.test(bin.cmd)
  const res = spawnSync(bin.cmd, bulk, {
    encoding: 'utf8',
    timeout: timeoutMs,
    env,
    shell: useShell,
    maxBuffer: 8 * 1024 * 1024,
    windowsHide: true,
  })
  if (res.error !== undefined && res.error !== null) {
    const code = res.error.code ?? ''
    const signal = typeof res.signal === 'string' ? res.signal : ''
    if (code === 'ETIMEDOUT' || res.error.killed === true || signal !== '') {
      throw fail(75, `agent-man 超过 ${timeoutMs}ms 没答上来（${args.join(' ')}）`)
    }
    throw fail(69, `起不来 agent-man（${bin.cmd}）：${code === '' ? res.error.message : code}`)
  }
  const out = typeof res.stdout === 'string' ? res.stdout : ''
  const errText = typeof res.stderr === 'string' ? res.stderr : ''
  if (res.status !== 0) {
    const why = firstLine(errText)
    throw fail(69, `agent-man 说不行（${args.join(' ')}，exit ${res.status}）${why === '' ? '' : `：${why}`}`)
  }
  return { out, err: errText }
}

function jsonOf(bin, args, env) {
  const text = runAgentMan(bin, args, { env }).out.trim()
  try {
    return JSON.parse(text)
  } catch {
    throw fail(69, `agent-man ${args.join(' ')} 没给合法 JSON：${text.slice(0, 80)}`)
  }
}

function readPackageVersion(file) {
  try {
    const doc = JSON.parse(fs.readFileSync(file, 'utf8'))
    return typeof doc.version === 'string' && doc.version !== '' ? doc.version : null
  } catch {
    return null
  }
}

// 版本只用于页脚展示，拿不到就不写这一段——本体没有 --version 开关（探过，exit 2）。
export function agentManVersion(env = process.env, bin = null) {
  const repo = typeof env.AGENT_MAN_REPO === 'string' ? env.AGENT_MAN_REPO.trim() : ''
  if (repo !== '') {
    const fromRepo = readPackageVersion(path.join(repo, 'package.json'))
    if (fromRepo !== null) return fromRepo
  }
  const entry = bin !== null && Array.isArray(bin.prefix) && bin.prefix.length > 0 ? bin.prefix[0] : ''
  if (entry !== '') {
    const guess = readPackageVersion(path.join(path.dirname(path.dirname(entry)), 'package.json'))
    if (guess !== null) return guess
  }
  return null
}

// 取数：四份一律带 --json（形状见 AGENTS.md「数据来源只许走本体 CLI」）。
// 处境曾经取纯文本原样，但那份原文首行是分钟级时间戳（`agent-man · 2026-11-20 00:31`）：
// 拿它当哈希输入等于每分钟"内容变了"，sync 每次都写一遍。改取结构化处境后，
// 时间只进正文、不进哈希（见 render.mjs 的字段判定）。
export function collectSources(env = process.env) {
  const bin = resolveAgentMan(env)
  const scene = jsonOf(bin, ['context', 'show', '--json'], env)
  const memory = jsonOf(bin, ['memory', 'ls', '--json'], env)
  const rules = jsonOf(bin, ['rule', 'ls', '--json'], env)
  const self = jsonOf(bin, ['self', 'show', '--json'], env)
  return { bin, scene, memory, rules, self, home: dataHomeOf(env), version: agentManVersion(env, bin) }
}

// 两篇都从本体现取现渲：哈希只算 core，而 core 只由稳定内容构成（不含生成时刻、页脚、
// 也不含"3h 前 / 夜深了"这类随钟走的文案），否则幂等永远不成立。
export function buildDocs(env = process.env, options = {}) {
  const now = toDate(options.now)
  const cfg = resolveConfig(env, { tokenFile: options.tokenFile })
  const sources = collectSources(env)
  const stamp = stampOf(now)
  const docs = cfg.docs.map((spec) => {
    const common = { stamp, home: sources.home, version: sources.version }
    const rendered = spec.key === 'situation'
      ? renderSituation({ ...common, scene: sources.scene })
      : renderMemory({ ...common, memory: sources.memory, rules: sources.rules, self: sources.self })
    return { ...spec, core: rendered.core, body: rendered.body, hash: hashOf(rendered.core) }
  })
  return { cfg, sources, docs, stamp, now }
}

function judge(doc, state) {
  const prev = state.docs[doc.slug]
  if (prev === undefined) return { stale: true, why: '还没同步过' }
  if (prev.hash !== doc.hash) return { stale: true, why: '内容变了' }
  return { stale: false, why: '一致' }
}

// "多久以前"只给到一位单位：12m / 3h / 2d，够用且省 cost。
export function agoOf(lastAt, now) {
  const at = Date.parse(lastAt)
  if (!Number.isFinite(at)) return null
  const minutes = Math.max(0, Math.round((toDate(now).getTime() - at) / 60000))
  if (minutes < 1) return '刚刚'
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h`
  return `${Math.floor(hours / 24)}d`
}

// "刚刚"是给人读的：后面再补"前"就成了"刚刚 前"，这里统一处置。
export function agoPhrase(ago) {
  if (ago === null) return '刚同步过'
  return ago === '刚刚' ? '刚同步过' : `${ago} 前`
}

// 无参模式：只读一行，不联网、不写盘（读 state.json 只是读，不落笔）。
// 本体骨架会把多行折成一行并加 "· …（yuQue）"，所以这里既不自带前缀也不换行，控制在 ~30 cost。
export function senseLine(env = process.env, options = {}) {
  const now = toDate(options.now)
  const built = buildDocs(env, { now })
  const warnings = []
  const state = loadState(built.cfg.home, (one) => warnings.push(one))
  const changed = built.docs.filter((doc) => judge(doc, state).stale)
  const stale = changed.length
  const ago = state.lastAt === null ? null : agoOf(state.lastAt, now)

  let line
  if (stale === 0) {
    line = `语雀：与本体一致（${agoPhrase(ago)}）`
  } else if (ago === null) {
    line = `语雀：还没同步过，待推送 ${stale} 篇`
  } else {
    const label = stale === built.docs.length ? '处境和记忆' : changed.map((doc) => doc.label).join('、')
    line = `语雀：${label}待推送（${agoPhrase(ago)}）`
  }
  return { line, stale, warnings, cfg: built.cfg, state }
}

// status：纯本地（不联网），把"每篇是否落后"摊开；--json 只出一行。
export function statusView(env = process.env, options = {}) {
  const now = toDate(options.now)
  const built = buildDocs(env, { now })
  const warnings = []
  const state = loadState(built.cfg.home, (one) => warnings.push(one))
  const ago = state.lastAt === null ? null : agoOf(state.lastAt, now)
  const docs = built.docs.map((doc) => {
    const prev = state.docs[doc.slug]
    const verdict = judge(doc, state)
    return {
      key: doc.key,
      label: doc.label,
      slug: doc.slug,
      title: doc.title,
      url: prev === undefined ? null : prev.url,
      hash: doc.hash,
      syncedAt: prev === undefined ? null : prev.syncedAt,
      stale: verdict.stale,
      why: verdict.why,
    }
  })
  const lines = [
    `语雀 · ${built.cfg.namespace}（数据目录 ${built.cfg.home}）`,
    `  上次同步  ${state.lastAt === null ? '还没同步过' : `${state.lastAt}（${agoPhrase(ago)}）`}`,
  ]
  if (state.tocPending === true) lines.push('  目录树    上次没挂上，下次 sync 会补')
  for (const one of docs) {
    lines.push(`  ${one.label}  ${one.slug}  ${one.why}${one.url === null ? '' : `  ${one.url}`}`)
  }
  return { cfg: built.cfg, state, docs, warnings, lines, ago }
}

export function statusJson(view) {
  return JSON.stringify({
    namespace: view.cfg.namespace,
    home: view.cfg.home,
    lastAt: view.state.lastAt,
    tocAt: view.state.tocAt ?? null,
    tocPending: view.state.tocPending === true,
    docs: view.docs,
  })
}

// ---- 目录树 --------------------------------------------------------------
//
// 真实库的 toc_yml 是语雀内部目录（replay 实测，见 docs/yuque-api-facts.md）：
//   - type: META
//     version_id: 0
//     count: 2
//   - type: DOC
//     uuid: …
//     doc_id: 900001
//     level: 1
//     url: agent-man-situation      ← 裸 slug，不是 /ns/slug
// 所以挂树只有一条正路：先读出已有 DOC 节点判重，再 PUT /repos/{ns}/toc 逐条 appendNode。
// 整棵 toc_yml 回写（PUT /repos/{ns} + {toc}）会盖掉别人的内部目录，api.mjs 里已经删掉了。
const KEY_LINE = /^\s*(?:-\s+)?([A-Za-z_][\w-]*):\s*(.*)$/

function scalarOf(text) {
  const one = text.trim()
  if (one.length >= 2 && one.startsWith('"') && one.endsWith('"')) {
    return one.slice(1, -1).replace(/\\"/g, '"')
  }
  if (one.length >= 2 && one.startsWith("'") && one.endsWith("'")) return one.slice(1, -1)
  return one
}

// 只做"读出节点列表"这一件事：读得出就返回节点数组，认不出形状返回 null（调用方据此跳过挂树并说明）。
// 不去理解 YAML 全集——这是语雀自己生成的文本，我们只要 type / doc_id / url 三个字段。
export function tocNodesOf(tocYml) {
  if (tocYml === undefined || tocYml === null || tocYml === '') return []
  if (typeof tocYml !== 'string') return null
  const nodes = []
  let current = null
  for (const raw of tocYml.replace(/\r\n/g, '\n').split('\n')) {
    const line = raw.replace(/\s+$/, '')
    if (line.trim() === '') continue
    const hit = KEY_LINE.exec(line)
    if (hit === null) return null
    if (/^\s*-\s+/.test(line)) {
      current = {}
      nodes.push(current)
    } else if (current === null) {
      return null
    }
    current[hit[1]] = scalarOf(hit[2])
  }
  return nodes
}

// 判重索引：doc_id 或裸 slug，命中任一就算已经在树上。
// 旧实现只认 `/ns/slug`，而真实节点的 url 是裸 slug → 同一篇文档每 sync 一次就多挂一个节点。
// 顺手兼容老写法（/ns/slug）：拿最后一段当 slug 比。
function tocIndex(nodes) {
  const ids = new Set()
  const slugs = new Set()
  for (const node of nodes) {
    if (String(node?.type ?? '').toUpperCase() !== 'DOC') continue
    if (node.doc_id !== undefined && node.doc_id !== '') ids.add(String(node.doc_id))
    if (typeof node.url === 'string' && node.url !== '') {
      slugs.add(node.url)
      slugs.add(node.url.replace(/^\/+/, '').split('/').pop())
    }
  }
  return { ids, slugs }
}

// 还需要挂的文档。节点列表认不出形状时返回 null，由调用方决定"跳过这一趟、下次再挂"。
export function missingTocDocs(nodes, docs) {
  if (nodes === null) return null
  const { ids, slugs } = tocIndex(nodes)
  return docs.filter((doc) => {
    if (doc.id !== null && doc.id !== undefined && ids.has(String(doc.id))) return false
    return !slugs.has(doc.slug)
  })
}

// doc_id 原样留着：语雀的 doc_ids 要的是数字，别在最后一步把 1000 变成 '1000'。
function idValueOf(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '') return value.trim()
  return null
}

// 已经挂过但没记住 id 的文档（上次挂树失败/state 里只记了 slug）：查一次详情补 id。
// 只在这条补挂路径上多发 GET，正文没变的话平时一个请求都不发。
async function docIdOf(api, slug) {
  const found = await api.getDoc(slug)
  const id = found.exists ? idValueOf(found.doc?.id) : null
  if (id === null) throw fail(1, `挂目录树缺 doc_id（${slug}）：语雀详情里没有 id，这一趟只补了正文`)
  return id
}

function pickDocs(all, only) {
  if (only === null || only === undefined) return all
  const hit = all.filter((doc) => doc.key === only)
  if (hit.length === 0) throw fail(64, `--only 只认 situation 或 memory，拿到「${only}」`)
  return hit
}

function dryLine(doc, prev, why) {
  return `将${prev === undefined ? '创建' : '更新'} ${doc.label} → ${doc.slug}（${why}）`
}

// sync：渲染 → 比哈希 → 没变跳过（幂等）→ 变了才 GET 判存在再 POST/PUT。
// 三件事分开记账：正文（hash+syncedAt）、目录树（tocAt/tocPending）、上次同步（lastAt）。
// 之所以要单独记目录树：正文 POST 成功后语雀不会自动挂进左侧树，而挂树是另一次写；
// 缺 repo 写权限时正文能成、树挂不上，下次必须只补树、不重发正文。
export async function syncRun(env = process.env, options = {}) {
  const now = toDate(options.now)
  const built = buildDocs(env, { now, tokenFile: options.tokenFile })
  const cfg = built.cfg
  // 只对真要动的那几篇判哈希：--only 时不该因为另一篇变了就多发请求。
  const docs = pickDocs(built.docs, options.only)
  const dryRun = options.dryRun === true
  const warnings = []
  const state = loadState(cfg.home, (one) => warnings.push(one))
  const report = new Map()
  const planned = []

  for (const doc of docs) {
    const prev = state.docs[doc.slug]
    const verdict = judge(doc, state)
    if (verdict.stale === false) {
      report.set(doc.slug, `没变，跳过 ${doc.label}`)
      continue
    }
    if (dryRun === true) {
      report.set(doc.slug, dryLine(doc, prev, verdict.why))
      continue
    }
    planned.push(doc)
  }
  const linesInOrder = () => docs.map((doc) => report.get(doc.slug)).filter((one) => typeof one === 'string')

  if (dryRun === true) {
    return { code: 0, lines: linesInOrder(), warnings, wrote: 0, cfg, state, stamp: built.stamp }
  }

  // 正文没变、目录树也没欠账：这一趟一个请求都不用发（幂等就是"什么都不做"）。
  const tocOwed = cfg.toc === true && state.tocPending === true
  if (planned.length === 0 && tocOwed === false) {
    state.lastAt = built.stamp
    saveState(cfg.home, state)
    return { code: 0, lines: linesInOrder(), warnings, wrote: 0, cfg, state, stamp: built.stamp }
  }

  const token = requireToken(cfg)
  const api = options.api ?? createApi({
    base: cfg.base,
    namespace: cfg.namespace,
    token,
    timeoutMs: cfg.timeoutMs,
    fetch: options.fetch,
  })
  let wrote = 0
  // 本次写出来的 doc_id：挂树要用它，别再多查一次详情。
  const docIds = new Map()

  for (const doc of planned) {
    const found = await api.getDoc(doc.slug)
    let saved
    if (found.exists) {
      const patch = { title: doc.title, body: doc.body, slug: doc.slug }
      saved = await api.updateDoc(found.doc.slug ?? doc.slug, patch)
      report.set(doc.slug, `已更新 ${doc.label} → ${api.docUrl(doc.slug)}`)
    } else {
      saved = await api.createDoc({ title: doc.title, slug: doc.slug, body: doc.body })
      report.set(doc.slug, `已创建 ${doc.label} → ${api.docUrl(doc.slug)}`)
    }
    const docId = idValueOf(saved?.id ?? found.doc?.id)
    if (docId !== null) docIds.set(doc.slug, docId)
    state.docs[doc.slug] = {
      title: doc.title,
      url: api.docUrl(doc.slug),
      hash: doc.hash,
      syncedAt: built.stamp,
    }
    state.lastAt = built.stamp
    // 每篇写完就落盘：目录树失败或中途断网时，下次不会再重发这两篇正文。
    saveState(cfg.home, state)
    wrote += 1
  }

  // 全部一致也算走了一趟，更新 lastAt（哈希没变，所以下次还是"跳过"）。
  if (wrote === 0) state.lastAt = built.stamp

  // 目录树：只有真动过正文、或上次欠着挂树时才碰它；并且只走 appendNode 增量接口。
  // 403/401 之类挂不上算"部分成功"：正文已经落库、state 照落，下次只重试挂树。
  let tocProblem = null
  const mounted = cfg.docs
    .filter((doc) => state.docs[doc.slug] !== undefined)
    .map((doc) => ({ slug: doc.slug, id: docIds.get(doc.slug) ?? null }))
  const includeToc = cfg.toc === true && mounted.length > 0 && (wrote > 0 || tocOwed === true)
  if (includeToc) {
    try {
      const repo = await api.getRepo()
      const nodes = tocNodesOf(repo.toc_yml)
      if (nodes === null) {
        state.tocPending = true
        warnings.push('库里的 toc_yml 认不出形状（不是节点列表）：这一趟跳过目录树，正文已经写好了')
      } else {
        for (const one of missingTocDocs(nodes, mounted)) {
          await api.appendTocNode(one.id ?? await docIdOf(api, one.slug))
        }
        state.tocPending = false
        state.tocAt = built.stamp
      }
    } catch (e) {
      state.tocPending = true
      tocProblem = e
    }
  }

  saveState(cfg.home, state)
  return {
    code: tocProblem === null ? 0 : 1,
    lines: linesInOrder(),
    warnings,
    wrote,
    cfg,
    state,
    stamp: built.stamp,
    tocProblem,
  }
}
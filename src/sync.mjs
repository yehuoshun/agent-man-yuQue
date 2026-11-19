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

// 调本体：一条命令一个进程，stdout 只当数据用。本体找不到/说不行都算依赖缺失（69）。
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
    if (code === 'ETIMEDOUT' || res.error.killed === true) {
      throw fail(69, `agent-man 超过 ${timeoutMs}ms 没答上来（${args.join(' ')}）`)
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

// 取数：context show 要纯文本原样，其余三份要 --json（形状见 tmp/probe-yuque/facts.md）。
export function collectSources(env = process.env) {
  const bin = resolveAgentMan(env)
  const contextText = runAgentMan(bin, ['context', 'show'], { env }).out
  const memory = jsonOf(bin, ['memory', 'ls', '--json'], env)
  const rules = jsonOf(bin, ['rule', 'ls', '--json'], env)
  const self = jsonOf(bin, ['self', 'show', '--json'], env)
  return { bin, contextText, memory, rules, self, home: dataHomeOf(env), version: agentManVersion(env, bin) }
}

// 两篇都从本体现取现渲：哈希只算 core（不含生成时刻与页脚），否则幂等永远不成立。
export function buildDocs(env = process.env, options = {}) {
  const now = toDate(options.now)
  const cfg = resolveConfig(env, { tokenFile: options.tokenFile })
  const sources = collectSources(env)
  const stamp = stampOf(now)
  const docs = cfg.docs.map((spec) => {
    const common = { stamp, home: sources.home, version: sources.version }
    const rendered = spec.key === 'situation'
      ? renderSituation({ ...common, text: sources.contextText })
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

const YAML_SPECIAL = /^[\s"'-]|[:#{}[\],&*?|<>=!%@`]|\s$/
const YAML_RESERVED = /^(true|false|null|yes|no|on|off|~)$/i

function yamlScalar(text) {
  const value = String(text)
  if (value === '' || YAML_SPECIAL.test(value) || YAML_RESERVED.test(value)) {
    return `"${value.replace(/"/g, '\\"')}"`
  }
  return value
}

// 目录树是全量替换：只在原 toc_yml 上追加缺的节点，META 之类的别人节点原样留着。
// 解析不了（不是字符串）就返回 null，让调用方跳过 toc 并说明，而不是猜着覆盖。
export function mergeToc(existing, { namespace, docs }) {
  if (existing !== undefined && existing !== null && typeof existing !== 'string') return null
  const head = typeof existing === 'string' ? existing.replace(/\r\n/g, '\n').trimEnd() : ''
  const added = docs
    .filter((doc) => head.indexOf(`/${namespace}/${doc.slug}`) === -1)
    .map((doc) => `- title: ${yamlScalar(doc.title)}\n  url: /${namespace}/${doc.slug}`)
  if (added.length === 0) return ''
  return `${head === '' ? '' : `${head}\n`}${added.join('\n')}\n`
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
  const repo = await api.getRepo()
  let wrote = 0

  for (const doc of planned) {
    const found = await api.getDoc(doc.slug)
    if (found.exists) {
      await api.updateDoc(found.doc.slug ?? doc.slug, { title: doc.title, body: doc.body, slug: doc.slug })
      report.set(doc.slug, `已更新 ${doc.label} → ${api.docUrl(doc.slug)}`)
    } else {
      await api.createDoc({ title: doc.title, slug: doc.slug, body: doc.body })
      report.set(doc.slug, `已创建 ${doc.label} → ${api.docUrl(doc.slug)}`)
    }
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

  let tocProblem = null
  const includeToc = cfg.toc === true && (wrote > 0 || tocOwed === true)
  const mounted = cfg.docs.filter((doc) => state.docs[doc.slug] !== undefined)
  if (includeToc) {
    const toc = mergeToc(repo.toc_yml, { namespace: cfg.namespace, docs: mounted })
    if (toc === null) {
      state.tocPending = mounted.length > 0
      warnings.push('库里的 toc_yml 不是字符串，解析不了：这一次跳过目录树，正文已经写好了')
    } else if (toc === '') {
      state.tocPending = false
      state.tocAt = built.stamp
    } else {
      try {
        await api.putToc(toc)
        state.tocPending = false
        state.tocAt = built.stamp
      } catch (e) {
        state.tocPending = true
        tocProblem = e
      }
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
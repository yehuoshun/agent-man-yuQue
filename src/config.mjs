// 配置一律读环境变量：凭据不落盘、不回显，命令行只在必要处覆盖（--token-file）。
// 这里同时负责"这个插件从哪问本体要数据"：AGENT_MAN_BIN → PATH → AGENT_MAN_REPO。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// 没有内置默认库：写死在代码里就是把某个真实账号名钉进公开仓库，还会让"忘了配"变成"往一个
// 你并不想写的地方发请求"。目标库只有两条来路：显式给 YUQUE_NAMESPACE，或沿用 state.json 里
// 记过的上次那个库（只给 status 与无参用：sync 是写操作，目标必须每次都说清）。
export const DEFAULT_NAMESPACE = ''
export const MISSING_NAMESPACE = '没设目标知识库：用 YUQUE_NAMESPACE 指定，形如 登录名/库短名'
// 无参只说一行、不退回 64：本体把零件的无参输出当"答话"，非 0 会被记成插件失败。
export const NO_NAMESPACE_LINE = '语雀：没设目标知识库（YUQUE_NAMESPACE）'
// 基址可覆盖是硬要求：本地假服务、代理、将来换域名都只改环境变量。
export const DEFAULT_BASE = 'https://www.yuque.com/api/v2'
export const DEFAULT_TIMEOUT_MS = 15000

// 两篇文档：标题与 slug 都能被环境变量覆盖，默认值必须稳定（改了就换一篇文档）。
export const DOC_SPECS = [
  {
    key: 'situation',
    label: '处境',
    slug: 'agent-man-situation',
    title: 'agent-man 处境',
    slugEnv: 'AGENT_MAN_YUQUE_SITUATION_SLUG',
    titleEnv: 'AGENT_MAN_YUQUE_SITUATION_TITLE',
  },
  {
    key: 'memory',
    label: '记忆',
    slug: 'agent-man-memory',
    title: 'agent-man 记忆',
    slugEnv: 'AGENT_MAN_YUQUE_MEMORY_SLUG',
    titleEnv: 'AGENT_MAN_YUQUE_MEMORY_TITLE',
  },
]

// 退出码只有四种（design §8）：0 成功 · 64 参数错 · 69 依赖缺失 · 75 超时；其余算 1。
// 用带 exitCode 的普通 Error，是为了让 main 一处收口，不必到处 process.exit。
// kind 是给调用方的判别标记（例如"缺库"要换一句人话），不进 stderr 文案。
export function fail(exitCode, message, kind = null) {
  const e = new Error(message)
  e.exitCode = exitCode
  if (kind !== null) e.kind = kind
  return e
}

function pick(value, fallback) {
  const text = typeof value === 'string' ? value.trim() : ''
  return text === '' ? fallback : text
}

function positiveInt(value, fallback) {
  if (value === undefined || value === null || String(value).trim() === '') return fallback
  const n = Number(String(value).trim())
  if (!Number.isInteger(n) || n <= 0) {
    throw fail(64, `YUQUE_TIMEOUT_MS 要是正整数（毫秒），拿到「${value}」`)
  }
  return n
}

// 语雀的 namespace 就是 "登录名/库 slug"，两段都要能直接拼进 URL 路径。
function checkNamespace(text) {
  const parts = text.split('/')
  if (parts.length !== 2 || parts.some((one) => !/^[A-Za-z0-9_-]{1,64}$/.test(one))) {
    throw fail(64, `YUQUE_NAMESPACE 要写成「登录名/库slug」，拿到「${text}」`)
  }
  return parts
}

function readTokenFile(file) {
  let text
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch (e) {
    throw fail(69, `读不到令牌文件「${file}」（${e.code ?? e.message}）：检查路径，或用 YUQUE_TOKEN`)
  }
  const token = text.trim()
  if (token === '') throw fail(69, `令牌文件「${file}」是空的：里面要有一行语雀令牌`)
  return token
}

// state.json 和自己的数据目录只由环境变量决定，与目标库无关：没设库时也要能先读出
// state.json（里面记着上次跑过的库），所以这一步单独拎出来，别让它跟着 namespace 一起失败。
//
// 优先级：AGENT_MAN_YUQUE_HOME（显式指定）→ 本体数据目录的同级 `agent-man-yuque/` → `~/.agent-man-yuque`。
// 中间那条是为了「本体把数据放在 data/<项目>/」这类布局：插件的数据跟着落在旁边的
// `data/agent-man-yuque/`，不必再让用户去设一个 `AGENT_MAN_` 开头的变量——那个前缀是本体的
// 配置键命名空间，本体见到陌生名字会刷一行「不对应任何配置键」的警告（真机上每次开屏都见）。
export function homeOf(env = process.env) {
  const explicit = pick(env.AGENT_MAN_YUQUE_HOME, '')
  if (explicit !== '') return explicit
  const amHome = pick(env.AGENT_MAN_HOME, '')
  if (amHome !== '') return path.join(path.dirname(path.resolve(amHome)), 'agent-man-yuque')
  return path.join(os.homedir(), '.agent-man-yuque')
}

// 返回一份解析好的配置；任何"参数错"在这里就以 64 抛出去，不留给后面猜。
export function resolveConfig(env = process.env, opts = {}) {
  const base = pick(env.YUQUE_API_BASE, DEFAULT_BASE).replace(/\/+$/, '')
  if (!/^https?:\/\//i.test(base)) {
    throw fail(64, `YUQUE_API_BASE 只认 http:// 或 https:// 开头，拿到「${base}」`)
  }

  // 优先级：环境变量 > 调用方给的"上次跑过的库"（opts.namespace，来自 state.json）> 报错。
  const namespace = pick(env.YUQUE_NAMESPACE, pick(opts.namespace, DEFAULT_NAMESPACE))
  if (namespace === '') throw fail(64, MISSING_NAMESPACE, 'no-namespace')
  const parts = checkNamespace(namespace)

  const home = homeOf(env)
  const tokenFile = pick(opts.tokenFile, '')
  const token = tokenFile === '' ? pick(env.YUQUE_TOKEN, '') : readTokenFile(tokenFile)

  const docs = DOC_SPECS.map((spec) => {
    const slug = pick(env[spec.slugEnv], spec.slug)
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(slug)) {
      throw fail(64, `${spec.slugEnv} 只能用字母数字和 -_（≤64 字符），拿到「${slug}」`)
    }
    return { ...spec, slug, title: pick(env[spec.titleEnv], spec.title) }
  })

  return {
    base,
    namespace,
    nsParts: parts,
    home,
    token,
    tokenFile,
    timeoutMs: positiveInt(env.YUQUE_TIMEOUT_MS, DEFAULT_TIMEOUT_MS),
    docs,
    toc: pick(env.AGENT_MAN_YUQUE_TOC, 'on') !== 'off',
  }
}

// 令牌只在这一处判缺，且绝不把值写进任何消息（隐私红线）。
export function requireToken(cfg) {
  if (cfg.token !== '') return cfg.token
  throw fail(69, '缺语雀令牌：设 YUQUE_TOKEN，或用 --token-file 指一个文件')
}

const WIN_SUFFIX = ['.cmd', '.exe', '.bat']

// PATH 上找 agent-man：Windows 只认可执行后缀（与本体发现零件的口径一致）。
export function findOnPath(name, env = process.env) {
  const dirs = String(env.PATH ?? '').split(path.delimiter).filter(Boolean)
  const exts = process.platform === 'win32' ? ['', ...WIN_SUFFIX] : ['']
  for (const dir of dirs) {
    for (const ext of exts) {
      // Windows 上 "agent-man" 裸名不可执行，但没有后缀也算候选：让后面的 ENOENT 说话。
      const candidate = path.join(dir, `${name}${ext}`)
      try {
        if (fs.statSync(candidate).isFile()) return candidate
      } catch {
        // 不存在就是下一个候选，这不是错误
      }
    }
  }
  return null
}

// 数据来源必须是本体 CLI，不许直接读 ~/.agent-man：那条路会变成第二真源。
export function resolveAgentMan(env = process.env) {
  const bin = pick(env.AGENT_MAN_BIN, '')
  if (bin !== '') {
    // 指到 .mjs/.js 就补一层 node（Windows 上脚本没有执行位，这是唯一稳妥的跑法）。
    if (/\.(mjs|cjs|js)$/i.test(bin)) return { cmd: process.execPath, prefix: [bin], from: 'AGENT_MAN_BIN' }
    return { cmd: bin, prefix: [], from: 'AGENT_MAN_BIN' }
  }
  const found = findOnPath('agent-man', env)
  if (found !== null) return { cmd: found, prefix: [], from: 'PATH' }
  const repo = pick(env.AGENT_MAN_REPO, '')
  if (repo !== '') {
    const entry = path.join(repo, 'bin', 'agent-man.mjs')
    return { cmd: process.execPath, prefix: [entry], from: 'AGENT_MAN_REPO' }
  }
  throw fail(69, '找不到 agent-man：设 AGENT_MAN_BIN、AGENT_MAN_REPO，或把 agent-man 放进 PATH')
}

// 本体的数据目录只用于页脚展示（读了文件就是第二真源，这里只按环境变量复述）。
export function dataHomeOf(env = process.env) {
  return pick(env.AGENT_MAN_HOME, path.join(os.homedir(), '.agent-man'))
}
// 语雀 API 客户端：查库、查文档、建/改正文、写目录树四件事。
// 事实全部按 tmp/probe-yuque/facts.md 钉下来的形状：错误体是 {status,message} 且没有 code 字段，
// 判存在只看 HTTP 状态（200 存在 / 404 不存在），认证头是 X-Auth-Token。
import { fail } from './config.mjs'

const USER_AGENT = 'agent-man-yuQue/0.1 (node; sync)'

// 对外链接固定成语雀的正式域名：YUQUE_API_BASE 只是传输层（本地假服务/代理），不该漏进文档 url。
export function docUrlOf(namespace, slug) {
  return `https://www.yuque.com/${namespace}/${slug}`
}

function statusError(status, data, what) {
  const hasMessage = data !== null && typeof data === 'object' && typeof data.message === 'string'
  const detail = hasMessage ? `：${data.message}` : ''
  if (status === 401) {
    return fail(69, `令牌无效或过期（${what}）：换 YUQUE_TOKEN 或用 --token-file 指一个文件${detail}`)
  }
  if (status === 403) {
    return fail(69, `令牌没这个库的写权限（${what}）：确认 YUQUE_NAMESPACE 指对了、令牌 scope 含 doc 写${detail}`)
  }
  if (status === 429) {
    return fail(1, `语雀限流了（${what}）：这是账号级共享额度，停下等一会儿再同步，别连续重试${detail}`)
  }
  if (status === 404) {
    return fail(69, `库看不见（${what}）：命名空间不存在，或这个令牌看不到它${detail}`)
  }
  return fail(1, `语雀回了 HTTP ${status}（${what}）${detail}`)
}

export function createApi(options) {
  const { base, namespace, token, timeoutMs, fetch: fetchImpl, userAgent = USER_AGENT } = options
  if (typeof token !== 'string' || token === '') throw fail(69, '缺语雀令牌：设 YUQUE_TOKEN，或用 --token-file 指一个文件')
  const root = String(base).replace(/\/+$/, '')
  const nsPath = String(namespace).split('/').map(encodeURIComponent).join('/')
  const doFetch = typeof fetchImpl === 'function' ? fetchImpl : globalThis.fetch

  async function call(method, pathName, payload) {
    const init = {
      method,
      headers: {
        'X-Auth-Token': token,
        'User-Agent': userAgent,
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(timeoutMs),
    }
    if (payload !== undefined) {
      init.headers['Content-Type'] = 'application/json'
      init.body = JSON.stringify(payload)
    }

    let res
    try {
      res = await doFetch(`${root}${pathName}`, init)
    } catch (e) {
      const name = e?.name ?? ''
      if (name === 'TimeoutError' || name === 'AbortError') {
        throw fail(75, `语雀那边超过 ${timeoutMs}ms 没回（${method} ${pathName}）：网络慢或接口卡住，稍后再试`)
      }
      throw fail(1, `连不上语雀（${method} ${pathName}）：${e?.message ?? e}`)
    }

    let text = ''
    try {
      text = await res.text()
    } catch {
      text = ''
    }
    let data = null
    if (text.trim() !== '') {
      try {
        data = JSON.parse(text)
      } catch {
        throw fail(1, `语雀回了不是 JSON 的东西（HTTP ${res.status}，${text.length} 字符，${method} ${pathName}）`)
      }
    }
    return { status: res.status, data }
  }

  function bodyOf(data) {
    return data !== null && typeof data === 'object' && data.data !== null && typeof data.data === 'object'
      ? data.data
      : null
  }

  return {
    namespace,
    docUrl: (slug) => docUrlOf(namespace, slug),

    // 查库：库不可见就直接 69（令牌/命名空间问题不是网络问题）。
    async getRepo() {
      const res = await call('GET', `/repos/${nsPath}`)
      if (res.status !== 200) throw statusError(res.status, res.data, '查库')
      const repo = bodyOf(res.data)
      if (repo === null) throw fail(1, '查库回来的 JSON 里没有 data：语雀接口形状变了？')
      return repo
    },

    // 判存在：200 = 有、404 = 没有；其它状态一律按错误的语义往上抛。
    async getDoc(slug) {
      const res = await call('GET', `/repos/${nsPath}/docs/${encodeURIComponent(slug)}`)
      if (res.status === 404) return { exists: false, doc: null }
      if (res.status !== 200) throw statusError(res.status, res.data, `查文档 ${slug}`)
      return { exists: true, doc: bodyOf(res.data) ?? {} }
    },

    // 创建：POST 之后语雀不会自动把它挂进目录树，toc 要另外写（见 putToc）。
    async createDoc(payload) {
      const res = await call('POST', `/repos/${nsPath}/docs`, {
        title: payload.title,
        slug: payload.slug,
        format: 'markdown',
        body: payload.body,
      })
      if (res.status !== 200 && res.status !== 201) {
        throw statusError(res.status, res.data, `新建文档 ${payload.slug}`)
      }
      return bodyOf(res.data) ?? {}
    },

    // 更新：只带 title/body/format，绝不回写 body_html / body_lake（facts.md §7）。
    async updateDoc(id, payload) {
      const res = await call('PUT', `/repos/${nsPath}/docs/${encodeURIComponent(id)}`, {
        title: payload.title,
        format: 'markdown',
        body: payload.body,
      })
      if (res.status !== 200) throw statusError(res.status, res.data, `更新文档 ${payload.slug}`)
      return bodyOf(res.data) ?? {}
    },

    // 目录树：全量替换接口，所以必须先把原值拼进来再发（facts.md §10）。
    async putToc(toc) {
      const res = await call('PUT', `/repos/${nsPath}`, { toc })
      if (res.status !== 200 && res.status !== 204) throw statusError(res.status, res.data, '写目录树')
      return true
    },
  }
}
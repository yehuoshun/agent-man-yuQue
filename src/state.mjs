// state.json 只记"我们写过什么"：每篇文档的 slug / url / 内容哈希 / 同步时刻，
// 外加一条 namespace——它是"上次真的往哪个库写过"的凭据，status 与无参靠它沿用，
// 免得没设 YUQUE_NAMESPACE 时只能报错（sync 不靠它：写操作的目标每次都得明说）。
// 写盘必须原子（tmp → fsync → rename）：半份 state 会让下次同步以为内容没变而跳过。
import fs from 'node:fs'
import path from 'node:path'
import { createHash, randomBytes } from 'node:crypto'

export function hashOf(text) {
  return createHash('sha256').update(String(text), 'utf8').digest('hex')
}

export function emptyState() {
  return { docs: {}, lastAt: null, tocAt: null, tocPending: false, namespace: null }
}

export function statePath(home) {
  return path.join(home, 'state.json')
}

// 坏掉的 state.json 不该让插件崩：当空状态继续跑，用 "! " 说明白（下次同步会把它们重发一轮）。
export function loadState(home, warn = () => {}) {
  const file = statePath(home)
  let text
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch (e) {
    if (e.code !== 'ENOENT') warn(`state.json 读不出来（${e.code ?? e.message}）：这一次当没有同步记录`)
    return emptyState()
  }
  let doc
  try {
    doc = JSON.parse(text)
  } catch {
    warn('state.json 不是合法 JSON：这一次当没有同步记录，同步成功后会整份重写')
    return emptyState()
  }
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) {
    warn('state.json 形状不对（不是对象）：这一次当没有同步记录')
    return emptyState()
  }
  const raw = doc.docs !== null && typeof doc.docs === 'object' && !Array.isArray(doc.docs) ? doc.docs : {}
  const docs = {}
  for (const [slug, one] of Object.entries(raw)) {
    // 少一个 hash 就等于没记过：宁可重发一次，也不拿半条记录去跳过。
    if (one === null || typeof one !== 'object' || typeof one.hash !== 'string') continue
    docs[slug] = {
      title: typeof one.title === 'string' ? one.title : '',
      url: typeof one.url === 'string' ? one.url : '',
      hash: one.hash,
      syncedAt: typeof one.syncedAt === 'string' ? one.syncedAt : null,
    }
  }
  return {
    docs,
    lastAt: typeof doc.lastAt === 'string' ? doc.lastAt : null,
    // 目录树是另一次写，必须单独记账：正文成功、树没挂上时下次只补树、不重发正文。
    tocAt: typeof doc.tocAt === 'string' ? doc.tocAt : null,
    tocPending: doc.tocPending === true,
    // 老 state.json 没有这一条（那时库名钉在代码里）：读成 null，交给上层决定要不要报错。
    namespace: typeof doc.namespace === 'string' && doc.namespace !== '' ? doc.namespace : null,
  }
}

// 原子写：先写同目录的临时文件并 fsync，再 rename 覆盖——断电时要么旧的完整，要么新的完整。
export function saveState(home, state) {
  fs.mkdirSync(home, { recursive: true })
  const file = statePath(home)
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
  const text = `${JSON.stringify(state, null, 2)}\n`
  const fd = fs.openSync(tmp, 'w')
  try {
    fs.writeFileSync(fd, text, 'utf8')
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }
  fs.renameSync(tmp, file)
}
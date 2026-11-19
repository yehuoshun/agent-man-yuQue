// 配置与"从哪问本体要数据"的约束：基址只认 http(s)、命名空间要两段、令牌只在必需处判缺。
// 这些错都算参数错（64）或依赖缺失（69），不许混成 1。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DEFAULT_NAMESPACE, findOnPath, requireToken, resolveAgentMan, resolveConfig } from '../src/index.mjs'
import { clearDir, closeAllFakes } from './helpers.mjs'

const HOME = path.join(os.tmpdir(), 'agent-man-yuque-cfg')
const ENV = { YUQUE_TOKEN: 'mock-token-123', AGENT_MAN_YUQUE_HOME: HOME }

// 这个文件不启假服务，但兜底关一次：以后有人往这里加真请求的用例，句柄也不会漏。
test.after(closeAllFakes)

test('默认值照产品语义：库 mock-book、基址 api/v2、家目录 .agent-man-yuque', () => {
  const cfg = resolveConfig({ ...ENV }, {})
  assert.equal(cfg.namespace, DEFAULT_NAMESPACE)
  assert.equal(cfg.namespace, 'mock-user/mock-book')
  assert.equal(cfg.base, 'https://www.yuque.com/api/v2')
  assert.equal(cfg.docs.length, 2)
  assert.deepEqual(cfg.docs.map((one) => one.slug), ['agent-man-situation', 'agent-man-memory'])
  assert.deepEqual(cfg.docs.map((one) => one.title), ['agent-man 处境', 'agent-man 记忆'])
  assert.equal(cfg.home, ENV.AGENT_MAN_YUQUE_HOME)
})

test('基址只认 http:// 或 https://，别的一律 64（不许静默退回默认）', () => {
  for (const bad of ['ftp://x/y', 'www.yuque.com/api/v2', 'file:///c:/x']) {
    assert.throws(() => resolveConfig({ ...ENV, YUQUE_API_BASE: bad }, {}), (e) => e.exitCode === 64)
  }
  // http 是给本地假服务和代理留的，必须照用，不许因为不是 https 就改掉。
  const local = resolveConfig({ ...ENV, YUQUE_API_BASE: 'http://127.0.0.1:4010/api/v2/' }, {})
  assert.equal(local.base, 'http://127.0.0.1:4010/api/v2', '末尾斜杠要去掉')
})

test('命名空间要「登录名/库slug」两段，写成一段或三段都是 64', () => {
  for (const bad of ['mock-book', 'a/b/c', '/mock-book', 'ye huoshun/mock-book']) {
    assert.throws(() => resolveConfig({ ...ENV, YUQUE_NAMESPACE: bad }, {}), (e) => e.exitCode === 64)
  }
  assert.equal(resolveConfig({ ...ENV, YUQUE_NAMESPACE: 'someone/lib_1' }, {}).nsParts.length, 2)
})

test('两篇的 slug 与标题都能被环境变量覆盖（改了就换一篇文档，不覆盖别人的）', () => {
  const cfg = resolveConfig({
    ...ENV,
    AGENT_MAN_YUQUE_SITUATION_SLUG: 'my-situation',
    AGENT_MAN_YUQUE_MEMORY_TITLE: '我的记忆',
  }, {})
  assert.equal(cfg.docs[0].slug, 'my-situation')
  assert.equal(cfg.docs[1].title, '我的记忆')
  assert.throws(() => resolveConfig({ ...ENV, AGENT_MAN_YUQUE_MEMORY_SLUG: '带空格 的' }, {}),
    (e) => e.exitCode === 64)
})

test('令牌：环境变量优先，--token-file 逐次读文件，缺了才判 69，且绝不回显值', () => {
  assert.equal(requireToken(resolveConfig({ ...ENV }, {})), 'mock-token-123')

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-man-yuque-token-'))
  try {
    const file = path.join(dir, 'token.txt')
    fs.writeFileSync(file, '  mock-token-from-file\n', 'utf8')
    const cfg = resolveConfig({ ...ENV, YUQUE_TOKEN: '' }, { tokenFile: file })
    assert.equal(cfg.token, 'mock-token-from-file', '文件里的首尾空白要去掉')

    // 文件不存在 / 是空的：都是依赖缺失，且消息里只提路径，不提内容。
    assert.throws(() => resolveConfig({ ...ENV, YUQUE_TOKEN: '' }, { tokenFile: path.join(dir, 'nope.txt') }),
      (e) => e.exitCode === 69 && e.message.includes('nope.txt'))
    const empty = path.join(dir, 'empty.txt')
    fs.writeFileSync(empty, '\n', 'utf8')
    assert.throws(() => resolveConfig({ ...ENV, YUQUE_TOKEN: '' }, { tokenFile: empty }),
      (e) => e.exitCode === 69)

    const missing = resolveConfig({ ...ENV, YUQUE_TOKEN: '' }, {})
    assert.equal(missing.token, '')
    assert.throws(() => requireToken(missing), (e) => e.exitCode === 69 && e.message.includes('YUQUE_TOKEN'))
  } finally {
    clearDir(dir)
  }
})

test('找本体：AGENT_MAN_BIN 优先，其次 PATH，再次 AGENT_MAN_REPO，都没有才 69', () => {
  const bin = resolveAgentMan({ AGENT_MAN_BIN: 'C:\\fake\\agent-man.cmd' })
  assert.equal(bin.cmd, 'C:\\fake\\agent-man.cmd')
  assert.equal(bin.from, 'AGENT_MAN_BIN')

  // 指到 .mjs 要补一层 node：Windows 上脚本本身没有执行位。
  const script = resolveAgentMan({ AGENT_MAN_BIN: 'C:\\fake\\agent-man.mjs' })
  assert.equal(script.cmd, process.execPath)
  assert.deepEqual(script.prefix, ['C:\\fake\\agent-man.mjs'])

  const viaRepo = resolveAgentMan({ AGENT_MAN_REPO: 'C:\\fake\\repo' })
  assert.equal(viaRepo.from, 'AGENT_MAN_REPO')
  assert.deepEqual(viaRepo.prefix, [path.join('C:\\fake\\repo', 'bin', 'agent-man.mjs')])

  assert.throws(() => resolveAgentMan({ PATH: '' }),
    (e) => e.exitCode === 69 && e.message.includes('AGENT_MAN_BIN'))
})

test('PATH 上找 agent-man：找不到返回 null，找到必须是文件', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-man-yuque-path-'))
  try {
    assert.equal(findOnPath('agent-man', { PATH: dir }), null)
    const name = process.platform === 'win32' ? 'agent-man.cmd' : 'agent-man'
    const file = path.join(dir, name)
    fs.writeFileSync(file, 'x', 'utf8')
    assert.equal(findOnPath('agent-man', { PATH: dir }), file)
  } finally {
    clearDir(dir)
  }
})
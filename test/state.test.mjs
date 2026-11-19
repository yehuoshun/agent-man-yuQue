// state.json 是幂等的唯一依据：写要原子（tmp → fsync → rename），坏掉不许把插件带崩。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { emptyState, hashOf, loadState, saveState, statePath } from '../src/index.mjs'
import { clearDir, closeAllFakes } from './helpers.mjs'

function tempHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agent-man-yuque-state-'))
}

// 不启假服务也挂一次兜底：句柄泄漏比断言失败更难查。
test.after(closeAllFakes)

test('哈希对同一段正文稳定，改一个字就变（幂等靠它判）', () => {
  assert.equal(hashOf('同内容'), hashOf('同内容'))
  assert.notEqual(hashOf('同内容'), hashOf('同内容 '))
  assert.match(hashOf('x'), /^[0-9a-f]{64}$/)
})

test('没有 state.json 就是空状态，且不吭声（首次同步的常态）', () => {
  const home = tempHome()
  try {
    assert.deepEqual(loadState(home), emptyState())
  } finally {
    clearDir(home)
  }
})

test('坏掉的 state.json 当空状态继续跑，并用一句 "! " 说明白（不许崩）', () => {
  const home = tempHome()
  try {
    fs.mkdirSync(home, { recursive: true })
    const notes = []
    fs.writeFileSync(statePath(home), '{ 这不是 json', 'utf8')
    assert.deepEqual(loadState(home, (one) => notes.push(one)), emptyState())
    assert.equal(notes.length, 1)
    assert.ok(notes[0].includes('state.json'))

    fs.writeFileSync(statePath(home), '[]', 'utf8')
    const notes2 = []
    assert.deepEqual(loadState(home, (one) => notes2.push(one)), emptyState())
    assert.equal(notes2.length, 1)
  } finally {
    clearDir(home)
  }
})

test('缺 hash 的记录被丢掉：宁可重发一次，也不拿半条记录去跳过', () => {
  const home = tempHome()
  try {
    fs.mkdirSync(home, { recursive: true })
    fs.writeFileSync(statePath(home), JSON.stringify({
      lastAt: '2026-11-20T00:31:12+08:00',
      docs: {
        'agent-man-situation': { title: 't', url: 'u', hash: 'abc', syncedAt: 'now' },
        'agent-man-memory': { title: 't', url: 'u' },
      },
    }), 'utf8')
    const state = loadState(home)
    assert.equal(state.lastAt, '2026-11-20T00:31:12+08:00')
    assert.deepEqual(Object.keys(state.docs), ['agent-man-situation'])
  } finally {
    clearDir(home)
  }
})

test('写盘是原子的：写完读回来一模一样，且目录里不留 .tmp 残片', () => {
  const home = tempHome()
  try {
    const state = {
      docs: { 'agent-man-situation': { title: 't', url: 'u', hash: 'abc', syncedAt: 's' } },
      lastAt: '2026-11-20T00:31:12+08:00',
      tocAt: null,
      tocPending: false,
    }
    saveState(home, state)
    assert.deepEqual(loadState(home), state)
    const left = fs.readdirSync(home).filter((one) => one.endsWith('.tmp'))
    assert.deepEqual(left, [], '临时文件必须已经 rename 掉')

    // 再写一次（覆盖）也要稳：同一路径不许报 EEXIST。
    saveState(home, { docs: {}, lastAt: null })
    assert.deepEqual(loadState(home), emptyState())
  } finally {
    clearDir(home)
  }
})
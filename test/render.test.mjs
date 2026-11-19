// 渲染约束：处境必须逐字照抄本体纯文本（不重排），记忆必须标出字段来自哪条命令；
// core（参与幂等哈希的那部分）不许含生成时刻——否则每次渲染都"变了"，幂等就是假的。
import test from 'node:test'
import assert from 'node:assert/strict'
import { hashOf, renderMemory, renderSituation, stampOf } from '../src/index.mjs'

const HOME = 'C:\\fake\\agent-man'
const VERSION = '0.1.0-fake'

test('处境正文逐字包含 context show 的原文（含缩进与空行，不重排）', () => {
  const text = 'agent-man · 2026-11-20 00:16\n\n建议\n  夜深了，不主动说\n'
  const stamp = stampOf(new Date('2026-11-20T00:31:12+08:00'))
  const out = renderSituation({ text, stamp, home: HOME, version: VERSION })
  assert.ok(out.body.includes('建议\n  夜深了，不主动说'), '缩进要原样保留')
  assert.ok(out.body.includes('agent-man · 2026-11-20 00:16'))
  assert.ok(out.body.includes(HOME), '页脚要写数据目录')
  assert.ok(out.body.includes(VERSION), '页脚要写 agent-man 版本')
})

test('处境与记忆的 core 不含生成时刻：换一个 now 哈希不变（幂等的前提）', () => {
  const morning = { stamp: stampOf(new Date('2026-11-20T09:00:00+08:00')), home: HOME, version: VERSION }
  const evening = { stamp: stampOf(new Date('2026-11-20T21:00:00+08:00')), home: HOME, version: VERSION }
  const a = renderSituation({ text: '一样的正文', ...morning })
  const b = renderSituation({ text: '一样的正文', ...evening })
  assert.notEqual(a.body, b.body, '正文本身该带生成时刻')
  assert.equal(hashOf(a.core), hashOf(b.core), 'core 必须稳定，否则永远重发')
})

test('记忆正文把三块都标出来源，并排成可读的表', () => {
  const out = renderMemory({
    memory: {
      items: [{
        key: '她怕冷',
        fact: '空调不低于 22 度',
        at: 1795105192643,
        evidence: { ids: ['e-1', 'e-2'] },
      }],
    },
    rules: { items: [{ text: '夜里十一点后不提工作', why: '她只回了个嗯', at: 1795105192643 }] },
    self: { text: '## 2026-11-19\n我是她的搭子。\n' },
    stamp: stampOf(new Date('2026-11-20T00:31:12+08:00')),
    home: HOME,
    version: VERSION,
  })
  assert.ok(out.body.includes('agent-man memory ls --json'), '要写清结论字段来自哪条命令')
  assert.ok(out.body.includes('agent-man rule ls --json'))
  assert.ok(out.body.includes('agent-man self show --json'))
  assert.ok(out.body.includes('| 槽位 | 事实 | 证据 | 何时 |'))
  assert.ok(out.body.includes('| 规矩 | 为什么 | 何时 |'))
  assert.ok(out.body.includes('她怕冷'))
  assert.ok(out.body.includes('2 条'), '证据要知道是几条事件')
  assert.ok(out.body.includes('我是她的搭子'), '自我块原文要照抄')
})

test('记忆里的事实含竖线也不许把表格切开（转义掉）', () => {
  const out = renderMemory({
    memory: { items: [{ key: 'a|b', fact: 'x | y', at: 1795105192643 }] },
    rules: { items: [] },
    self: { text: '' },
    stamp: '2026-11-20T00:31:12+08:00',
    home: HOME,
    version: null,
  })
  assert.ok(out.body.includes('a\\|b'))
  assert.ok(out.body.includes('x \\| y'))
  assert.ok(!out.body.includes('| a|b |'), '没转义就多出一列')
})

test('空本体也能渲出可读的两篇（不崩、不留半个表头）', () => {
  const empty = renderMemory({
    memory: { items: [] },
    rules: { items: [] },
    self: { text: '' },
    stamp: '2026-11-20T00:31:12+08:00',
    home: HOME,
    version: null,
  })
  assert.ok(empty.body.includes('（本体里还没有活着的结论）'))
  assert.ok(empty.body.includes('（本体里还没有活着的规矩）'))
  assert.ok(empty.body.includes('（自我块还是空的）'))
  assert.ok(empty.body.includes(HOME), '拿不到版本也照样写页脚')
})
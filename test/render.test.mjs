// 渲染用例：正文给人看（允许带时刻），core 给哈希看（一个字都不许跟时间走）。
// 幂等的根就在这里：只要 core 里混进一次 now 派生字段，sync 就永远"内容变了"。
import test from 'node:test'
import assert from 'node:assert/strict'
import { hashOf, renderMemory, renderSituation, situationCore, stampOf } from '../src/index.mjs'
import { SCENE_AT, sceneOf } from './helpers.mjs'

const HOME = 'C:\\fake\\agent-man'
const VERSION = '0.1.0-fake'
const STAMP = stampOf(new Date(Date.parse('2026-11-20T00:31:12+08:00')))

const MEMORY = {
  items: [
    {
      id: 'm-1',
      key: '她怕冷',
      fact: '空调从来不调 22 度以下',
      at: SCENE_AT,
      evidence: { ids: ['e-1', 'e-2'] },
    },
  ],
}

const RULES = {
  items: [{ id: 'r-1', at: SCENE_AT, text: '夜里十一点后不提工作', why: '提了她只回了个嗯' }],
}

const SELF = { text: '## 2026-11-19\n我是她的搭子，不是她的老板。\n' }

function situation(scene, stamp = STAMP) {
  return renderSituation({ scene, stamp, home: HOME, version: VERSION })
}

function memory(patch = {}, stamp = STAMP) {
  const parts = { memory: MEMORY, rules: RULES, self: SELF, stamp, ...patch }
  return renderMemory({ ...parts, home: HOME, version: VERSION })
}

test('处境正文：五块都在，抬头写清此刻、静默与积压', () => {
  const { body } = situation(sceneOf())
  assert.ok(body.includes('## 此刻'), '要有此刻这一段')
  assert.ok(body.includes('- 此刻：2026-11-20 00:31'), '此刻是绝对时刻，不是"刚刚"')
  assert.ok(body.includes('夜深了'), '静默时段要说人话')
  assert.ok(body.includes('上次开口：3 小时前（之后 2 条新记忆）'), '上次开口要带相对文案')
  assert.ok(body.includes('积压：2 条待巩固'), '积压要上屏')
  assert.ok(body.includes('## 日程') && body.includes('交房租'), '日程要上屏')
  assert.ok(body.includes('（明天 10:00）'), '剩余时间只在正文里')
  assert.ok(body.includes('## 便条') && body.includes('（等：她说累）'), '便条要上屏')
  assert.ok(body.includes('## 最弱的三条') && body.includes('R=0.42'), '衰减要上屏')
  assert.ok(body.includes('## 建议') && body.includes('（yuQue）'), '零件答话要上屏')
  assert.ok(body.includes(`数据目录 \`${HOME}\``), '页脚要写清数据目录')
  assert.ok(body.includes(`agent-man ${VERSION}`), '页脚要带版本')
  assert.ok(body.includes('context show --json'), '抬头要点明数据来源')
})

test('幂等约束：now 往后挪十分钟、一天，处境哈希必须一动不动', () => {
  const base = situation(sceneOf())
  // 时间派生字段全跟着变：clock、left、late、r、overdue、since.text、quiet。
  const tenMin = situation(sceneOf({ minutes: 10, left: '明天 09:50', r: 0.31, overdue: 1 }))
  const nextDay = situation(
    sceneOf({ minutes: 1440, left: '今天 10:00', late: true, r: 0.07, overdue: 3, quiet: false }),
  )
  const one = hashOf(base.core)
  assert.equal(hashOf(tenMin.core), one, '十分钟不该让哈希变')
  assert.equal(hashOf(nextDay.core), one, '一天也不该让哈希变')
  assert.notEqual(tenMin.body, base.body, '正文该跟着时刻走（人读的抬头）')
  assert.notEqual(nextDay.body, base.body, '换一天正文更该变')
})

test('幂等约束：改一条记忆或一条规矩，哈希必须变', () => {
  const base = hashOf(memory().core)
  const facts = JSON.parse(JSON.stringify(MEMORY))
  facts.items[0].fact = '空调从来不调 24 度以下'
  const wordy = JSON.parse(JSON.stringify(RULES))
  wordy.items[0].text = '夜里十二点后不提工作'
  assert.notEqual(hashOf(memory({ memory: facts }).core), base, '改了事实哈希要变')
  assert.notEqual(hashOf(memory({ rules: wordy }).core), base, '改了规矩哈希要变')
})

test('稳定内核：core 里不许出现时间、相对文案与零件答话', () => {
  const core = situationCore(sceneOf())
  assert.ok(!core.includes('夜深了'), '静默文案是钟点算的，不能进 core')
  assert.ok(!core.includes('00:31'), '钟点不能进 core')
  assert.ok(!core.includes('3 小时前'), '相对时间不能进 core')
  assert.ok(!core.includes('明天 10:00'), '"明天"过一天就骗人，不能进 core')
  assert.ok(!core.includes('0.42'), 'retention 随钟衰减，不能进 core')
  assert.ok(!core.includes('yuQue'), '零件答话每次都可能变，不能进 core')
  assert.ok(core.includes('交房租') && core.includes('问问她吃了没'), '该留在 core 里的内容要留下')
})

test('稳定内核：条目顺序由 id 决定，不跟 now 派生的排序走', () => {
  const left = sceneOf()
  const right = sceneOf()
  right.plans = [...right.plans].reverse()
  right.weakest = [...right.weakest].reverse()
  assert.equal(situationCore(right), situationCore(left), '倒序输入不该改哈希')
})

test('记忆三块：标出处、表格化、自我块整段照抄', () => {
  const { body } = memory()
  assert.ok(body.includes('## 结论'), '要有结论这一段')
  assert.ok(body.includes('> 字段来自 `agent-man memory ls --json`'), '要标出处')
  assert.ok(body.includes('| 槽位 | 事实 | 证据 | 何时 |'), '表头要稳定')
  assert.ok(body.includes('| 规矩 | 为什么 | 何时 |'), '规矩表头要稳定')
  assert.ok(body.includes('2 条（e-1）'), '证据要写条数')
  assert.ok(body.includes('夜里十一点后不提工作'), '规矩要上屏')
  assert.ok(body.includes('我是她的搭子，不是她的老板。'), '自我块要照抄')
  assert.ok(!body.includes('```text\n\n'), '自我块不该是空的')
})

test('表格里一个竖线不许把整行切开', () => {
  const nasty = { items: [{ id: 'm-2', key: 'a|b', fact: '有\n换行', at: SCENE_AT }] }
  const { body } = memory({ memory: nasty })
  assert.ok(body.includes('a\\|b'), '竖线要转义')
  assert.ok(!body.includes('| 有\n换行 |'), '换行要折成空格')
})

test('空本体：三块各给一句占位，别留空段落', () => {
  const raw = { memory: null, rules: null, self: {} }
  const empty = renderMemory({ ...raw, stamp: STAMP, home: HOME, version: VERSION })
  assert.ok(empty.body.includes('（本体里还没有活着的结论）'))
  assert.ok(empty.body.includes('（本体里还没有活着的规矩）'))
  assert.ok(empty.body.includes('（自我块还是空的）'))

  const blank = situation({})
  assert.ok(blank.body.includes('（此刻没有日程）'), '空场景也要有日程占位')
  assert.ok(blank.body.includes('（此刻没有便条）'), '空场景也要有便条占位')
  assert.ok(blank.body.includes('（本体里还没有可衰减的记忆）'), '空场景也要有衰减占位')
  assert.ok(blank.body.includes('（这次没有零件答话）'), '空场景也要有建议占位')
  assert.equal(situationCore(null), situationCore({}), '不是对象也当空处境，不抛')
})

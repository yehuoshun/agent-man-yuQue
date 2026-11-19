// 渲染只做"换介质"这件事：语雀是另一种排版，但内容不许造第二真源。
// 处境：`agent-man context show --json` 的结构化处境重排成人读的一页（时间只进正文）；
// 记忆：三份 --json 排成表格并标明字段出处。
// 每篇返回 { body, core }：body 进语雀（带抬头时刻与页脚），core 参与幂等哈希。
// core 只由稳定内容构成——否则每次渲染都"变了"，幂等就永远不成立。

const FOOTER_RULE = '---'

export function stampOf(when = new Date()) {
  const d = when instanceof Date ? when : new Date(when)
  const pad = (n) => String(n).padStart(2, '0')
  const offset = -d.getTimezoneOffset()
  const sign = offset >= 0 ? '+' : '-'
  const hours = pad(Math.floor(Math.abs(offset) / 60))
  const minutes = pad(Math.abs(offset) % 60)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}` +
    `:${pad(d.getMinutes())}:${pad(d.getSeconds())}${sign}${hours}:${minutes}`
}

// 表格里一个竖线就能把整行切开：转义掉，并把换行折成空格（语雀表格不认多行）。
function cell(text, fallback = '—') {
  const raw = text === undefined || text === null ? '' : String(text)
  const one = raw.replace(/\s+/g, ' ').trim()
  if (one === '') return fallback
  return one.replace(/\|/g, '\\|')
}

// 正文里的一行同样不许带换行：换行会把一条日程拆成两段，读起来像两件事。
function oneLine(text, fallback = '') {
  const raw = text === undefined || text === null ? '' : String(text)
  const one = raw.replace(/\s+/g, ' ').trim()
  return one === '' ? fallback : one
}

function whenOf(at) {
  if (typeof at !== 'number' || !Number.isFinite(at)) return '—'
  const d = new Date(at)
  if (Number.isNaN(d.getTime())) return '—'
  const pad = (n) => String(n).padStart(2, '0')
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

// 带年份的绝对时刻：日程写"明天 10:00"过一天就骗人，正文要留得住的是绝对时间。
function atTextOf(at) {
  if (typeof at !== 'number' || !Number.isFinite(at)) return ''
  const d = new Date(at)
  if (Number.isNaN(d.getTime())) return ''
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    ` ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function listOf(data) {
  if (data === null || typeof data !== 'object') return []
  return Array.isArray(data.items) ? data.items : []
}

function evidenceOf(item) {
  const ev = item?.evidence
  if (ev === null || typeof ev === 'undefined') return '—'
  if (Array.isArray(ev)) return ev.length === 0 ? '—' : `${ev.length} 条`
  if (typeof ev === 'object') {
    const ids = Array.isArray(ev.ids) ? ev.ids : []
    if (ids.length > 0) return `${ids.length} 条（${cell(ids[0])}）`
    const keys = Object.keys(ev)
    return keys.length === 0 ? '—' : cell(keys.map((k) => `${k}=${JSON.stringify(ev[k])}`).join(' '))
  }
  return cell(ev)
}

function table(headers, rows) {
  const head = `| ${headers.join(' | ')} |`
  const split = `| ${headers.map(() => '---').join(' | ')} |`
  return [head, split, ...rows.map((cells) => `| ${cells.join(' | ')} |`)].join('\n')
}

function footerLines({ stamp, home, version }) {
  const parts = [`生成于 ${stamp}`, `数据目录 \`${home}\``]
  if (typeof version === 'string' && version !== '') parts.push(`agent-man ${version}`)
  return parts.join(' · ')
}

// ---- 处境 ----------------------------------------------------------------
//
// 处境的数据源是 `agent-man context show --json` 的那个对象。实跑一次（AGENT_MAN_HOME 指到
// 临时假数据）逐字段核过它稳不稳，取舍如下——这张表就是"哈希只算稳定内核"的全部依据：
//
//   进 core（数据变了才变）：lastSaid、backlog.unconsolidated、plans[{id,due,text}]、
//     notes[{id,at,text,trigger,when}]、weakest[{id,text}]
//   只进 body（now 派生，时间一走就变）：at、clock、quiet（"夜深了"由钟点算）、
//     since{at,text,fresh}（"3 小时前"、"之后 N 条"）、backlog.overdue、debts.*、
//     plans.when、plans.left（"明天 10:00"）、plans.late（过没过点由 now 判）、
//     weakest.r（retention 随 now 连续衰减）、used、head、over、dropped、expired、later
//   只进 body（两不靠）：suggest——零件答话本身就带"刚同步过 / 3h 前"这类相对时间，
//     而且每次调用都可能变；进 core 等于每次渲染都算"内容变了"，幂等当场破。
//
// 已知取舍：weakest 取哪几条是按 retention 排序选的，时间推移可能换人 → 会触发一次重推；
// 那不是抖动，是页面上真的换了内容。seen（读到过几次）同理只进 body，不因计数微动就重推。
function sceneOf(scene) {
  return scene !== null && typeof scene === 'object' && !Array.isArray(scene) ? scene : {}
}

function rowsIn(value) {
  return Array.isArray(value) ? value : []
}

function textIn(value) {
  return typeof value === 'string' ? value : ''
}

function numIn(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function countIn(value) {
  const n = numIn(value)
  return n === null ? 0 : n
}

function idIn(value) {
  if (typeof value === 'string') return value
  const n = numIn(value)
  return n === null ? '' : String(n)
}

function byId(left, right) {
  if (left.id < right.id) return -1
  return left.id > right.id ? 1 : 0
}

// 稳定内核：只挑数据本身（+ 绝对时刻），一律按 id 排序——排序不许依赖 now 派生的顺序。
export function situationCore(scene) {
  const one = sceneOf(scene)
  const plans = rowsIn(one.plans)
    .map((row) => ({ id: idIn(row?.id), due: numIn(row?.due), text: oneLine(row?.text) }))
    .sort(byId)
  const notes = rowsIn(one.notes)
    .map((row) => ({
      id: idIn(row?.id),
      at: numIn(row?.at),
      text: oneLine(row?.text),
      trigger: oneLine(row?.trigger),
      when: numIn(row?.when),
    }))
    .sort(byId)
  const weakest = rowsIn(one.weakest)
    .map((row) => ({ id: idIn(row?.id), text: oneLine(row?.text) }))
    .sort(byId)
  return JSON.stringify({
    lastSaid: numIn(one.lastSaid),
    backlog: { unconsolidated: countIn(one?.backlog?.unconsolidated) },
    plans,
    notes,
    weakest,
  })
}

function sinceLineOf(scene) {
  const since = scene.since
  if (since === null || typeof since !== 'object') {
    return numIn(scene.lastSaid) === null ? '上次开口：还没开过口' : ''
  }
  const text = oneLine(since.text)
  if (text === '') return ''
  const fresh = countIn(since.fresh)
  return `上次开口：${text}${fresh > 0 ? `（之后 ${fresh} 条新记忆）` : ''}`
}

function backlogLineOf(backlog) {
  if (backlog === null || typeof backlog !== 'object') return ''
  const parts = []
  const unconsolidated = countIn(backlog.unconsolidated)
  const overdue = countIn(backlog.overdue)
  if (unconsolidated > 0) parts.push(`${unconsolidated} 条待巩固`)
  if (overdue > 0) parts.push(`${overdue} 条过期日程`)
  return parts.length === 0 ? '' : `积压：${parts.join(' · ')}`
}

function headBlockOf(scene) {
  const lines = []
  const clock = oneLine(scene.clock)
  if (clock !== '') lines.push(`- 此刻：${clock}`)
  if (scene.quiet === true) lines.push('- 静默：夜深了，除非她先开口，不然不主动说')
  const since = sinceLineOf(scene)
  if (since !== '') lines.push(`- ${since}`)
  const backlog = backlogLineOf(scene.backlog)
  if (backlog !== '') lines.push(`- ${backlog}`)
  if (scene.over === true) lines.push(`- 这一屏放不下：用了 ${countIn(scene.used)}/${countIn(scene.budget)}`)
  const dropped = rowsIn(scene.dropped).length
  if (dropped > 0) lines.push(`- 有 ${dropped} 条没上屏（预算或条数）`)
  return ['## 此刻', '', ...lines].join('\n')
}

function planLineOf(plan) {
  const text = oneLine(plan?.text, '（没写内容）')
  const due = atTextOf(plan?.due)
  const tail = plan?.late === true
    ? '（已经过点了）'
    : (oneLine(plan?.left) === '' ? '' : `（${oneLine(plan?.left)}）`)
  return `${due === '' ? '' : `${due} `}${text}${tail}`
}

function noteLineOf(note) {
  const text = oneLine(note?.text, '（没写内容）')
  const trigger = oneLine(note?.trigger)
  const when = atTextOf(note?.when)
  return `${text}${trigger === '' ? '' : `（等：${trigger}）`}${when === '' ? '' : `（${when}）`}`
}

function weakLineOf(row) {
  const text = oneLine(row?.text, '（没写内容）')
  const r = numIn(row?.r)
  const seen = countIn(row?.seen)
  const id = oneLine(row?.id)
  return `${text} · R=${r === null ? '—' : r.toFixed(2)} · 读到过 ${seen} 次${id === '' ? '' : `（${id}）`}`
}

function suggestLineOf(row) {
  const text = oneLine(row?.text, '')
  if (text === '') return ''
  const name = oneLine(row?.name)
  return `${text}${name === '' ? '' : `（${name}）`}`
}

function sectionBlock(title, lines, emptyText) {
  if (lines.length === 0) return [`## ${title}`, '', emptyText].join('\n')
  return [`## ${title}`, '', ...lines.map((one) => `- ${one}`)].join('\n')
}

// 处境正文：抬头（此刻/静默/积压）+ 四段（日程/便条/最弱的三条/建议）+ 页脚。
// 排版照本体那屏的口径来，只为让人一眼认出"这是同一条处境"，不另造说法。
export function renderSituation({ scene, stamp, home, version }) {
  const one = sceneOf(scene)
  const core = situationCore(one)
  const suggest = rowsIn(one.suggest).map(suggestLineOf).filter((line) => line !== '')
  const blocks = [
    headBlockOf(one),
    sectionBlock('日程', rowsIn(one.plans).map(planLineOf), '（此刻没有日程）'),
    sectionBlock('便条', rowsIn(one.notes).map(noteLineOf), '（此刻没有便条）'),
    sectionBlock('最弱的三条', rowsIn(one.weakest).map(weakLineOf), '（本体里还没有可衰减的记忆）'),
    sectionBlock('建议', suggest, '（这次没有零件答话）'),
  ]
  const body = [
    `> 同步于 ${stamp}　本页由 \`agent-man context show --json\` 的处境快照重排；改这里不会改回本体。`,
    '',
    blocks.join('\n\n'),
    '',
    FOOTER_RULE,
    footerLines({ stamp, home, version }),
    '',
  ].join('\n')
  return { core, body }
}

// ---- 记忆 ----------------------------------------------------------------

// 记忆：表格三块 + 自我块原文；每块都写清字段来自哪条命令。
// 这里的时间是绝对时刻（MM-DD HH:mm），不随钟走，所以 core 直接用这三块正文。
export function renderMemory({ memory, rules, self, stamp, home, version }) {
  const items = listOf(memory)
  const ruleItems = listOf(rules)
  const selfObj = self !== null && typeof self === 'object' ? self : {}
  const selfText = typeof selfObj.text === 'string' ? selfObj.text.trim() : ''

  const sections = []
  sections.push('## 结论', '')
  sections.push('> 字段来自 `agent-man memory ls --json`：槽位 `key`、事实 `fact`、')
  sections.push('> 证据 `evidence`、何时 `at`。')
  sections.push('')
  if (items.length === 0) {
    sections.push('（本体里还没有活着的结论）')
  } else {
    sections.push(table(
      ['槽位', '事实', '证据', '何时'],
      items.map((one) => [cell(one?.key), cell(one?.fact), evidenceOf(one), whenOf(one?.at)]),
    ))
  }

  sections.push('', '## 规矩', '')
  sections.push('> 字段来自 `agent-man rule ls --json`：规矩 `text`、为什么 `why`、何时 `at`。')
  sections.push('')
  if (ruleItems.length === 0) {
    sections.push('（本体里还没有活着的规矩）')
  } else {
    sections.push(table(
      ['规矩', '为什么', '何时'],
      ruleItems.map((one) => [cell(one?.text), cell(one?.why), whenOf(one?.at)]),
    ))
  }

  sections.push('', '## 自我块', '')
  sections.push('> 原文来自 `agent-man self show --json` 的 `text`：整段照抄，不重排。')
  sections.push('')
  sections.push(selfText === '' ? '（自我块还是空的）' : ['```text', selfText, '```'].join('\n'))

  const core = sections.join('\n')
  const body = [
    `> 同步于 ${stamp}　本页是本体记忆的镜像；改这里不会改回本体。`,
    '',
    core,
    '',
    FOOTER_RULE,
    footerLines({ stamp, home, version }),
    '',
  ].join('\n')
  return { core, body }
}

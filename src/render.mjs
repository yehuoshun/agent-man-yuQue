// 渲染只做"换介质"这件事：语雀是另一种排版，但内容不许造第二真源。
// 处境：`agent-man context show` 的纯文本原样贴（不重排）；记忆：三份 --json 排成表格并标明字段出处。
// 每篇返回 { body, core }：body 进语雀，core 参与幂等哈希——core 里不含生成时刻和页脚，
// 否则每次渲染都"变了"，幂等就永远不成立。

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

function whenOf(at) {
  if (typeof at !== 'number' || !Number.isFinite(at)) return '—'
  const d = new Date(at)
  if (Number.isNaN(d.getTime())) return '—'
  const pad = (n) => String(n).padStart(2, '0')
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
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

// 处境：一行生成时刻 + context show 原文 + 页脚；core 只取原文。
export function renderSituation({ text, stamp, home, version }) {
  const source = String(text ?? '').replace(/\r\n/g, '\n').trimEnd()
  const core = source === '' ? '（本体这次没有输出内容）' : source
  const body = [
    `> 同步于 ${stamp}　本页正文是 \`agent-man context show\` 的原样输出，未重排。`,
    '',
    core,
    '',
    FOOTER_RULE,
    footerLines({ stamp, home, version }),
    '',
  ].join('\n')
  return { core, body }
}

// 记忆：表格三块 + 自我块原文；每块都写清字段来自哪条命令。
export function renderMemory({ memory, rules, self, stamp, home, version }) {
  const items = listOf(memory)
  const ruleItems = listOf(rules)
  const selfObj = self !== null && typeof self === 'object' ? self : {}
  const selfText = typeof selfObj.text === 'string' ? selfObj.text.trim() : ''

  const sections = []
  sections.push('## 结论', '')
  sections.push('> 字段来自 `agent-man memory ls --json`：槽位 `key`、事实 `fact`、证据 `evidence`、何时 `at`。')
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
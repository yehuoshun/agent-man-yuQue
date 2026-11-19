// 卫生自查：行宽 / BOM / CRLF。AGENTS.md 里这三条是硬约定，靠眼睛守不住，给一条命令：
//   node scripts/check-style.mjs
// 全干净输出三行 ok 并以 0 退出；有命中就列出「文件:行号 列数」并以 1 退出。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const SKIP = new Set(['.git', 'node_modules', 'tmp'])
const MAX_WIDTH = 110
// 宽字符按两列算：CJK、假名、韩文、全角标点、CJK 兼容区。
const WIDE_BMP = '\\u1100-\\u115f\\u2e80-\\ua4cf\\ua960-\\ua97f\\uac00-\\ud7a3'
const WIDE_TAIL = '\\uf900-\\ufaff\\ufe10-\\ufe19\\ufe30-\\ufe6f\\uff00-\\uff60\\uffe0-\\uffe6'
const WIDE = new RegExp(`[${WIDE_BMP}${WIDE_TAIL}]`)

function walk(dir) {
  const out = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP.has(entry.name)) continue
      out.push(...walk(path.join(dir, entry.name)))
      continue
    }
    if (entry.isFile()) out.push(path.join(dir, entry.name))
  }
  return out
}

function widthOf(line) {
  let width = 0
  for (const ch of line) width += WIDE.test(ch) ? 2 : 1
  return width
}

function relOf(file) {
  return path.relative(ROOT, file).split(path.sep).join('/')
}

const files = walk(ROOT).sort()
const tooWide = []
const withBom = []
const withCr = []
let textFiles = 0

for (const file of files) {
  const bytes = fs.readFileSync(file)
  const rel = relOf(file)
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    withBom.push(rel)
  }
  if (bytes.includes(0x0d)) withCr.push(rel)
  if (bytes.includes(0x00)) continue
  textFiles += 1
  const lines = bytes.toString('utf8').split('\n')
  for (let i = 0; i < lines.length; i += 1) {
    // BOM 已单独报过，量宽度时先摘掉，免得第一行虚高一列。
    const width = widthOf(lines[i].replace(/\ufeff/g, ''))
    if (width > MAX_WIDTH) tooWide.push(`${rel}:${i + 1} ${width} 列`)
  }
}

const checks = [
  [`行宽 ≤${MAX_WIDTH}`, tooWide, `${textFiles} 个文本文件`],
  ['UTF-8 无 BOM', withBom, `${files.length} 个文件`],
  ['零 CRLF', withCr, `${files.length} 个文件`],
]

let bad = 0
for (const [name, hits, scope] of checks) {
  if (hits.length === 0) {
    console.log(`${name}：ok（${scope}）`)
    continue
  }
  bad += hits.length
  console.log(`${name}：${hits.length} 处`)
  for (const hit of hits) console.log(`  ${hit}`)
}
process.exit(bad === 0 ? 0 : 1)

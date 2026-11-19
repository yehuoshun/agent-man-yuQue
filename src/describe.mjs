// --describe 的回包：agent-man 的发现器只认这五个字段（design §8），少一个就把这个零件
// 判成"没按契约实现"。name 是 PATH 上 `agent-man-` 之后那段，大小写按原样保留。
export const DESCRIBE = {
  name: 'yuQue',
  desc: '把处境与记忆同步到语雀',
  section: '同步',
  timeout_ms: 5000,
  side_effects: true,
}

// 一行、不缩进：stdout 只放结果，发现器直接 JSON.parse 这一行。
export function describeLine() {
  return JSON.stringify(DESCRIBE)
}
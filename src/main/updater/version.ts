// 更新源版本比较（spec 2026-09-04 §4 + 发版预发支持）：semver 严格校验——
// 含项目扩展：容忍 v 前缀与两段核心版本（缺段补 0）；其余按 SemVer §9/§10：
// 预发数字标识符禁止前导零，build 元数据必须格式合法、仅排序时忽略。
// 数字段用字符串比较（长度 + 字典序，等价数值比较）——Number 在 2^53 外丢
// 精度会漏报更新。解析失败一律视为「无更新」，绝不误报。

export interface SemVer {
  /** 核心数字段（字符串形态，已保证无前导零） */
  core: string[]
  /** 预发标识符（如 beta、1）；正式版为空数组 */
  pre: string[]
}

const NUM = /^\d+$/

/** 无前导零非负整数字符串比较：长度优先、同长字典序（等价数值序，无精度损失） */
function cmpNumStr(a: string, b: string): number {
  if (a.length !== b.length) return a.length < b.length ? -1 : 1
  return a === b ? 0 : a < b ? -1 : 1
}

export function parseVersion(v: string): SemVer | null {
  const s = v.trim().replace(/^v/, '')
  // build 元数据（+ 后）：必须合法（点分字母数字连字符、无非空段），排序时忽略
  const plus = s.indexOf('+')
  const main = plus === -1 ? s : s.slice(0, plus)
  const build = plus === -1 ? '' : s.slice(plus + 1)
  if (plus !== -1) {
    if (build === '' || build.split('.').some(b => b === '' || !/^[0-9A-Za-z-]+$/.test(b))) return null
  }
  const dash = main.indexOf('-')
  const coreStr = dash === -1 ? main : main.slice(0, dash)
  const preStr = dash === -1 ? '' : main.slice(dash + 1)
  if (!/^\d+(\.\d+)*$/.test(coreStr)) return null
  const core = coreStr.split('.')
  if (core.some(c => c.length > 1 && c.startsWith('0'))) return null // 核心段禁前导零
  if (dash !== -1 && preStr === '') return null // 尾部裸横线（1.3.0-）非法
  const pre = preStr ? preStr.split('.') : []
  for (const p of pre) {
    if (p === '' || !/^[0-9A-Za-z-]+$/.test(p)) return null
    if (NUM.test(p) && p.length > 1 && p.startsWith('0')) return null // SemVer §9：数字标识符禁前导零
  }
  return { core, pre }
}

/** 预发段比较（SemVer §11）：负值 = a 更旧；0 = 相等；正值 = a 更新 */
function comparePre(a: string[], b: string[]): number {
  if (a.length === 0 && b.length === 0) return 0
  if (a.length === 0) return 1 // 正式 > 预发
  if (b.length === 0) return -1
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) {
    const x = a[i]!
    const y = b[i]!
    const xn = NUM.test(x)
    const yn = NUM.test(y)
    if (xn && yn) {
      const d = cmpNumStr(x, y)
      if (d !== 0) return d
    } else if (xn !== yn) {
      return xn ? -1 : 1 // 数值标识符排在字母数字标识符之前
    } else if (x !== y) {
      return x < y ? -1 : 1 // ASCII 字典序
    }
  }
  return a.length === b.length ? 0 : a.length < b.length ? -1 : 1 // 前缀相同：短 < 长
}

export function isNewerVersion(remote: string, current: string): boolean {
  const r = parseVersion(remote)
  const c = parseVersion(current)
  if (!r || !c) return false
  const n = Math.max(r.core.length, c.core.length)
  for (let i = 0; i < n; i++) {
    const d = cmpNumStr(r.core[i] ?? '0', c.core[i] ?? '0')
    if (d !== 0) return d > 0
  }
  return comparePre(r.pre, c.pre) > 0
}

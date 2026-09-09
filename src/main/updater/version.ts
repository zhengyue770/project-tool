// 更新源版本比较（spec 2026-09-04 §4 + 发版预发支持）：完整 semver——核心段
// 数字比较；预发段按 semver 规则（同核心时 正式 > 预发；标识符左起逐段比较，
// 数值段按数值、字母段按 ASCII 字典序、数值段 < 字母段；前缀相同短 < 长；
// +build 元数据忽略）。解析失败一律视为「无更新」，绝不误报。

export interface SemVer {
  core: number[]
  /** 预发标识符（如 beta、1）；正式版为空数组 */
  pre: string[]
}

export function parseVersion(v: string): SemVer | null {
  const s = v.trim().replace(/^v/, '').split('+')[0]
  const dash = s.indexOf('-')
  const coreStr = dash === -1 ? s : s.slice(0, dash)
  const preStr = dash === -1 ? '' : s.slice(dash + 1)
  if (!/^\d+(\.\d+)*$/.test(coreStr)) return null
  if (dash !== -1 && preStr === '') return null // 尾部裸横线（1.3.0-）非法
  const pre = preStr ? preStr.split('.') : []
  if (pre.some(p => p === '' || !/^[0-9A-Za-z-]+$/.test(p))) return null
  return { core: coreStr.split('.').map(Number), pre }
}

/** 预发段比较：负值 = a 更旧；0 = 相等；正值 = a 更新 */
function comparePre(a: string[], b: string[]): number {
  if (a.length === 0 && b.length === 0) return 0
  if (a.length === 0) return 1 // 正式 > 预发
  if (b.length === 0) return -1
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) {
    const x = a[i]!
    const y = b[i]!
    const xn = /^\d+$/.test(x)
    const yn = /^\d+$/.test(y)
    if (xn && yn) {
      if (Number(x) !== Number(y)) return Number(x) < Number(y) ? -1 : 1
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
    const d = (r.core[i] ?? 0) - (c.core[i] ?? 0)
    if (d !== 0) return d > 0
  }
  return comparePre(r.pre, c.pre) > 0
}

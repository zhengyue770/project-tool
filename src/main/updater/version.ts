// 自动更新（spec 2026-09-04 §4）：Release tag 形如 v1.2.0，比较前去 v 前缀、
// 按 . 分段数字比较；解析失败一律视为「无更新」，绝不误报。

export function parseVersion(v: string): number[] | null {
  const m = /^v?(\d+(?:\.\d+)*)$/.exec(v.trim())
  return m ? m[1].split('.').map(Number) : null
}

export function isNewerVersion(remote: string, current: string): boolean {
  const r = parseVersion(remote)
  const c = parseVersion(current)
  if (!r || !c) return false
  const n = Math.max(r.length, c.length)
  for (let i = 0; i < n; i++) {
    const d = (r[i] ?? 0) - (c[i] ?? 0)
    if (d !== 0) return d > 0
  }
  return false
}

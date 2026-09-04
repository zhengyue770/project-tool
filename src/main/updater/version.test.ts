import { describe, it, expect } from 'vitest'
import { isNewerVersion, parseVersion } from './version'

// 自动更新（spec 2026-09-04 §4）：Release tag 形如 v1.2.0，与 app.getVersion()
// 比较前去 v 前缀、按 . 分段数字比较；解析失败一律视为「无更新」，绝不误报。

describe('parseVersion', () => {
  it('常规：v 前缀与纯数字均可解析', () => {
    expect(parseVersion('v1.2.0')).toEqual([1, 2, 0])
    expect(parseVersion('1.2.0')).toEqual([1, 2, 0])
    expect(parseVersion('v2.0')).toEqual([2, 0])
  })

  it('空白容忍：前后空格不影响', () => {
    expect(parseVersion(' 1.3.0 ')).toEqual([1, 3, 0])
  })

  it('非法输入 → null（非数字段、空串、乱码）', () => {
    expect(parseVersion('')).toBeNull()
    expect(parseVersion('abc')).toBeNull()
    expect(parseVersion('1.x.0')).toBeNull()
    expect(parseVersion('v1.')).toBeNull()
  })
})

describe('isNewerVersion', () => {
  it('高版本 → true', () => {
    expect(isNewerVersion('v1.3.0', '1.2.0')).toBe(true)
  })

  it('数字比较而非字符串：1.10.0 > 1.9.0', () => {
    expect(isNewerVersion('1.10.0', '1.9.0')).toBe(true)
  })

  it('跨段进位：1.0.0 > 1.0.9 → false；2.0.0 > 1.9.9 → true', () => {
    expect(isNewerVersion('1.0.0', '1.0.9')).toBe(false)
    expect(isNewerVersion('2.0.0', '1.9.9')).toBe(true)
  })

  it('相等（含段数不齐补零）→ false', () => {
    expect(isNewerVersion('1.2.0', 'v1.2.0')).toBe(false)
    expect(isNewerVersion('1.2', '1.2.0')).toBe(false)
  })

  it('低版本 → false', () => {
    expect(isNewerVersion('v1.1.9', '1.2.0')).toBe(false)
  })

  it('任一侧解析失败 → false（不误报）', () => {
    expect(isNewerVersion('latest', '1.2.0')).toBe(false)
    expect(isNewerVersion('1.3.0', 'unknown')).toBe(false)
  })
})

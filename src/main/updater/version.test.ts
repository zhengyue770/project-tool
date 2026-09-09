import { describe, it, expect } from 'vitest'
import { isNewerVersion, parseVersion } from './version'

// 更新源版本比较（spec 2026-09-04 §4 + 发版预发支持）：完整 semver——核心段
// 数字比较 + 预发段按 semver 规则（正式 > 预发；标识符数值/字典序；短 < 长；
// build 元数据忽略）。解析失败一律视为「无更新」，绝不误报。

describe('parseVersion', () => {
  it('常规：v 前缀、纯数字、两段补零均可解析；预发段拆成标识符数组', () => {
    expect(parseVersion('v1.2.0')).toEqual({ core: [1, 2, 0], pre: [] })
    expect(parseVersion('1.2.0')).toEqual({ core: [1, 2, 0], pre: [] })
    expect(parseVersion('v2.0')).toEqual({ core: [2, 0], pre: [] })
    expect(parseVersion('1.3.0-beta.1')).toEqual({ core: [1, 3, 0], pre: ['beta', '1'] })
    expect(parseVersion('1.3.0-rc.1')).toEqual({ core: [1, 3, 0], pre: ['rc', '1'] })
  })

  it('build 元数据忽略；空白容忍', () => {
    expect(parseVersion('1.3.0+build.5')).toEqual({ core: [1, 3, 0], pre: [] })
    expect(parseVersion(' 1.3.0-beta.1 ')).toEqual({ core: [1, 3, 0], pre: ['beta', '1'] })
  })

  it('非法输入 → null（非数字段、空标识符、空串、乱码）', () => {
    expect(parseVersion('')).toBeNull()
    expect(parseVersion('abc')).toBeNull()
    expect(parseVersion('1.x.0')).toBeNull()
    expect(parseVersion('v1.')).toBeNull()
    expect(parseVersion('1.3.0-')).toBeNull()
    expect(parseVersion('1.3.0-beta..1')).toBeNull()
    expect(parseVersion('1.3.0-beta!')).toBeNull()
  })
})

describe('isNewerVersion', () => {
  it('高版本 → true；数字比较而非字符串（1.10.0 > 1.9.0）', () => {
    expect(isNewerVersion('v1.3.0', '1.2.0')).toBe(true)
    expect(isNewerVersion('1.10.0', '1.9.0')).toBe(true)
  })

  it('跨段进位与相等（含段数不齐补零）→ false', () => {
    expect(isNewerVersion('1.0.0', '1.0.9')).toBe(false)
    expect(isNewerVersion('2.0.0', '1.9.9')).toBe(true)
    expect(isNewerVersion('1.2.0', 'v1.2.0')).toBe(false)
    expect(isNewerVersion('1.2', '1.2.0')).toBe(false)
  })

  it('低版本 → false；任一侧解析失败 → false（不误报）', () => {
    expect(isNewerVersion('v1.1.9', '1.2.0')).toBe(false)
    expect(isNewerVersion('latest', '1.2.0')).toBe(false)
    expect(isNewerVersion('1.3.0', 'unknown')).toBe(false)
  })
})

describe('isNewerVersion：semver 预发段（发版实测轮）', () => {
  it('旧正式 → 新预发：1.2.0 客户端能升到 1.3.0-beta.1', () => {
    expect(isNewerVersion('1.3.0-beta.1', '1.2.0')).toBe(true)
  })

  it('预发 → 同段正式：1.3.0-beta.1 客户端能升到 1.3.0（正式 > 预发）', () => {
    expect(isNewerVersion('1.3.0', '1.3.0-beta.1')).toBe(true)
  })

  it('预发段内：数值比较（beta.10 > beta.9）、字典序（alpha < beta < rc）', () => {
    expect(isNewerVersion('1.3.0-beta.10', '1.3.0-beta.9')).toBe(true)
    expect(isNewerVersion('1.3.0-beta.2', '1.3.0-beta.1')).toBe(true)
    expect(isNewerVersion('1.3.0-beta.1', '1.3.0-alpha.9')).toBe(true)
    expect(isNewerVersion('1.3.0-rc.1', '1.3.0-beta.9')).toBe(true)
    expect(isNewerVersion('1.3.0-alpha.2', '1.3.0-beta.1')).toBe(false)
  })

  it('数字标识符 < 字母数字标识符；短预发 < 长预发；完全相等 → false', () => {
    expect(isNewerVersion('1.3.0-alpha', '1.3.0-1')).toBe(true) // 数字段排在字母前
    expect(isNewerVersion('1.3.0-beta.1', '1.3.0-beta')).toBe(true) // 长 > 短
    expect(isNewerVersion('1.3.0-beta.1', '1.3.0-beta.1')).toBe(false)
    // build 元数据不参与比较
    expect(isNewerVersion('1.3.0+build.9', '1.3.0')).toBe(false)
  })

  it('同核心的预发不高于正式；低核心的预发不高于高核心正式', () => {
    expect(isNewerVersion('1.3.0-rc.1', '1.3.0')).toBe(false)
    expect(isNewerVersion('1.2.9-beta.1', '1.3.0')).toBe(false)
  })
})

import { describe, it, expect } from 'vitest'
import { isNewerVersion, parseVersion } from './version'

// 更新源版本比较（spec 2026-09-04 §4 + 发版预发支持）：semver 严格校验
// （含项目扩展：v 前缀、两段核心版本补零）；非法版本绝不判「有更新」；
// 数字段字符串比较无精度损失。解析失败一律视为「无更新」，绝不误报。

describe('parseVersion', () => {
  it('常规：v 前缀、纯数字、两段补零（项目扩展）；预发段拆成标识符数组', () => {
    expect(parseVersion('v1.2.0')).toEqual({ core: ['1', '2', '0'], pre: [] })
    expect(parseVersion('1.2.0')).toEqual({ core: ['1', '2', '0'], pre: [] })
    expect(parseVersion('v2.0')).toEqual({ core: ['2', '0'], pre: [] })
    expect(parseVersion('1.3.0-beta.1')).toEqual({ core: ['1', '3', '0'], pre: ['beta', '1'] })
    expect(parseVersion('1.3.0-rc.1')).toEqual({ core: ['1', '3', '0'], pre: ['rc', '1'] })
  })

  it('合法 build 元数据解析并忽略；空白容忍', () => {
    expect(parseVersion('1.3.0+build.5')).toEqual({ core: ['1', '3', '0'], pre: [] })
    expect(parseVersion('1.3.0-beta.1+x-1.2')).toEqual({ core: ['1', '3', '0'], pre: ['beta', '1'] })
    expect(parseVersion(' 1.3.0-beta.1 ')).toEqual({ core: ['1', '3', '0'], pre: ['beta', '1'] })
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

  it('review 修正：非法 build 元数据（1.3.0+ / 1.3.0+bad!）→ null，不得判有更新', () => {
    expect(parseVersion('1.3.0+')).toBeNull()
    expect(parseVersion('1.3.0+bad!')).toBeNull()
    expect(parseVersion('1.3.0+build.')).toBeNull()
    expect(isNewerVersion('1.3.0+', '1.2.0')).toBe(false)
    expect(isNewerVersion('1.3.0+bad!', '1.2.0')).toBe(false)
  })

  it('review 修正：预发/核心数字前导零（SemVer §9）→ null', () => {
    expect(parseVersion('1.3.0-beta.01')).toBeNull()
    expect(parseVersion('1.3.0-01')).toBeNull()
    expect(parseVersion('01.2.0')).toBeNull()
    expect(isNewerVersion('1.3.0-beta.01', '1.2.0')).toBe(false)
    expect(isNewerVersion('1.3.0-0', '1.2.0')).toBe(true) // 单个 0 合法
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
    // 合法 build 元数据不参与比较
    expect(isNewerVersion('1.3.0+build.9', '1.3.0')).toBe(false)
    expect(isNewerVersion('1.3.0+build.9', '1.2.0')).toBe(true)
  })

  it('review 修正：超过 2^53 的大数字段无精度损失', () => {
    // 预发数字标识符：9007199254740993 > 9007199254740992（Number 会丢精度判等）
    expect(isNewerVersion('1.3.0-beta.9007199254740993', '1.3.0-beta.9007199254740992')).toBe(true)
    expect(isNewerVersion('1.3.0-beta.9007199254740992', '1.3.0-beta.9007199254740993')).toBe(false)
    // 核心段大数：位数不同 / 同位字典序
    expect(isNewerVersion('1.9007199254740993.0', '1.9007199254740992.0')).toBe(true)
    expect(isNewerVersion('1.99999999999999999999.0', '1.9007199254740999.0')).toBe(true)
    expect(isNewerVersion('1.9007199254740992.0', '1.9007199254740992.0')).toBe(false)
  })

  it('同核心的预发不高于正式；低核心的预发不高于高核心正式', () => {
    expect(isNewerVersion('1.3.0-rc.1', '1.3.0')).toBe(false)
    expect(isNewerVersion('1.2.9-beta.1', '1.3.0')).toBe(false)
  })
})

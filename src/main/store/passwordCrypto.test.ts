import { describe, it, expect } from 'vitest'
import type { Project, StoredAccount } from '../../shared/types'
import {
  encryptPassword, decryptStored, accountToRenderer, mergeAccounts,
  migratePlaintextAccounts, selfTest, type SafeCrypto
} from './passwordCrypto'

// 密码加密（hardening 批次四）：假加密器注入，验证边界语义——密文不外泄、
// 解密失败保留、哨兵合并不动密文、明文迁移全有或全无。

const ok: SafeCrypto = {
  isEncryptionAvailable: () => true,
  encryptString: s => Buffer.from(`E:${s}`),
  decryptString: b => b.toString().slice(2)
}
const unavailable: SafeCrypto = { ...ok, isEncryptionAvailable: () => false }
const broken: SafeCrypto = {
  isEncryptionAvailable: () => true,
  encryptString: s => Buffer.from(`E:${s}`),
  decryptString: () => { throw new Error('钥匙串拒绝访问') }
}
/** 加密成功但解密返回错值（钥匙串状态异常）——迁移必须解密核对防住 */
const lying: SafeCrypto = {
  isEncryptionAvailable: () => true,
  encryptString: s => Buffer.from(`E:${s}`),
  decryptString: () => 'wrong-value'
}

const acct = (over: Partial<StoredAccount> = {}): StoredAccount => ({
  id: 'a1', label: '管理员', username: 'admin', password: 'plain-pw', role: 'r', ...over
})

describe('encryptPassword / decryptStored', () => {
  it('往返成功；不可用 → null/locked；解密失败 → locked 且不产空密码真值', () => {
    const enc = encryptPassword(ok, '秘密')
    expect(enc).toEqual({ enc: 'v1', data: Buffer.from('E:秘密').toString('base64') })
    expect(decryptStored(ok, enc!)).toEqual({ value: '秘密', locked: false })
    expect(encryptPassword(unavailable, 'x')).toBeNull()
    expect(decryptStored(unavailable, enc!)).toEqual({ value: null, locked: true })
    expect(decryptStored(broken, enc!)).toEqual({ value: null, locked: true })
    // 旧明文原样返回
    expect(decryptStored(ok, 'legacy-plain')).toEqual({ value: 'legacy-plain', locked: false })
  })

  it('未知加密版本 → locked（保留不覆盖，不当损坏处理）', () => {
    expect(decryptStored(ok, { enc: 'v9', data: '??' })).toEqual({ value: null, locked: true })
  })
})

describe('accountToRenderer（密文不外泄）', () => {
  it('明文/密文/锁定三态；锁定给 passwordLocked + 空密码，enc 对象绝不出现在输出', () => {
    const a1 = accountToRenderer(ok, acct()) // 明文（旧数据）
    expect(a1.password).toBe('plain-pw')
    expect(a1.passwordLocked).toBeUndefined()

    const enc = encryptPassword(ok, '秘密')!
    const a2 = accountToRenderer(ok, acct({ password: enc }))
    expect(a2.password).toBe('秘密')

    const a3 = accountToRenderer(broken, acct({ password: enc }))
    expect(a3.password).toBe('')
    expect(a3.passwordLocked).toBe(true)
    expect(JSON.stringify(a3)).not.toContain(enc.data) // 密文不外泄
  })
})

describe('mergeAccounts（哨兵语义）', () => {
  const storedEnc = encryptPassword(ok, '旧密码')!

  it('password 缺省 → 存储密码原样保留（密文对象引用级不动）', () => {
    const stored = [acct({ id: 'a1', password: storedEnc })]
    const out = mergeAccounts(ok, stored, [
      { id: 'a1', label: '改名', username: 'admin', role: 'r' } // 无 password 字段
    ])
    expect(out[0]!.label).toBe('改名')
    expect(out[0]!.password).toBe(storedEnc) // 同一对象，未被重加密
  })

  it('有值 → 加密新值；新账号无密码 → 报错；加密不可用且有新密码 → 报错不落明文', () => {
    const out = mergeAccounts(ok, [acct({ id: 'a1', password: storedEnc })], [
      { id: 'a1', label: '管理员', username: 'admin', role: 'r', password: '新密码' }
    ])
    expect(decryptStored(ok, out[0]!.password)).toEqual({ value: '新密码', locked: false })

    expect(() => mergeAccounts(ok, [], [
      { id: 'n1', label: '新', username: 'u', role: 'r' }
    ])).toThrow('缺少密码')

    // review 修正：空字符串是合法密码（新账号允许无密码），显式提交不被误判为未改动
    const empty = mergeAccounts(ok, [], [
      { id: 'n1', label: '新', username: 'u', role: 'r', password: '' }
    ])
    expect(empty[0]!.password).toBe('')

    expect(() => mergeAccounts(unavailable, [acct()], [
      { id: 'a1', label: '管理员', username: 'admin', role: 'r', password: 'x' }
    ])).toThrow('钥匙串')
  })
})

describe('migratePlaintextAccounts（全有或全无）', () => {
  const proj = (accounts: StoredAccount[]): Project => ({
    id: 'p1', name: 't', path: '/tmp/x',
    commands: [{ id: 'c1', name: 'srv', cmd: 'true', workdir: '.', port: 1 }],
    urls: [], accounts: accounts as unknown as Project['accounts'], createdAt: 0
  })

  it('存在明文 → 全部加密成功 → changed + 计数', () => {
    const projects = [
      proj([acct({ id: 'a1' }), acct({ id: 'a2', password: encryptPassword(ok, 'x')! })])
    ]
    const r = migratePlaintextAccounts(ok, projects)
    expect(r).toMatchObject({ changed: true, encrypted: 1, ok: true })
    expect(r.projects![0]!.accounts[0]!.password).toMatchObject({ enc: 'v1' }) // 草稿含密文
  })

  it('任一加密失败 → ok=false 且 changed=false（文件不动，下次重试）', () => {
    const projects = [proj([acct({ id: 'a1' }), acct({ id: 'a2' })])]
    const r = migratePlaintextAccounts(unavailable, projects)
    expect(r).toMatchObject({ changed: false, encrypted: 0, ok: false })
    expect(r.projects).toBeUndefined() // 失败不给草稿，调用方不落盘
  })

  it('review 修正：加密成功但解密失败/解密错值 → 迁移中止，不把明文换成读不回的密文', () => {
    const projects = [proj([acct({ id: 'a1' })])]
    // 解密抛错
    expect(migratePlaintextAccounts(broken, projects)).toMatchObject({ changed: false, ok: false })
    // 解密返回错值（往返不等于原文）
    expect(migratePlaintextAccounts(lying, projects)).toMatchObject({ changed: false, ok: false })
  })

  it('review 修正：手动改密同样回验——解密抛错/返回错值 → 拒绝保存（旧值保留在调用方）', () => {
    const stored = [acct({ id: 'a1', password: encryptPassword(ok, '旧密码')! })]
    const input = [{ id: 'a1', label: '管理员', username: 'admin', role: 'r', password: '新密码' }]
    // 加密成功但解密抛错
    expect(() => mergeAccounts(broken, stored, input)).toThrow('加密校验未通过')
    // 加密成功但解密返回错值
    expect(() => mergeAccounts(lying, stored, input)).toThrow('加密校验未通过')
    // 正常加密器不受影响
    expect(() => mergeAccounts(ok, stored, input)).not.toThrow()
  })

  it('无明文 → 不变更', () => {
    const projects = [proj([acct({ password: encryptPassword(ok, 'x')! })])]
    expect(migratePlaintextAccounts(ok, projects)).toMatchObject({ changed: false, encrypted: 0, ok: true })
  })
})

describe('selfTest（实测取证）', () => {
  it('往返成功 / 不可用 / 解密坏', () => {
    expect(selfTest(ok)).toEqual({ available: true, roundtrip: true })
    expect(selfTest(unavailable)).toEqual({ available: false, roundtrip: false })
    expect(selfTest(broken)).toEqual({ available: true, roundtrip: false })
  })
})

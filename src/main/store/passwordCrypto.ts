import type { Account, AccountInput, Project, StoredAccount, StoredPassword } from '../../shared/types'

// 密码加密（hardening 批次四）：Electron safeStorage（macOS 钥匙串）落盘加密。
// 原则：类型判别密文（不嗅探内容）；解密失败保留密文、显示「暂不可用」，
// 绝不空密码覆盖、不当损坏处理；明文迁移「全有或全无」——全部加密成功才
// 原子替换文件；密文绝不经 IPC 回传；密码未改动（undefined 哨兵）原样保留。

/** safeStorage 的最小面（真实现由主进程注入，测试注入假加密器） */
export interface SafeCrypto {
  isEncryptionAvailable(): boolean
  encryptString(plain: string): Buffer
  decryptString(encrypted: Buffer): string
}

/** 加密一个明文密码 → 密文对象；不可用或失败 → null（调用方决定报错或保留） */
export function encryptPassword(c: SafeCrypto, plain: string): { enc: 'v1'; data: string } | null {
  try {
    if (!c.isEncryptionAvailable()) return null
    return { enc: 'v1', data: c.encryptString(plain).toString('base64') }
  } catch {
    return null
  }
}

/** 加密并回验（review 修正）：加密 → 解密 → 与原文比对，三者全过才返回密文。
 *  防"加密成功、解密失败"的钥匙串状态——任何一环失败返回 null，调用方拒绝
 *  保存、保留原值。迁移与手动保存共用同一方法 */
export function encryptVerified(c: SafeCrypto, plain: string): { enc: 'v1'; data: string } | null {
  const enc = encryptPassword(c, plain)
  if (!enc) return null
  const back = decryptStored(c, enc)
  if (back.locked || back.value !== plain) return null
  return enc
}

/** 解密落盘密码：明文（旧数据）原样返回；解密成功返回明文；
 *  失败/未知版本 → locked（保留密文由调用方处置），绝不返回空密码冒充真值 */
export function decryptStored(
  c: SafeCrypto,
  p: StoredPassword
): { value: string | null; locked: boolean } {
  if (typeof p === 'string') return { value: p, locked: false }
  if (p.enc !== 'v1') return { value: null, locked: true } // 未知加密版本：保留不覆盖
  try {
    if (!c.isEncryptionAvailable()) return { value: null, locked: true }
    return { value: c.decryptString(Buffer.from(p.data, 'base64')), locked: false }
  } catch {
    return { value: null, locked: true }
  }
}

/** 落盘账号 → 渲染层账号（解密；密文不外泄；失败给 locked 标记 + 空密码） */
export function accountToRenderer(c: SafeCrypto, a: StoredAccount): Account {
  const { value, locked } = decryptStored(c, a.password)
  const out: Account = {
    id: a.id, label: a.label, username: a.username,
    password: value ?? '',
    role: a.role
  }
  if (locked) out.passwordLocked = true
  return out
}

export function projectToRenderer(c: SafeCrypto, p: Project): Project {
  return { ...p, accounts: (p.accounts as unknown as StoredAccount[]).map(a => accountToRenderer(c, a)) }
}

/** 合并渲染层提交：password 缺省（未改动）→ 原样保留存储值（密文字节不动）；
 *  空字符串是合法密码（新账号允许无密码/用户主动清空，review 修正）→ 存空串
 *  明文形态；非空值 → 加密；新账号完全缺密码字段 → 抛错；加密不可用且有新
 *  密码 → 抛错（不落明文） */
export function mergeAccounts(c: SafeCrypto, stored: StoredAccount[], incoming: AccountInput[]): StoredAccount[] {
  const storedById = new Map(stored.map(a => [a.id, a]))
  return incoming.map(inA => {
    const prev = storedById.get(inA.id)
    if (inA.password === undefined) {
      if (!prev) throw new Error(`账号「${inA.label || inA.username}」缺少密码`)
      // 未改动：除密码外的字段更新，密码原样透传（密文/旧明文都不动）
      return { ...inA, password: prev.password } as StoredAccount
    }
    if (inA.password === '') return { ...inA, password: '' }
    const enc = encryptVerified(c, inA.password)
    if (!enc) throw new Error('系统钥匙串不可用或加密校验未通过，已保留原密码（可稍后重试）')
    return { ...inA, password: enc }
  })
}

/** 明文迁移（启动时）：存在明文（旧数据）→ 加密全部明文；任一失败 → 整体不动
 *  （下次启动重试）。ok 时返回迁移后的项目草稿（changed 才需要落盘） */
export function migratePlaintextAccounts(
  c: SafeCrypto,
  projects: Project[]
): { changed: boolean; encrypted: number; ok: boolean; projects?: Project[] } {
  let encrypted = 0
  let failed = false
  // 落盘形态（StoredProject）与 Project 运行时同构，仅密码字段类型不同——受控转换
  const draft = projects.map(p => ({
    ...p,
    accounts: (p.accounts as unknown as StoredAccount[]).map((a): StoredAccount => {
      if (typeof a.password !== 'string') return a
      // 加密并回验（共用 encryptVerified）：防"加密成功、解密失败"的钥匙串状态
      const enc = encryptVerified(c, a.password)
      if (!enc) {
        failed = true
        return a
      }
      encrypted++
      return { ...a, password: enc }
    })
  }))
  if (failed) return { changed: false, encrypted: 0, ok: false }
  return { changed: encrypted > 0, encrypted, ok: true, projects: draft as unknown as Project[] }
}

/** 实测取证用：safeStorage 可用性 + 本进程加解密往返自检 */
export function selfTest(c: SafeCrypto): { available: boolean; roundtrip: boolean } {
  const probe = 'pt-selftest-适用'
  try {
    if (!c.isEncryptionAvailable()) return { available: false, roundtrip: false }
    const enc = encryptPassword(c, probe)
    if (!enc) return { available: true, roundtrip: false }
    const dec = decryptStored(c, enc)
    return { available: true, roundtrip: dec.value === probe && !dec.locked }
  } catch {
    return { available: false, roundtrip: false }
  }
}

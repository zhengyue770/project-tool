import { describe, it, expect } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { backupOf, cleanupUpdateSessions, openUpdateSession, sessionDirOf } from './session'

// hardening 2c：更新会话的独占创建与记录式清理。清理四条件（应用路径/版本/
// phase=applied/备份路径推导一致）+ 边界符号链接拒绝，全过才删；任何不确定 → 保留并报告。

const TOKEN = '0123456789abcdef'

/** 造一个"已完成更新"形态的会话（可覆写 phase / 记录字段 / 备份路径） */
function setupSession(over: {
  phase?: string | null
  recordOver?: Record<string, unknown>
  backupOverride?: string
} = {}): { base: string; userData: string; appPath: string; backup: string } {
  const base = mkdtempSync(join(tmpdir(), 'pt-sess-'))
  const userData = join(base, 'user')
  const appPath = join(base, 'apps', '项目启动器.app')
  const dir = sessionDirOf(userData, TOKEN)
  const backup = over.backupOverride ?? backupOf(appPath, TOKEN)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'record.json'), JSON.stringify({
    token: TOKEN, oldVersion: '1.2.0', newVersion: '1.3.0', appPath, backup,
    ...over.recordOver
  }))
  if (over.phase !== null) writeFileSync(join(dir, 'phase'), over.phase ?? 'applied')
  const prev = join(backup, 'prev.app')
  mkdirSync(join(prev, 'Contents'), { recursive: true })
  writeFileSync(join(prev, 'Contents', 'Info.plist'), '{}')
  return { base, userData, appPath, backup }
}

describe('openUpdateSession（独占创建）', () => {
  it('创建会话目录/备份容器/暂存容器并写记录', () => {
    const base = mkdtempSync(join(tmpdir(), 'pt-sess-'))
    const userData = join(base, 'user')
    const appPath = join(base, 'app', 'X.app')
    mkdirSync(join(base, 'app'), { recursive: true }) // 应用所在目录已存在（真实场景即应用自身目录）
    const s = openUpdateSession(userData, appPath, '1.2.0', '1.3.0', TOKEN)
    expect(s?.record).toEqual({
      token: TOKEN, oldVersion: '1.2.0', newVersion: '1.3.0',
      appPath, backup: backupOf(appPath, TOKEN)
    })
    expect(s?.sessionDir).toBe(sessionDirOf(userData, TOKEN))
    rmSync(base, { recursive: true, force: true })
  })

  it('同 token 已存在（残留）→ null；备份位置有异物 → null 且不留半成品', () => {
    const base = mkdtempSync(join(tmpdir(), 'pt-sess-'))
    const userData = join(base, 'user')
    const appPath = join(base, 'app', 'X.app')
    mkdirSync(join(base, 'app'), { recursive: true })
    expect(openUpdateSession(userData, appPath, '1.2.0', '1.3.0', TOKEN)).not.toBeNull()
    expect(openUpdateSession(userData, appPath, '1.2.0', '1.3.0', TOKEN)).toBeNull()

    const base2 = mkdtempSync(join(tmpdir(), 'pt-sess-'))
    const appPath2 = join(base2, 'app', 'Y.app')
    mkdirSync(join(base2, 'app'), { recursive: true })
    mkdirSync(backupOf(appPath2, TOKEN), { recursive: true }) // 应用旁预置异物
    expect(openUpdateSession(join(base2, 'user'), appPath2, '1.2.0', '1.3.0', TOKEN)).toBeNull()
    // 创建成功过的部分（会话目录）被回滚，不残留
    expect(existsSync(sessionDirOf(join(base2, 'user'), TOKEN))).toBe(false)
    rmSync(base, { recursive: true, force: true })
    rmSync(base2, { recursive: true, force: true })
  })
})

describe('cleanupUpdateSessions（记录式清理）', () => {
  it('四条件全满足 → 删除备份容器与会话目录', () => {
    const { base, userData, appPath, backup } = setupSession()
    const r = cleanupUpdateSessions(userData, appPath, '1.3.0')
    expect(r.removed).toEqual([backup])
    expect(r.kept).toEqual([])
    expect(existsSync(backup)).toBe(false)
    rmSync(base, { recursive: true, force: true })
  })

  it('版本不符 / 无 phase / phase 非 applied → 保留并给原因', () => {
    for (const [name, over, version] of [
      ['版本不符', {}, '1.2.0'],
      ['无 phase', { phase: null }, '1.3.0'],
      ['phase 非 applied', { phase: 'spawned' }, '1.3.0']
    ] as const) {
      const { base, userData, appPath, backup } = setupSession(over)
      const r = cleanupUpdateSessions(userData, appPath, version)
      expect(r.removed, name).toEqual([])
      expect(r.kept, name).toHaveLength(1)
      expect(existsSync(backup), name).toBe(true)
      rmSync(base, { recursive: true, force: true })
    }
  })

  it('应用路径不符 / 备份路径与推导不一致 → 保留', () => {
    {
      const { base, userData, appPath } = setupSession()
      const r = cleanupUpdateSessions(userData, appPath + '.moved', '1.3.0')
      expect(r.removed).toEqual([])
      expect(r.kept[0]!.reason).toContain('应用路径')
      rmSync(base, { recursive: true, force: true })
    }
    {
      const { base, userData, appPath } = setupSession({ backupOverride: join(mkdtempSync(join(tmpdir(), 'pt-sess-')), 'elsewhere', 'backup') })
      const r = cleanupUpdateSessions(userData, appPath, '1.3.0')
      expect(r.removed).toEqual([])
      expect(r.kept[0]!.reason).toContain('备份路径')
      rmSync(base, { recursive: true, force: true })
    }
  })

  it('会话目录名非 token 格式 / 记录 token 不符 → 保留', () => {
    const base = mkdtempSync(join(tmpdir(), 'pt-sess-'))
    const userData = join(base, 'user')
    const appPath = join(base, 'X.app')
    const bad = join(userData, 'update-sessions', 'not-a-token!!')
    mkdirSync(bad, { recursive: true })
    const dir = join(userData, 'update-sessions', 'ffffffffffffffff')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'record.json'), JSON.stringify({
      token: 'differenttoken00', oldVersion: '1.2.0', newVersion: '1.3.0',
      appPath, backup: backupOf(appPath, 'ffffffffffffffff')
    }))
    const r = cleanupUpdateSessions(userData, appPath, '1.3.0')
    expect(r.removed).toEqual([])
    expect(r.kept.some(k => k.dir === bad && k.reason.includes('token'))).toBe(true)
    expect(r.kept.some(k => k.dir === dir && k.reason.includes('token'))).toBe(true)
    rmSync(base, { recursive: true, force: true })
  })
  it('备份边界路径是符号链接 → 拒绝删除，指向的真实内容不被动', () => {
    const { base, userData, appPath, backup } = setupSession()
    const stash = backup + '.stash'
    renameSync(backup, stash)
    symlinkSync(stash, backup) // 备份容器换成符号链接
    const r = cleanupUpdateSessions(userData, appPath, '1.3.0')
    expect(r.removed).toEqual([])
    expect(r.kept[0]!.reason).toContain('符号链接')
    expect(existsSync(stash)).toBe(true)
    rmSync(base, { recursive: true, force: true })
  })

  it('备份内无 prev.app → 保留', () => {
    const { base, userData, appPath, backup } = setupSession()
    rmSync(join(backup, 'prev.app'), { recursive: true, force: true })
    const r = cleanupUpdateSessions(userData, appPath, '1.3.0')
    expect(r.removed).toEqual([])
    expect(r.kept[0]!.reason).toContain('prev.app')
    rmSync(base, { recursive: true, force: true })
  })
})

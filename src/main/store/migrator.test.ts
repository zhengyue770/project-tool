import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, readdirSync, rmSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { StoragePaths } from './storagePaths'
import { migrateDataDir, canWrite, DATA_FILES } from './migrator'

function tmp(): string { return mkdtempSync(join(tmpdir(), 'pt-test-')) }
function seed(dir: string): void {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'projects.json'), JSON.stringify({ version: 1, projects: [{ id: 'p1' }] }))
  writeFileSync(join(dir, 'settings.json'), JSON.stringify({ startupTimeoutMs: 60000, autoLaunch: false }))
}

describe('migrateDataDir', () => {
  it('目标不存在 → 失败', () => {
    const base = tmp(); const paths = new StoragePaths(join(base, 'default'))
    const r = migrateDataDir(paths, join(base, 'nope'))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('不存在')
    rmSync(base, { recursive: true, force: true })
  });

  it('目标已有 projects.json → 失败防覆盖（错误点名文件）', () => {
    const base = tmp(); const def = join(base, 'default'); const target = join(base, 'target')
    seed(def); seed(target)
    const paths = new StoragePaths(def)
    const r = migrateDataDir(paths, target)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('projects.json')
    rmSync(base, { recursive: true, force: true })
  });

  it('hardening 1c：目标已有 settings.json（即使无 projects.json）→ 同样拒绝', () => {
    const base = tmp(); const def = join(base, 'default'); const target = join(base, 'target')
    seed(def); mkdirSync(target, { recursive: true })
    writeFileSync(join(target, 'settings.json'), '{}')
    const r = migrateDataDir(new StoragePaths(def), target)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('settings.json')
    rmSync(base, { recursive: true, force: true })
  });

  it('正常迁移：文件复制、指针切换、原目录保留、无探针残留', () => {
    const base = tmp(); const def = join(base, 'default'); const target = join(base, 'target')
    seed(def); mkdirSync(target, { recursive: true })
    const paths = new StoragePaths(def)
    const r = migrateDataDir(paths, target)
    expect(r.ok).toBe(true)
    expect(paths.getDataDir()).toBe(target)
    expect(existsSync(join(target, 'projects.json'))).toBe(true)
    expect(existsSync(join(target, 'settings.json'))).toBe(true)
    expect(existsSync(join(def, 'projects.json'))).toBe(true) // 原目录保留
    expect(readFileSync(join(target, 'projects.json'), 'utf8')).toContain('p1')
    expect(readdirSync(target).filter(n => n.startsWith('.pt-write-probe'))).toEqual([])
    rmSync(base, { recursive: true, force: true })
  });

  it('目标不可写 → 失败且指针不变', () => {
    const base = tmp(); const def = join(base, 'default'); const target = join(base, 'ro')
    seed(def); mkdirSync(target, { recursive: true }); chmodSync(target, 0o555)
    const paths = new StoragePaths(def)
    const r = migrateDataDir(paths, target)
    expect(r.ok).toBe(false)
    expect(paths.getDataDir()).toBe(def)
    chmodSync(target, 0o755)
    rmSync(base, { recursive: true, force: true })
  })

  it('验收场景 1：复制中途失败 → 回滚已创建文件，重试可成功', () => {
    const base = tmp(); const def = join(base, 'default'); const target = join(base, 'target')
    seed(def); mkdirSync(target, { recursive: true })
    const locked = join(def, 'settings.json')
    chmodSync(locked, 0o000) // settings 复制失败（projects.json 已复制过去）
    try {
      const r = migrateDataDir(new StoragePaths(def), target)
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.error).toContain('迁移失败')
      // 回滚：目标目录不含任何数据文件 → 重试不被自己挡住
      expect(readdirSync(target).filter(n => DATA_FILES.includes(n as never))).toEqual([])
    } finally {
      chmodSync(locked, 0o644)
    }
    expect(migrateDataDir(new StoragePaths(def), target).ok).toBe(true)
    rmSync(base, { recursive: true, force: true })
  })

  it('验收场景 2：指针写入失败 → 复制的文件回滚、重试可成功', () => {
    const base = tmp(); const def = join(base, 'default'); const target = join(base, 'target')
    seed(def); mkdirSync(target, { recursive: true })
    class BadPointer extends StoragePaths {
      fail = true
      override setDataDir(dir: string): void {
        if (this.fail) throw new Error('EIO: 模拟指针写失败')
        super.setDataDir(dir)
      }
    }
    const bad = new BadPointer(def)
    const r = migrateDataDir(bad, target)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('迁移失败')
    expect(readdirSync(target).filter(n => DATA_FILES.includes(n as never))).toEqual([])
    bad.fail = false
    expect(migrateDataDir(bad, target).ok).toBe(true)
    rmSync(base, { recursive: true, force: true })
  })

  it('验收场景 3：目录中已有他人同名探针文件 → 不误删，迁移照常', () => {
    const base = tmp(); const def = join(base, 'default'); const target = join(base, 'target')
    seed(def); mkdirSync(target, { recursive: true })
    const foreign = join(target, '.pt-write-probe-deadbeef')
    writeFileSync(foreign, '别人的文件')
    const r = migrateDataDir(new StoragePaths(def), target)
    expect(r.ok).toBe(true)
    expect(existsSync(foreign)).toBe(true) // 未被截断/删除
    rmSync(base, { recursive: true, force: true })
  })

  it('review 修正：EEXIST 撞名真正走到 → 换名重试成功、撞名文件保留；三次全撞 → 判不可写', () => {
    const target = tmp()
    // 注入固定名序列：前两次撞名（文件已存在），第三次新名 → 探测成功
    const names = ['collide', 'collide', 'fresh']
    let i = 0
    writeFileSync(join(target, 'collide'), '别人的')
    expect(canWrite(target, () => names[i++]!)).toBe(true)
    expect(readFileSync(join(target, 'collide'), 'utf8')).toBe('别人的')
    expect(readdirSync(target).filter(n => n.startsWith('.pt-write-probe'))).toEqual([]) // 自己的探针已清理

    // 三次全撞名（注入恒定名）→ 放弃并判不可写
    expect(canWrite(target, () => 'collide')).toBe(false)
    expect(readFileSync(join(target, 'collide'), 'utf8')).toBe('别人的') // 仍完好
    rmSync(target, { recursive: true, force: true })
  })
})

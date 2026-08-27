import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { StoragePaths } from './storagePaths'
import { migrateDataDir } from './migrator'

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

  it('目标已有 projects.json → 失败防覆盖', () => {
    const base = tmp(); const def = join(base, 'default'); const target = join(base, 'target')
    seed(def); seed(target)
    const paths = new StoragePaths(def)
    const r = migrateDataDir(paths, target)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('已有项目数据')
    rmSync(base, { recursive: true, force: true })
  });

  it('正常迁移：文件复制、指针切换、原目录保留', () => {
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
})

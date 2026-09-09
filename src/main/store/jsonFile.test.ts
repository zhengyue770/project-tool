import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync, writeSync, existsSync, readFileSync, readdirSync, rmSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ProjectsStore, EMPTY_PROJECTS } from './projectsStore'
import { SettingsStore, DEFAULT_SETTINGS } from './settingsStore'
import { RuntimeStore } from './runtimeStore'
import { StoragePaths } from './storagePaths'
import { writeJsonAtomic } from './jsonFile'
import type { Project } from '../../shared/types'

function tmp(): string { return mkdtempSync(join(tmpdir(), 'pt-test-')) }
const proj: Project = {
  id: 'p1', name: '演示', path: '/tmp/x',
  commands: [{ id: 'c1', name: '前端', cmd: 'npm run dev', workdir: '.', port: 8080 }],
  urls: [{ id: 'u1', name: '首页', url: 'http://localhost:8080' }],
  accounts: [{ id: 'a1', label: '管理员', username: 'admin', password: '123', role: '管理员' }],
  createdAt: 1
}

describe('ProjectsStore', () => {
  it('空目录 load 返回空结构', () => {
    const dir = tmp(); const s = new ProjectsStore(() => dir)
    expect(s.load()).toEqual(EMPTY_PROJECTS)
    rmSync(dir, { recursive: true, force: true })
  })
  it('upsert 新增与更新、remove 删除', () => {
    const dir = tmp(); const s = new ProjectsStore(() => dir)
    s.upsert(proj)
    expect(s.load().projects).toHaveLength(1)
    s.upsert({ ...proj, name: '改名' })
    expect(s.load().projects[0].name).toBe('改名')
    expect(s.load().projects).toHaveLength(1)
    s.remove('p1')
    expect(s.load().projects).toHaveLength(0)
    rmSync(dir, { recursive: true, force: true })
  })
  it('损坏的 projects.json 备份为 .bak 并重建', () => {
    const dir = tmp(); const file = join(dir, 'projects.json')
    writeFileSync(file, 'not json')
    const s = new ProjectsStore(() => dir)
    expect(s.load()).toEqual(EMPTY_PROJECTS)
    expect(existsSync(file + '.bak')).toBe(true)
    rmSync(dir, { recursive: true, force: true })
  })
  it('损坏时 load(onCorrupt) 回调收到 .bak 路径（主进程据此弹窗）', () => {
    const dir = tmp(); const file = join(dir, 'projects.json')
    writeFileSync(file, 'not json')
    const s = new ProjectsStore(() => dir)
    const baks: string[] = []
    expect(s.load(bak => baks.push(bak))).toEqual(EMPTY_PROJECTS)
    expect(baks).toEqual([file + '.bak'])
    rmSync(dir, { recursive: true, force: true })
  })
  it('save 后无 .tmp 残留（原子写）', () => {
    const dir = tmp(); const s = new ProjectsStore(() => dir)
    s.upsert(proj)
    expect(existsSync(join(dir, 'projects.json.tmp'))).toBe(false)
    rmSync(dir, { recursive: true, force: true })
  })
})

describe('SettingsStore', () => {
  it('空目录返回默认值；save/load 往返', () => {
    const dir = tmp(); const s = new SettingsStore(() => dir)
    expect(s.load()).toEqual(DEFAULT_SETTINGS)
    s.save({ startupTimeoutMs: 30000, autoLaunch: true })
    expect(s.load()).toEqual({ startupTimeoutMs: 30000, autoLaunch: true })
    rmSync(dir, { recursive: true, force: true })
  })
})

describe('RuntimeStore', () => {
  it('save/load 往返', () => {
    const dir = tmp(); const s = new RuntimeStore(() => dir)
    s.save({ 'p1:c1': { pid: 123, startedAt: 456 } })
    expect(s.load()).toEqual({ 'p1:c1': { pid: 123, startedAt: 456 } })
    rmSync(dir, { recursive: true, force: true })
  })
})

describe('writeJsonAtomic（review 修正回归）', () => {
  it('临时路径撞名（EEXIST）→ 抛错且他人的临时文件原样保留', () => {
    const dir = tmp()
    const target = join(dir, 'data.json')
    const foreign = join(dir, 'data.json.tmp-fixed')
    writeFileSync(foreign, '别人的文件')
    expect(() => writeJsonAtomic(target, { a: 1 }, () => foreign)).toThrow()
    expect(readFileSync(foreign, 'utf8')).toBe('别人的文件') // 未被删除/截断
    expect(existsSync(target)).toBe(false) // 目标未被写入
    rmSync(dir, { recursive: true, force: true })
  })

  it('默认随机路径正常写入且无 .tmp-* 残留', () => {
    const dir = tmp()
    const target = join(dir, 'data.json')
    writeJsonAtomic(target, { a: 1 })
    expect(readFileSync(target, 'utf8')).toBe(JSON.stringify({ a: 1 }, null, 2))
    expect(existsSync(join(dir, 'data.json.tmp-fixed'))).toBe(false)
    writeJsonAtomic(target, { a: 2 }) // 覆盖写
    expect(readFileSync(target, 'utf8')).toBe(JSON.stringify({ a: 2 }, null, 2))
    rmSync(dir, { recursive: true, force: true })
  })

  it('review 修正：短写不抛错（每次只写 7 字节）→ 循环写完整，最终文件完整', () => {
    const dir = tmp()
    const target = join(dir, 'data.json')
    const data = { a: 'x'.repeat(200) }
    // 模拟 write(2) 的合法短写行为：写部分、如实返回字节数、不抛错
    const slow: Parameters<typeof writeJsonAtomic>[3] = (fd, buf, offset, length) =>
      writeSync(fd, buf, offset, Math.min(7, length))
    writeJsonAtomic(target, data, undefined, slow)
    expect(readFileSync(target, 'utf8')).toBe(JSON.stringify(data, null, 2))
    rmSync(dir, { recursive: true, force: true })
  })

  it('review 修正：部分写入后报错（模拟 ENOSPC）→ 抛错、原文件不被替换、自己的临时文件清理', () => {
    const dir = tmp()
    const target = join(dir, 'data.json')
    writeFileSync(target, '原始数据')
    const enospc: Parameters<typeof writeJsonAtomic>[3] = (fd, buf, offset, length) => {
      writeSync(fd, buf, offset, Math.min(5, length)) // 先写一部分
      throw Object.assign(new Error('模拟磁盘满'), { code: 'ENOSPC' }) // 错误延迟暴露
    }
    expect(() => writeJsonAtomic(target, { a: 1 }, undefined, enospc)).toThrow('模拟磁盘满')
    expect(readFileSync(target, 'utf8')).toBe('原始数据') // rename 未发生，原数据完好
    expect(readdirSync(dir).filter(n => n.includes('.tmp-'))).toEqual([]) // 自己的临时文件已清理
    rmSync(dir, { recursive: true, force: true })
  })

  it('review 建议：写入返回 0 → 报错、旧数据不变、自己的临时文件清理', () => {
    const dir = tmp()
    const target = join(dir, 'data.json')
    writeFileSync(target, '原始数据')
    const zero: Parameters<typeof writeJsonAtomic>[3] = () => 0 // 不推进的死循环源
    expect(() => writeJsonAtomic(target, { a: 1 }, undefined, zero)).toThrow('非正数')
    expect(readFileSync(target, 'utf8')).toBe('原始数据') // rename 未发生
    expect(readdirSync(dir).filter(n => n.includes('.tmp-'))).toEqual([]) // 自己的临时文件已清理
    rmSync(dir, { recursive: true, force: true })
  })
})

describe('指针原子写（review 修正回归）', () => {
  it('真实指针写失败（目录只读）→ 旧指针完好、getDataDir 不变', () => {
    const base = tmp()
    const def = join(base, 'default')
    const paths = new StoragePaths(def)
    paths.setDataDir(join(base, 'v1')) // 先落一个有效指针
    expect(paths.getDataDir()).toBe(join(base, 'v1'))
    chmodSync(def, 0o555) // 临时文件创建失败 → writeJsonAtomic 抛错
    try {
      expect(() => paths.setDataDir(join(base, 'v2'))).toThrow()
    } finally {
      chmodSync(def, 0o755)
    }
    expect(paths.getDataDir()).toBe(join(base, 'v1')) // 旧指针未被截断，读回原值
    rmSync(base, { recursive: true, force: true })
  })
})

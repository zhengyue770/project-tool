import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ProjectsStore, EMPTY_PROJECTS } from './projectsStore'
import { SettingsStore, DEFAULT_SETTINGS } from './settingsStore'
import { RuntimeStore } from './runtimeStore'
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

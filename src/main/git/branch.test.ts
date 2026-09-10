import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Project } from '../../shared/types'
import { currentBranch, readBranchList, GitBranchService } from './branch'

// git 分支切换（spec 2026-09-04-git-branch）：纯解析函数单测 + 真实临时仓库
// 集成验证（与 manager 测试同风格：真实进程）。git 不可用时跳过集成部分。

let hasGit = true
try { execFileSync('git', ['--version']) } catch { hasGit = false }

function tmpRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'pt-git-'))
  const run = (args: string[]): void => {
    execFileSync('git', ['-C', dir, '-c', 'user.email=t@t', '-c', 'user.name=t', ...args])
  }
  run(['init'])
  run(['commit', '--allow-empty', '-m', 'init'])
  run(['branch', 'dev'])
  return dir
}

describe.skipIf(!hasGit)('git 分支（真实仓库集成）', () => {
  it('currentBranch：正常仓库返回分支名；非 git 目录返回 null', async () => {
    const repo = tmpRepo()
    expect(await currentBranch(repo)).toBeTruthy()
    const plain = mkdtempSync(join(tmpdir(), 'pt-nogit-'))
    expect(await currentBranch(plain)).toBeNull()
  })

  it('readBranchList：本地分支 + 当前分支 + 脏文件计数', async () => {
    const repo = tmpRepo()
    writeFileSync(join(repo, 'a.txt'), 'dirty')
    const info = await readBranchList(repo)
    expect(info).not.toBeNull()
    expect(info!.locals).toContain('dev')
    expect(info!.current).not.toBe('HEAD')
    expect(info!.dirtyCount).toBe(1)
  })

  it('GitBranchService：switch 切换分支并更新缓存；list 返回完整信息', async () => {
    const repo = tmpRepo()
    const project: Project = {
      id: 'p1', name: 't', path: repo,
      commands: [{ id: 'c1', name: 'srv', cmd: 'true', workdir: '.', port: 1 }],
      urls: [], accounts: [], createdAt: 0
    }
    const svc = new GitBranchService(() => [project])
    await svc.refreshAll()
    const before = svc.cachedOf('p1')
    expect(typeof before).toBe('string')

    const list = await svc.list('p1')
    expect(list!.locals).toContain('dev')
    expect(list!.dirtyCount).toBe(0)

    await svc.switch('p1', 'dev')
    expect(svc.cachedOf('p1')).toBe('dev')
  })

  it('switchBranch 失败（分支不存在）→ 抛出含 git 错误信息的异常', async () => {
    const repo = tmpRepo()
    const project: Project = {
      id: 'p1', name: 't', path: repo,
      commands: [{ id: 'c1', name: 'srv', cmd: 'true', workdir: '.', port: 1 }],
      urls: [], accounts: [], createdAt: 0
    }
    const svc = new GitBranchService(() => [project])
    await expect(svc.switch('p1', 'no-such-branch')).rejects.toThrow()
  })

  it('非 git 项目：list 返回 null、缓存为 null（界面隐藏分支入口）', async () => {
    const plain = mkdtempSync(join(tmpdir(), 'pt-nogit-'))
    const project: Project = {
      id: 'p1', name: 't', path: plain,
      commands: [{ id: 'c1', name: 'srv', cmd: 'true', workdir: '.', port: 1 }],
      urls: [], accounts: [], createdAt: 0
    }
    const svc = new GitBranchService(() => [project])
    await svc.refreshAll()
    expect(svc.cachedOf('p1')).toBeNull()
    expect(await svc.list('p1')).toBeNull()
  })

  it('竞态守卫：刷新期间项目路径变更，旧路径的迟到结果不覆盖新缓存', async () => {
    // A、B 两个仓库当前分支不同；第一次刷新(A)未完成时路径改为 B 并发起第二次刷新，
    // 断言 A 的迟到完成被丢弃（返回 null、缓存保持 B 的分支）
    const repoA = tmpRepo()
    execFileSync('git', ['-C', repoA, 'switch', 'dev'])
    const repoB = tmpRepo() // 默认分支

    let projects: Project[] = [{
      id: 'p1', name: 't', path: repoA,
      commands: [{ id: 'c1', name: 'srv', cmd: 'true', workdir: '.', port: 1 }],
      urls: [], accounts: [], createdAt: 0
    }]
    const svc = new GitBranchService(() => projects)

    const first = svc.refresh('p1') // 同步段内已捕获路径 A，git 调用进行中
    projects = [{ ...projects[0]!, path: repoB }] // 模拟用户保存了新路径
    const second = await svc.refresh('p1') // B 的刷新完成并写入缓存

    expect(second).toBeTruthy()
    expect(await first).toBeNull() // A 的迟到结果被竞态守卫丢弃
    expect(svc.cachedOf('p1')).toBe(second) // 缓存未被 A 覆盖
    expect(svc.cachedOf('p1')).not.toBe('dev')
  })

  it('竞态守卫：list 的迟到结果同样丢弃', async () => {
    const repoA = tmpRepo()
    execFileSync('git', ['-C', repoA, 'switch', 'dev'])
    const repoB = tmpRepo()
    let projects: Project[] = [{
      id: 'p1', name: 't', path: repoA,
      commands: [{ id: 'c1', name: 'srv', cmd: 'true', workdir: '.', port: 1 }],
      urls: [], accounts: [], createdAt: 0
    }]
    const svc = new GitBranchService(() => projects)
    const first = svc.list('p1')
    projects = [{ ...projects[0]!, path: repoB }]
    await svc.list('p1')
    expect(await first).toBeNull()
    expect(svc.cachedOf('p1')).not.toBe('dev')
  })
})

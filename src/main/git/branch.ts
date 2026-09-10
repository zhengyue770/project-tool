import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { BranchList, Project } from '../../shared/types'

// git 分支切换（spec 2026-09-04-git-branch）：直接 execFile 调 git（零依赖，
// 与项目风格一致），-C 指定仓库；git switch 切换，仅提供本地分支。
// 当前分支由主进程缓存，分支列表/切换按需读取，避免每次列表刷新都跑 git。

const execFileAsync = promisify(execFile)
const GIT_TIMEOUT_MS = 10_000

async function git(repo: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', ['-C', repo, ...args], { timeout: GIT_TIMEOUT_MS })
  return stdout
}

/** 当前分支名；非 git 仓库 / git 不可用 / 空仓库（无提交）→ null */
export async function currentBranch(repo: string): Promise<string | null> {
  try {
    const out = (await git(repo, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim()
    return out || null
  } catch {
    return null
  }
}

export async function readBranchList(repo: string): Promise<BranchList | null> {
  const current = await currentBranch(repo)
  if (current === null) return null
  const [localsRaw, statusRaw] = await Promise.all([
    git(repo, ['branch', '--format=%(refname:short)']),
    git(repo, ['status', '--porcelain']).catch(() => '')
  ])
  return {
    current,
    locals: localsRaw.split('\n').map(s => s.trim()).filter(Boolean),
    dirtyCount: statusRaw.split('\n').filter(l => l.trim()).length
  }
}

export async function switchBranch(repo: string, name: string): Promise<void> {
  const branch = name.trim()
  if (!branch) throw new Error('分支名不能为空')
  try {
    await git(repo, ['switch', branch])
  } catch (err) {
    const stderr = String((err as { stderr?: string }).stderr ?? '')
    throw new Error(stderr.split('\n').find(l => l.trim()) || '切换分支失败')
  }
}

/** 主进程侧的分支缓存：projects:list 组装视图零开销；启动批量预热，
 *  弹出分支列表/切换成功后按需刷新并推送事件 */
export class GitBranchService {
  private cache = new Map<string, string | null>()
  private listener?: (projectId: string) => void

  constructor(private getProjects: () => Project[]) {}

  setOnChange(cb: (projectId: string) => void): void { this.listener = cb }

  /** undefined=未读取；null=非 git 仓库；string=分支名 */
  cachedOf(projectId: string): string | null | undefined {
    return this.cache.get(projectId)
  }

  async refresh(projectId: string): Promise<string | null> {
    const p = this.getProjects().find(x => x.id === projectId)
    if (!p) return null
    const b = await currentBranch(p.path)
    // 竞态守卫：git 执行期间项目路径可能已被改（保存新路径会触发第二次刷新），
    // 旧路径的迟到结果不得覆盖新缓存；项目已删除同理不回填已清理的条目
    const now = this.getProjects().find(x => x.id === projectId)
    if (!now || now.path !== p.path) return null
    this.cache.set(projectId, b)
    return b
  }

  async refreshAll(): Promise<void> {
    await Promise.all(this.getProjects().map(async p => {
      await this.refresh(p.id)
      this.listener?.(p.id)
    }))
  }

  async list(projectId: string): Promise<BranchList | null> {
    const p = this.getProjects().find(x => x.id === projectId)
    if (!p) return null
    const info = await readBranchList(p.path)
    // 竞态守卫：同 refresh——迟到于路径变更的旧结果整体丢弃（含缓存写入）
    const now = this.getProjects().find(x => x.id === projectId)
    if (!now || now.path !== p.path) return null
    if (info) this.cache.set(projectId, info.current)
    return info
  }

  async switch(projectId: string, name: string): Promise<void> {
    const p = this.getProjects().find(x => x.id === projectId)
    if (!p) throw new Error('项目不存在')
    await switchBranch(p.path, name)
    await this.refresh(projectId)
    this.listener?.(projectId)
  }

  /** 项目删除后清掉缓存条目 */
  evict(projectId: string): void {
    this.cache.delete(projectId)
  }
}

import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { Project, ProjectsFile } from '../../shared/types'
import { readJson, writeJsonAtomic } from './jsonFile'

export const EMPTY_PROJECTS: ProjectsFile = { version: 1, projects: [] }

export class ProjectsStore {
  constructor(private dir: () => string) {}

  private file(): string { return join(this.dir(), 'projects.json') }

  /** 损坏回调（spec §8 界面提示）：主进程启动时传入以弹窗告知；其余调用点仅 console.warn */
  load(onCorrupt?: (bak: string) => void): ProjectsFile {
    const pf = readJson<ProjectsFile>(this.file(), EMPTY_PROJECTS, bak => {
      console.warn(`projects.json 损坏，已备份到 ${bak}`)
      onCorrupt?.(bak)
    })
    return pf && Array.isArray(pf.projects) ? { version: 1, projects: pf.projects } : EMPTY_PROJECTS
  }

  save(pf: ProjectsFile): void {
    mkdirSync(this.dir(), { recursive: true })
    writeJsonAtomic(this.file(), pf)
  }

  upsert(p: Project): void {
    const pf = this.load()
    const i = pf.projects.findIndex(x => x.id === p.id)
    if (i >= 0) pf.projects[i] = p
    else pf.projects.push(p)
    this.save(pf)
  }

  remove(id: string): void {
    const pf = this.load()
    pf.projects = pf.projects.filter(p => p.id !== id)
    this.save(pf)
  }
}

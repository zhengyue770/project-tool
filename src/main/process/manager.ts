import { spawn, type ChildProcess } from 'node:child_process'
import { kill } from 'node:process'
import { resolve } from 'node:path'
import type {
  CommandConfig, CommandRuntimeStatus, Project, RuntimeFile
} from '../../shared/types'
import { runtimeKey } from '../../shared/types'
import { healthUrlOf, probe } from './health'

export interface ManagerOptions {
  healthIntervalMs?: number   // 默认 2000
  killGraceMs?: number        // SIGTERM→SIGKILL 宽限，默认 5000
  startupTimeoutMs: () => number
  onRuntimeChange?: (rf: RuntimeFile) => void
}

export interface CommandStatusEvent { projectId: string; commandId: string; status: CommandRuntimeStatus }

const MAX_LOG_LINES = 500

interface Entry {
  status: CommandRuntimeStatus
  pid?: number
  child?: ChildProcess
  logs: string[]
  partial: string
  pending: string[]
  flushTimer?: NodeJS.Timeout
  healthTimer?: NodeJS.Timeout
  timeoutTimer?: NodeJS.Timeout
  logSubs: Set<(lines: string[]) => void>
}

export class ProcessManager {
  private entries = new Map<string, Entry>()
  private runtime: RuntimeFile = {}
  private statusListener?: (e: CommandStatusEvent) => void

  constructor(private opts: ManagerOptions) {}

  /** Task 6 实现：渲染层事件监听（ipc 装配时注入） */
  setStatusListener(cb: (e: CommandStatusEvent) => void): void { this.statusListener = cb }

  statusOf(projectId: string, commandId: string): CommandRuntimeStatus {
    return this.entries.get(runtimeKey(projectId, commandId))?.status ?? 'stopped'
  }

  logsOf(projectId: string, commandId: string): string[] {
    return this.entry(runtimeKey(projectId, commandId)).logs
  }

  clearLogs(projectId: string, commandId: string): void {
    const e = this.entry(runtimeKey(projectId, commandId))
    e.logs = []
    e.partial = ''
    this.flush(e)
  }

  subscribeLogs(projectId: string, commandId: string, cb: (lines: string[]) => void): () => void {
    const e = this.entry(runtimeKey(projectId, commandId))
    e.logSubs.add(cb)
    return () => e.logSubs.delete(cb)
  }

  start(project: Project, command: CommandConfig): void {
    const k = runtimeKey(project.id, command.id)
    const e = this.entry(k)
    if (e.status === 'starting' || e.status === 'running') return
    e.status = 'starting'
    e.logs = []
    e.partial = ''
    e.pending = []

    const cwd = resolve(project.path, command.workdir || '.')
    const child = spawn(command.cmd, {
      shell: true,
      detached: true, // 新进程组（pgid === child.pid），保证整组可杀
      cwd,
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe']
    })
    e.child = child
    e.pid = child.pid
    this.runtime[k] = { pid: child.pid as number, startedAt: Date.now() }
    this.emitRuntime()
    this.append(e, `$ ${command.cmd}  (cwd: ${cwd})`)

    child.stdout?.on('data', (d: Buffer) => this.ingest(e, d))
    child.stderr?.on('data', (d: Buffer) => this.ingest(e, d))
    child.on('exit', () => {
      this.clearTimers(e)
      const was = e.status
      e.child = undefined
      delete this.runtime[k]
      this.emitRuntime()
      // starting 中退出 = 启动失败；running 后退出 = 回到已停止；已 failed/stopped 的跳过（超时/手动停止已处理）
      if (was === 'starting') this.setStatus(k, e, project.id, command.id, 'failed')
      else if (was === 'running') this.setStatus(k, e, project.id, command.id, 'stopped')
    })

    const url = healthUrlOf(command)
    e.healthTimer = setInterval(async () => {
      if (e.status !== 'starting') return
      if (await probe(url)) {
        this.clearTimers(e)
        this.setStatus(k, e, project.id, command.id, 'running')
      }
    }, this.opts.healthIntervalMs ?? 2000)

    e.timeoutTimer = setTimeout(() => {
      if (e.status !== 'starting') return
      this.append(e, `[超时] ${this.opts.startupTimeoutMs()}ms 内端口 ${command.port} 未就绪，终止进程`)
      this.setStatus(k, e, project.id, command.id, 'failed')
      void this.killEntry(k, e)
    }, this.opts.startupTimeoutMs())
  }

  // ---- 内部工具 ----

  private entry(k: string): Entry {
    let e = this.entries.get(k)
    if (!e) {
      e = { status: 'stopped', logs: [], partial: '', pending: [], logSubs: new Set() }
      this.entries.set(k, e)
    }
    return e
  }

  private setStatus(k: string, e: Entry, projectId: string, commandId: string, s: CommandRuntimeStatus): void {
    e.status = s
    this.statusListener?.({ projectId, commandId, status: s })
  }

  private clearTimers(e: Entry): void {
    if (e.healthTimer) clearInterval(e.healthTimer)
    if (e.timeoutTimer) clearTimeout(e.timeoutTimer)
    e.healthTimer = e.timeoutTimer = undefined
  }

  private emitRuntime(): void { this.opts.onRuntimeChange?.({ ...this.runtime }) }

  private ingest(e: Entry, d: Buffer): void {
    e.partial += d.toString()
    const lines = e.partial.split('\n')
    e.partial = lines.pop() ?? ''
    for (const l of lines) this.append(e, l)
  }

  private append(e: Entry, line: string): void {
    const stamped = `[${new Date().toLocaleTimeString()}] ${line}`
    e.logs.push(stamped)
    if (e.logs.length > MAX_LOG_LINES) e.logs.splice(0, e.logs.length - MAX_LOG_LINES)
    e.pending.push(stamped)
    if (!e.flushTimer) {
      e.flushTimer = setTimeout(() => {
        e.flushTimer = undefined
        this.flush(e)
      }, 300)
    }
  }

  private flush(e: Entry): void {
    if (!e.pending.length) return
    const lines = e.pending
    e.pending = []
    for (const cb of e.logSubs) cb(lines)
  }

  private alive(pid: number): boolean {
    try { kill(pid, 0); return true } catch { return false }
  }

  private killGroup(pid: number, sig: NodeJS.Signals): boolean {
    try { kill(-pid, sig); return true } catch { return false }
  }

  /** 杀整个进程组：SIGTERM → 等 killGraceMs → SIGKILL；并清理 runtime 记录 */
  private async killEntry(k: string, e: Entry): Promise<void> {
    const pid = e.pid
    if (pid && this.alive(pid)) {
      this.killGroup(pid, 'SIGTERM')
      const grace = this.opts.killGraceMs ?? 5000
      const t0 = Date.now()
      while (this.alive(pid) && Date.now() - t0 < grace) {
        await new Promise(r => setTimeout(r, 200))
      }
      if (this.alive(pid)) this.killGroup(pid, 'SIGKILL')
    }
    delete this.runtime[k]
    this.emitRuntime()
  }

  /** 测试后门：清理本 manager 启动的所有进程（Task 6 由 stopProject 委托） */
  async stopProjectForTest(): Promise<void> {
    await Promise.all(
      [...this.entries].filter(([, e]) => e.pid).map(([k, e]) => this.killEntry(k, e))
    )
  }
}

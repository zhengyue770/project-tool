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

/** v1.1 动态端口：内置捕获规则（不加 g 标志——复用 exec 不受 lastIndex 影响） */
const DEFAULT_PORT_RE = /(?:localhost|127\.0\.0\.1):(\d{2,5})/

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
  /** 启动代际：每次 start() 自增；旧一轮的 exit/error/定时器回调凭 gen 失效，避免污染新一轮运行 */
  gen: number
  /** v1.1：本次运行的端口模式（动态=从日志捕获真实地址再探测） */
  dynamic: boolean
  /** v1.1：生效的端口捕获正则（仅动态模式有值） */
  pattern?: RegExp
  /** v1.1：已捕获到的服务地址；未捕获为 null */
  discoveredUrl?: string | null
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
    e.pending = [] // 清空待刷送队列，避免已清空的日志再次推给订阅者
    this.flush(e)
  }

  subscribeLogs(projectId: string, commandId: string, cb: (lines: string[]) => void): () => void {
    const e = this.entry(runtimeKey(projectId, commandId))
    e.logSubs.add(cb)
    return () => e.logSubs.delete(cb)
  }

  discoveredPortOf(projectId: string, commandId: string): number | null {
    const url = this.entries.get(runtimeKey(projectId, commandId))?.discoveredUrl
    if (!url) return null
    const m = /(\d+)$/.exec(url) // 只从尾部取端口，避免 URL 解析对边缘地址报错
    return m ? Number(m[1]) : null
  }

  start(project: Project, command: CommandConfig): void {
    const k = runtimeKey(project.id, command.id)
    const e = this.entry(k)
    if (e.status === 'starting' || e.status === 'running') return
    e.gen++ // 新一轮运行：上一轮残留的回调/定时器凭旧 gen 失效
    const gen = e.gen
    this.clearTimers(e) // 上一轮可能残留的定时器（如超时路径未清的健康轮询）一并清掉
    this.setStatus(k, e, project.id, command.id, 'starting')
    e.logs = []
    e.partial = ''
    e.pending = []
    // v1.1 端口模式：ipc 层已校验自定义正则可编译，这里 try/catch 兜底用内置规则
    e.dynamic = command.portMode === 'dynamic'
    if (e.dynamic && command.successPattern?.trim()) {
      try { e.pattern = new RegExp(command.successPattern.trim()) } catch { e.pattern = DEFAULT_PORT_RE }
    } else {
      e.pattern = e.dynamic ? DEFAULT_PORT_RE : undefined
    }
    e.discoveredUrl = null

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
      // 代际守卫：旧进程退出时该 entry 可能已被新一轮 start 接管，不能动新运行的状态/timers/runtime
      if (gen !== e.gen) return
      this.clearTimers(e)
      const was = e.status
      e.child = undefined
      delete this.runtime[k]
      this.emitRuntime()
      // starting 中退出 = 启动失败；running 后退出 = 回到已停止；已 failed/stopped 的跳过（超时/手动停止已处理）
      if (was === 'starting') this.setStatus(k, e, project.id, command.id, 'failed')
      else if (was === 'running') this.setStatus(k, e, project.id, command.id, 'stopped')
    })
    child.on('error', err => {
      // 代际守卫：同 exit——旧 child 的 error 不属于当前运行
      if (gen !== e.gen) return
      // spawn 失败（如 workdir 指向不存在的目录）：异步 error 事件，exit 可能不再触发
      this.append(e, `[错误] ${String(err)}`)
      this.clearTimers(e)
      const was = e.status
      e.child = undefined
      delete this.runtime[k]
      this.emitRuntime()
      // 仅在尚未被超时/停止流程处置时标记 failed，避免重复发事件
      if (was === 'starting' || was === 'running') this.setStatus(k, e, project.id, command.id, 'failed')
    })

    const url = healthUrlOf(command) // 固定模式探测地址原样；动态模式下忽略 healthCheckUrl
    e.healthTimer = setInterval(async () => {
      if (gen !== e.gen || e.status !== 'starting') return
      if (e.dynamic && !e.discoveredUrl) return // 动态模式未捕获前不发请求
      const target = e.discoveredUrl ?? url
      if (await probe(target)) {
        // 防御性复查：await probe 期间可能已超时/停止/被新一轮 start 取代，避免竞态把 failed 翻回 running
        if (gen !== e.gen || e.status !== 'starting') return
        this.clearTimers(e)
        this.setStatus(k, e, project.id, command.id, 'running')
      }
    }, this.opts.healthIntervalMs ?? 2000)

    e.timeoutTimer = setTimeout(() => {
      if (gen !== e.gen || e.status !== 'starting') return
      this.clearTimers(e) // 健康轮询与本次超时定时器一并清理
      this.append(e, e.dynamic
        ? `[超时] ${this.opts.startupTimeoutMs()}ms 内未从日志发现服务地址或地址未就绪，终止进程`
        : `[超时] ${this.opts.startupTimeoutMs()}ms 内端口 ${command.port} 未就绪，终止进程`)
      this.setStatus(k, e, project.id, command.id, 'failed')
      void this.killEntry(k, e)
    }, this.opts.startupTimeoutMs())
  }

  /** 停止单条命令（运行中或启动中才需要停） */
  async stop(projectId: string, commandId: string): Promise<void> {
    const k = runtimeKey(projectId, commandId)
    const e = this.entries.get(k)
    if (!e || (e.status !== 'running' && e.status !== 'starting')) return
    this.clearTimers(e)
    this.setStatus(k, e, projectId, commandId, 'stopped')
    await this.killEntry(k, e)
  }

  /** 停止项目全部运行中/启动中的命令 */
  async stopProject(project: Project): Promise<void> {
    await Promise.all(
      project.commands
        .filter(c => ['running', 'starting'].includes(this.statusOf(project.id, c.id)))
        .map(c => this.stop(project.id, c.id))
    )
  }

  /** 应用重启后的状态恢复：pid 存活 && 端口有服务 → running（此后可按 pgid 停止）；否则丢弃记录 */
  async restore(projects: Project[], runtime: RuntimeFile): Promise<void> {
    this.runtime = {}
    for (const p of projects) {
      for (const c of p.commands) {
        const k = runtimeKey(p.id, c.id)
        const rec = runtime[k]
        if (!rec) continue
        const live = this.alive(rec.pid)
        if (live && (await probe(healthUrlOf(c)))) {
          const e = this.entry(k)
          e.status = 'running'
          e.pid = rec.pid
          this.runtime[k] = rec
        }
      }
    }
    this.emitRuntime()
  }

  // ---- 内部工具 ----

  private entry(k: string): Entry {
    let e = this.entries.get(k)
    if (!e) {
      e = { status: 'stopped', logs: [], partial: '', pending: [], logSubs: new Set(), gen: 0, dynamic: false }
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
    this.maybeCapturePort(e, stamped)
    if (!e.flushTimer) {
      e.flushTimer = setTimeout(() => {
        e.flushTimer = undefined
        this.flush(e)
      }, 300)
    }
  }

  /** v1.1 动态端口：starting 期间逐行捕获服务地址；首个捕获生效，后续不再改写 */
  private maybeCapturePort(e: Entry, stamped: string): void {
    if (!e.dynamic || !e.pattern || e.status !== 'starting' || e.discoveredUrl) return
    const m = e.pattern.exec(stamped)
    if (!m) return
    let port: number | undefined =
      m[1] && /^\d{2,5}$/.test(m[1]) ? Number(m[1]) : undefined
    if (port === undefined) {
      const u = DEFAULT_PORT_RE.exec(m[0])
      if (!u) return
      port = Number(u[1])
    }
    if (!(port >= 1 && port <= 65535)) return
    e.discoveredUrl = `http://127.0.0.1:${port}`
    const line = `[自动发现] 服务地址 ${e.discoveredUrl}`
    e.logs.push(line); e.pending.push(line)
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

  /** 进程组存活探测（spec §5.2）：kill(-pid, 0)——ESRCH 表示整组已消失；EPERM 表示组内仍有进程（视为存活） */
  private groupAlive(pid: number): boolean {
    try {
      kill(-pid, 0)
      return true
    } catch (err) {
      return (err as NodeJS.ErrnoException).code === 'EPERM'
    }
  }

  private killGroup(pid: number, sig: NodeJS.Signals): boolean {
    try { kill(-pid, sig); return true } catch { return false }
  }

  /** 杀整个进程组：SIGTERM → 等 killGraceMs → SIGKILL；并清理 runtime 记录 */
  private async killEntry(k: string, e: Entry): Promise<void> {
    const pid = e.pid
    const gen = e.gen // 停止期间可能已被新一轮 start 接管：旧 pid 照杀，但 runtime 清理需守卫
    if (pid && this.groupAlive(pid)) {
      this.killGroup(pid, 'SIGTERM')
      const grace = this.opts.killGraceMs ?? 5000
      const t0 = Date.now()
      while (this.groupAlive(pid) && Date.now() - t0 < grace) {
        await new Promise(r => setTimeout(r, 200))
      }
      if (this.groupAlive(pid)) this.killGroup(pid, 'SIGKILL')
    }
    if (gen === e.gen) {
      delete this.runtime[k]
      this.emitRuntime()
    }
  }

  /** 测试后门：清理本 manager 启动的所有进程（Task 6 由 stopProject 委托） */
  async stopProjectForTest(): Promise<void> {
    await Promise.all(
      [...this.entries].filter(([, e]) => e.pid).map(([k, e]) => this.killEntry(k, e))
    )
  }
}

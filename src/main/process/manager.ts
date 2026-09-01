import { spawn, type ChildProcess } from 'node:child_process'
import { kill } from 'node:process'
import { join, resolve } from 'node:path'
import { closeSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs'
import type {
  CommandConfig, CommandRuntimeStatus, Project, RuntimeFile
} from '../../shared/types'
import { runtimeKey } from '../../shared/types'
import { healthUrlOf, probe } from './health'

export interface ManagerOptions {
  healthIntervalMs?: number   // 默认 2000
  killGraceMs?: number        // SIGTERM→SIGKILL 宽限，默认 5000
  /** v1.1a: 子进程日志文件目录（主进程传 <userData>/logs；测试传临时目录） */
  logDir: () => string
  /** v1.1a: 日志文件轮询间隔，默认 300 */
  tailIntervalMs?: number
  startupTimeoutMs: () => number
  onRuntimeChange?: (rf: RuntimeFile) => void
}

export interface CommandStatusEvent { projectId: string; commandId: string; status: CommandRuntimeStatus }

const MAX_LOG_LINES = 500

/** v1.1 动态端口：内置捕获规则（不加 g 标志——复用 exec 不受 lastIndex 影响） */
const DEFAULT_PORT_RE = /(?:localhost|127\.0\.0\.1):(\d{2,5})/

interface Entry {
  /** v1.1a: 该条目对应的 runtime 键（捕获端口后回写 runtime 记录用） */
  key: string
  status: CommandRuntimeStatus
  pid?: number
  child?: ChildProcess
  logs: string[]
  partial: string
  pending: string[]
  flushTimer?: NodeJS.Timeout
  healthTimer?: NodeJS.Timeout
  timeoutTimer?: NodeJS.Timeout
  /** v1.1a: 日志文件轮询定时器（纳管 clearTimers 统一清理） */
  tailTimer?: NodeJS.Timeout
  logSubs: Set<(lines: string[]) => void>
  /** 启动代际：每次 start() 自增；旧一轮的 exit/error/定时器回调凭 gen 失效，避免污染新一轮运行 */
  gen: number
  /** v1.1：本次运行的端口模式（动态=从日志捕获真实地址再探测） */
  dynamic: boolean
  /** v1.1：生效的端口捕获正则（仅动态模式有值） */
  pattern?: RegExp
  /** v1.1：已捕获到的服务地址；未捕获为 null */
  discoveredUrl?: string | null
  /** v1.1a: 子进程日志文件路径（stdio 重定向目标，亦是轮询 tail 的数据源） */
  logFile?: string
  /** v1.1a: 日志文件已消费的长度（字符计）——增量读取的游标，避免重复 ingest 旧字节 */
  offset: number
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
    // v1.1a: 同步截断日志文件并归零游标；子进程以 O_APPEND 续写，不会留下稀疏空洞
    if (e.logFile) {
      try { writeFileSync(e.logFile, '') } catch { /* 文件可能不存在（未启动过），容忍 */ }
      e.offset = 0
    }
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
    // v1.1a: stdio 重定向到日志文件而非管道——管道读端随应用退出关闭，子进程下次写日志会收到 EPIPE 崩溃
    // （违反"退出应用不杀项目进程"）。文件每次启动截断（有界）；以 'a' 打开让子进程 O_APPEND 续写，
    // 这样 clearLogs 运行中截断后子进程从新 EOF 写起，不留稀疏空洞。父进程 spawn 后即 close 自己的 fd，
    // 不持有任何管道/文件描述符依赖。
    const file = this.logFileFor(k)
    mkdirSync(this.opts.logDir(), { recursive: true })
    // v1.1b: 会话头行随截断一并写入文件本身（文件里带时间后缀）——应用重开 restore 从文件头播种时它也在最前
    const header = `$ ${command.cmd}  (cwd: ${cwd}) @ ${new Date().toLocaleString()}\n`
    writeFileSync(file, header)
    const fd = openSync(file, 'a')
    const child = spawn(command.cmd, {
      shell: true,
      detached: true, // 新进程组（pgid === child.pid），保证整组可杀
      cwd,
      env: { ...process.env },
      stdio: ['ignore', fd, fd]
    })
    closeSync(fd)
    e.child = child
    e.pid = child.pid
    this.runtime[k] = { pid: child.pid as number, startedAt: Date.now() }
    this.emitRuntime()
    this.append(e, `$ ${command.cmd}  (cwd: ${cwd})`) // 头行进缓冲/订阅推送（带时间前缀）；文件里的一份由上方 writeFileSync 落盘

    e.logFile = file
    e.offset = header.length // tail 从文件头行之后起读——头行已在缓冲里，避免再经 ingest 重复入缓冲
    this.startTail(k, e, gen)

    child.on('exit', () => {
      // 代际守卫：旧进程退出时该 entry 可能已被新一轮 start 接管，不能动新运行的状态/timers/runtime
      if (gen !== e.gen) return
      this.tailOnce(e) // 临终输出（如报错栈）最后一次补读，再停轮询——否则 300ms 轮询间隙里的末尾日志会丢
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
      this.tailOnce(e) // 补读再停轮询，与 exit 路径一致
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
        this.clearTimers(e) // 终止健康轮询与超时定时器（tail 一并清了，下一行立即重启）
        this.setStatus(k, e, project.id, command.id, 'running')
        this.startTail(k, e, gen) // v1.1a: 进入 running 只是停轮询/超时，日志 tail 须继续服务整个运行期
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
        // v1.1a: 动态命令端口为 0，healthUrlOf 必探不通——改探 runtime 记录里持久化的 discoveredUrl；
        // 记录缺失（旧版 runtime.json）则无法验证真实端口，按 stopped 丢弃，宁错杀不误杀
        const target = c.portMode === 'dynamic' ? rec.discoveredUrl : healthUrlOf(c)
        if (live && target && (await probe(target))) {
          const e = this.entry(k)
          e.status = 'running'
          e.pid = rec.pid
          if (c.portMode === 'dynamic') {
            e.dynamic = true
            e.discoveredUrl = rec.discoveredUrl // 卡片显示真实端口
          }
          this.runtime[k] = rec
          this.adoptLogTail(k, e) // v1.1b: 采用后从文件头播种日志缓冲并续读增量，重开后日志面板可见本次运行从头开始的日志
        }
      }
    }
    this.emitRuntime()
  }

  // ---- 内部工具 ----

  private entry(k: string): Entry {
    let e = this.entries.get(k)
    if (!e) {
      e = { status: 'stopped', key: k, logs: [], partial: '', pending: [], logSubs: new Set(), gen: 0, dynamic: false, offset: 0 }
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
    if (e.tailTimer) clearInterval(e.tailTimer)
    e.healthTimer = e.timeoutTimer = e.tailTimer = undefined
  }

  private emitRuntime(): void { this.opts.onRuntimeChange?.({ ...this.runtime }) }

  private ingest(e: Entry, d: Buffer): void {
    e.partial += d.toString()
    const lines = e.partial.split('\n')
    e.partial = lines.pop() ?? ''
    for (const l of lines) this.append(e, l)
  }

  // ---- v1.1a 日志文件轮询 tail ----

  /** 日志文件路径：<logDir>/<projectId>__<commandId>.log（键中 ':' 换 '__' 以适配文件名） */
  private logFileFor(k: string): string {
    return join(this.opts.logDir(), `${k.replace(/:/g, '__')}.log`)
  }

  /** 启动轮询：从 offset 起增量读日志文件进既有 ingest 管道（partial/append/flush/maybeCapturePort 零改动） */
  private startTail(k: string, e: Entry, gen: number): void {
    if (e.tailTimer) clearInterval(e.tailTimer) // 防御：理论上 clearTimers 已清
    e.tailTimer = setInterval(() => {
      // 代际守卫：旧一轮的轮询在新 start 接管后自灭（正常路径由 clearTimers 清除，此为兜底）
      if (gen !== e.gen) { this.clearTimers(e); return }
      this.tailOnce(e)
    }, this.opts.tailIntervalMs ?? 300)
  }

  /** 单次增量读取：全量读入后按 offset 切片（文件每次启动截断、有界，全量读代价可接受），推进游标 */
  private tailOnce(e: Entry): void {
    if (!e.logFile) return
    let text: string
    try {
      text = readFileSync(e.logFile, 'utf8')
    } catch {
      return // 文件被外部删除/暂不可读：本轮跳过（restore 场景允许文件不存在）
    }
    if (text.length <= e.offset) return // 无新增（或被截短：游标保持，等 O_APPEND 新内容追上）
    const chunk = text.slice(e.offset)
    e.offset = text.length
    this.ingest(e, Buffer.from(chunk, 'utf8'))
  }

  /** v1.1b: restore 采用后接管日志：缓冲由文件头播种（最近 MAX_LOG_LINES 行原始行，不加时间前缀，与恢复后新行的 [时间] 前缀天然区分），
   *  游标落到文件末尾续读增量；文件不存在则缓冲空、从 0 起且容忍。
   *  播种不经过 ingest/append/maybeCapturePort——discoveredUrl 已由 runtime 记录恢复，不得再触发捕获；也不产生 pending 推送 */
  private adoptLogTail(k: string, e: Entry): void {
    const file = this.logFileFor(k)
    e.logFile = file
    try {
      const text = readFileSync(file, 'utf8')
      e.logs = text.split('\n').filter(l => l !== '').slice(-MAX_LOG_LINES)
      e.offset = text.length // 与 tailOnce 的字符计游标保持一致
    } catch {
      e.logs = []
      e.offset = 0
    }
    this.startTail(k, e, e.gen)
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
    // v1.1a: 捕获即持久化进 runtime 记录——应用退出后 runtime.json 是唯一能还原真实端口的载体
    const rec = this.runtime[e.key]
    if (rec) { rec.discoveredUrl = e.discoveredUrl; this.emitRuntime() }
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

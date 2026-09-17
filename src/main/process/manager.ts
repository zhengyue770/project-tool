import { spawn, execFileSync, type ChildProcess } from 'node:child_process'
import { kill } from 'node:process'
import { join, resolve } from 'node:path'
import { closeSync, mkdirSync, openSync, readSync, statSync, writeFileSync } from 'node:fs'
import { StringDecoder } from 'node:string_decoder'
import type {
  CommandConfig, CommandRuntimeStatus, Project, QuickCommand, RuntimeFile, RuntimeRecord
} from '../../shared/types'
import { runtimeKey } from '../../shared/types'
import { probe, probePort, portFromUrl } from './health'

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

// 日志限容（hardening 批次三）：应用打开期间的尽力限容，非磁盘容量保证——
// 应用退出后命令仍在写、tail 停转（与命令存活设计一致）；轮转重写瞬间可能丢行。
const LOG_ROTATE_THRESHOLD = 10 * 1024 * 1024 // 超过即轮转截断
const LOG_KEEP_WINDOW = 2 * 1024 * 1024       // 轮转/接管保留的尾部字节窗口
const LOG_READ_CHUNK = 4 * 1024 * 1024        // 单轮增量读取上限（积压分多轮追）
const PARTIAL_MAX_BYTES = 256 * 1024          // 无换行单行的字节上限（防撑爆内存）

/** 子进程环境过滤：启动器经 npm script（npm run dev 等）启动时，npm 会把全部配置
 *  导出为 npm_config_* 环境变量——其优先级高于目标项目自己的 .npmrc，会把
 *  registry/镜像/鉴权等整体渗进被管理项目的命令；npm_package_* / npm_lifecycle_* 与
 *  INIT_CWD 是启动器上下文元数据（INIT_CWD 还指向启动器目录），对目标项目无价值。
 *  npm 对环境配置前缀做大小写不敏感匹配，故用 i 标志；PATH/HOME/SHELL/代理等原样保留。 */
const NPM_META_ENV_RE = /^npm_(config|package|lifecycle)_/i

function childEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (NPM_META_ENV_RE.test(k) || k === 'INIT_CWD') continue
    env[k] = v
  }
  return env
}

/** v1.1 动态端口：内置捕获规则（不加 g 标志——复用 exec 不受 lastIndex 影响） */
const DEFAULT_PORT_RE = /(?:localhost|127\.0\.0\.1):(\d{2,5})/

/** 定位读取（hardening 批次三 review 修正 #1）：循环补读防短读，**只返回已填充
 *  字节**（allocUnsafe 的未初始化部分绝不外泄/写回）；EOF 或异常返回实际读到
 *  的前缀（null 表示一字节未读）。异常不写任何文件 */
export function readAt(file: string, position: number, length: number): Buffer | null {
  if (length <= 0) return Buffer.alloc(0)
  const buf = Buffer.allocUnsafe(length)
  let filled = 0
  let fd: number | undefined
  try {
    fd = openSync(file, 'r')
    while (filled < length) {
      const n = readSync(fd, buf, filled, length - filled, position + filled)
      if (n <= 0) break // EOF
      filled += n
    }
  } catch {
    return filled > 0 ? buf.subarray(0, filled) : null
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
  return buf.subarray(0, filled)
}

/** hardening 2b：系统侧进程身份——ps 的 lstart（进程出生时间）。查不到（进程
 *  已死 / 组长已退出）返回 null。同步调用（约 10ms）：spawn 后即时采集 */
export function procStart(pid: number): string | null {
  try {
    return execFileSync('ps', ['-p', String(pid), '-o', 'lstart='], { encoding: 'utf8' }).trim()
  } catch {
    return null
  }
}

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
  /** 快捷命令任务模式（spec 2026-09-04）：spawn 即 running、退出码定成败、不探端口 */
  task: boolean
  /** v1.1：本次运行的端口模式（动态=从日志捕获真实地址再探测） */
  dynamic: boolean
  /** v1.1：生效的端口捕获正则（仅动态模式有值） */
  pattern?: RegExp
  /** v1.1：已捕获到的服务地址；未捕获为 null */
  discoveredUrl?: string | null
  /** v1.1a: 子进程日志文件路径（stdio 重定向目标，亦是轮询 tail 的数据源） */
  logFile?: string
  /** v1.1a: 日志文件已消费的长度——**字节**偏移（hardening 批次三：全链路 Buffer 化，
   *  字符数与字节数在多字节字符下不一致），增量读取的游标 */
  offset: number
  /** hardening 批次三：跨读取边界的增量 UTF-8 解码器（保留未完成字节序列） */
  decoder?: StringDecoder
  /** 无换行待成行内容的字节量（partial 本身是已解码字符串） */
  partialBytes: number
  /** hardening 2b：组长进程的系统身份（spawn 后采集的 lstart）——恢复接管/停止前验身 */
  lstart?: string
  /** 启动探测闭包与描述（start 时存）：停止失败恢复监控时原样重挂（review 修正 P2-1） */
  probeFn?: () => Promise<boolean>
  probeDesc?: string
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
    e.partialBytes = 0
    e.decoder = new StringDecoder() // 截断点重置：旧解码状态不带入（hardening 批次三）
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
    return url ? portFromUrl(url) : null // 复用 health.portFromUrl（尾部数字即端口）
  }

  /** 保存守卫真值源（review P2 第二轮）：该命令的进程组是否仍存活
   *  （kill(-pid,0) 成功或 EPERM=组内有进程）。**与展示状态无关**——stop()
   *  先同步置 stopped 再异步杀组的窗口内仍为 true，停止失败恢复运行态亦然；
   *  从未启动/组确认消亡为 false。无法确认（EPERM）按存活处理，宁保守拒绝保存 */
  hasLiveProcessGroup(projectId: string, commandId: string): boolean {
    const e = this.entries.get(runtimeKey(projectId, commandId))
    return e?.pid !== undefined && this.groupAlive(e.pid)
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
    e.partialBytes = 0
    e.pending = []
    e.task = false // 服务模式（entry 可能上一轮是任务）
    // v1.1 端口模式：ipc 层已校验自定义正则可编译，这里 try/catch 兜底用内置规则
    e.dynamic = command.portMode === 'dynamic'
    if (e.dynamic && command.successPattern?.trim()) {
      try { e.pattern = new RegExp(command.successPattern.trim()) } catch { e.pattern = DEFAULT_PORT_RE }
    } else {
      e.pattern = e.dynamic ? DEFAULT_PORT_RE : undefined
    }
    e.discoveredUrl = null

    const cwd = resolve(project.path, command.workdir || '.')
    this.launch(k, e, gen, project.id, command.id, command.cmd, cwd)

    // v1.1g 探测目标：固定模式用户显式给了地址按原样探；其余双栈探测端口——vite 等默认绑 localhost，
    // 部分机器 localhost 只落 ::1，写死 127.0.0.1 会误报启动失败。
    // 探测闭包与描述存到 entry：停止失败恢复监控时原样重挂（review 修正 P2-1）
    e.probeFn = (): Promise<boolean> => {
      const custom = command.healthCheckUrl?.trim()
      if (!e.dynamic && custom) return probe(custom)
      if (e.dynamic) {
        const p = e.discoveredUrl ? portFromUrl(e.discoveredUrl) : null
        return p ? probePort(p) : Promise.resolve(false)
      }
      return probePort(command.port) // 固定模式无自定义地址
    }
    e.probeDesc = command.portMode === 'dynamic'
      ? '未从日志发现服务地址或地址未就绪'
      : `端口 ${command.port} 未就绪`
    this.armStartupMonitor(k, e, gen)
  }

  /** 挂启动监控（健康轮询 + 启动超时）。start 初次挂载；单条 stop 失败恢复
   *  starting 状态时原样重挂（凭 entry 上保存的探测闭包）。key 形如
   *  projectId:commandId（id 均不含冒号），按第一个冒号拆出事件用的 id */
  private armStartupMonitor(k: string, e: Entry, gen: number): void {
    const i = k.indexOf(':')
    const projectId = k.slice(0, i)
    const commandId = k.slice(i + 1)
    e.healthTimer = setInterval(async () => {
      if (gen !== e.gen || e.status !== 'starting') return
      if (e.dynamic && !e.discoveredUrl) return // 动态模式未捕获前不发请求
      if (await e.probeFn?.()) {
        // 防御性复查：await probe 期间可能已超时/停止/被新一轮 start 取代，避免竞态把 failed 翻回 running
        if (gen !== e.gen || e.status !== 'starting') return
        this.clearTimers(e) // 终止健康轮询与超时定时器（tail 一并清了，下一行立即重启）
        this.setStatus(k, e, projectId, commandId, 'running')
        this.startTail(k, e, gen) // v1.1a: 进入 running 只是停轮询/超时，日志 tail 须继续服务整个运行期
      }
    }, this.opts.healthIntervalMs ?? 2000)

    e.timeoutTimer = setTimeout(() => {
      if (gen !== e.gen || e.status !== 'starting') return
      this.clearTimers(e) // 健康轮询与本次超时定时器一并清理
      this.append(e, `[超时] ${this.opts.startupTimeoutMs()}ms 内${e.probeDesc ?? '服务'}，终止进程`)
      this.setStatus(k, e, projectId, commandId, 'failed')
      void this.killEntry(k, e)
    }, this.opts.startupTimeoutMs())
  }

  /** 快捷命令任务模式（spec 2026-09-04）：spawn 即 running，无端口探测/启动超时；
   *  退出码 0 → stopped、非 0/信号 → failed。日志/停止/恢复与命令共用一套机制 */
  runTask(project: Project, quick: QuickCommand): void {
    const k = runtimeKey(project.id, quick.id)
    const e = this.entry(k)
    if (e.status === 'starting' || e.status === 'running') return
    e.gen++
    const gen = e.gen
    this.clearTimers(e)
    e.task = true
    e.dynamic = false
    e.pattern = undefined
    e.discoveredUrl = null
    this.setStatus(k, e, project.id, quick.id, 'running')
    e.logs = []
    e.partial = ''
    e.partialBytes = 0
    e.pending = []
    const cwd = resolve(project.path, quick.workdir || '.')
    this.launch(k, e, gen, project.id, quick.id, quick.cmd, cwd, { task: true })
  }

  /** 停止单条命令（运行中或启动中才需要停） */
  async stop(projectId: string, commandId: string): Promise<void> {
    const k = runtimeKey(projectId, commandId)
    const e = this.entries.get(k)
    if (!e || (e.status !== 'running' && e.status !== 'starting')) return
    const was = e.status
    const gen = e.gen // 停止 await 期间可能被新一轮 start 接管，失败恢复须凭代际豁免
    this.clearTimers(e)
    this.setStatus(k, e, projectId, commandId, 'stopped')
    // hardening 2b：向进程组发信号前验证组长身份——本次会话的 child 句柄即可信；
    // 恢复接管的进程凭 lstart 验证；组长已死/身份不符（PID 可能被复用）不发信号，
    // 只清理记录（我们自己的进程此时必然已不在，信号也无从送达本组）
    if (e.pid !== undefined && this.leaderIsOurs(e)) {
      const r = await this.killEntry(k, e)
      if (r !== 'ok') {
        if (gen !== e.gen) {
          // 新一轮运行已接管 entry：旧一轮的失败不碰新运行的状态/日志/监控
          throw new Error('停止失败：命令已被重新启动，原进程组仍存活')
        }
        // review 修正（P2-1）：停止失败不得谎报已停止——恢复原状态**及对应监控**
        // （tail 恒重挂；starting 还要重挂健康轮询与启动超时）
        this.append(e, `[停止失败] ${r === 'signal-failed' ? '信号发送失败' : '进程组仍存活'}，已恢复运行与监控`)
        this.setStatus(k, e, projectId, commandId, was)
        this.startTail(k, e, gen)
        if (was === 'starting') this.armStartupMonitor(k, e, gen)
        throw new Error(r === 'signal-failed' ? '停止失败：无法向进程组发送信号' : '停止失败：进程组未按期消亡')
      }
    } else {
      if (e.pid !== undefined) {
        this.append(e, '[跳过] 无法确认进程身份，未发送停止信号')
      }
      delete this.runtime[k]
      this.emitRuntime()
    }
  }

  /** hardening 2b：组长身份可信判据——child 句柄存活（本次会话启动），或
   *  恢复接管的进程 lstart 与采集记录一致；组长已退出（后代可能仍在组内）时
   *  身份不可验证，返回 false（调用方报告跳过，绝不猜测） */
  private leaderIsOurs(e: Entry): boolean {
    if (e.child && e.child.exitCode === null && !e.child.killed) return true
    if (e.pid === undefined) return false
    if (!e.lstart) return false
    return procStart(e.pid) === e.lstart
  }

  /** hardening 2a/2b：停全部受管进程（退出网关「停止并退出」用）。
   *  覆盖三类：本次启动（child）/ 恢复接管（仅 pid，凭 lstart 验身）/ 在途停止
   *  （killEntry 已在跑则等它）。组长已退出或身份不符的存活组：跳过并报告，
   *  不承诺自动停止；组已消亡的条目顺带清理身份记录。
   *  review 修正：只有确认组消亡才计入 stopped 并同步状态为 stopped；
   *  失败项保留运行记录、状态维持 running */
  async stopAll(): Promise<{ stopped: string[]; skipped: Array<{ key: string; reason: string }> }> {
    const stopped: string[] = []
    const skipped: Array<{ key: string; reason: string }> = []
    const targets = [...this.entries.values()].filter(e => e.pid !== undefined)
    for (const e of targets) {
      const pid = e.pid as number
      if (!this.groupAlive(pid)) {
        e.pid = undefined // 身份清理只发生在组确认消亡后（hardening 2b）
        continue
      }
      if (!this.leaderIsOurs(e)) {
        skipped.push({
          key: e.key,
          reason: e.child ? '组长已退出，组内后代身份无法验证' : 'PID 身份不匹配或无法验证'
        })
        continue
      }
      const r = await this.killEntry(e.key, e)
      if (r === 'ok') {
        // 状态同步：恢复接管的命令停止后也要翻成 stopped（key 形如 projectId:commandId，
        // id 均不含冒号，按第一个冒号拆）
        const i = e.key.indexOf(':')
        this.setStatus(e.key, e, e.key.slice(0, i), e.key.slice(i + 1), 'stopped')
        stopped.push(e.key)
      } else {
        skipped.push({ key: e.key, reason: r === 'signal-failed' ? '信号发送失败，进程组仍存活' : '进程组未按期消亡' })
      }
    }
    return { stopped, skipped }
  }

  /** 退出网关判定用：受管且进程组仍存活的命令数（含无法验证身份的遗留组） */
  activeInventory(): { count: number } {
    let count = 0
    for (const e of this.entries.values()) {
      if (e.pid !== undefined && this.groupAlive(e.pid)) count++
    }
    return { count }
  }

  /** 退出流程进入排空阶段：拒绝新的启动请求（hardening 2a）；
   *  取消退出/更新失败等"应用继续运行"的路径必须撤销（review 修正） */
  beginDraining(): void { this.draining = true }
  endDraining(): void { this.draining = false }
  draining = false

  /** 停止项目全部运行中/启动中的命令 */
  async stopProject(project: Project): Promise<void> {
    await Promise.all(
      project.commands
        .filter(c => ['running', 'starting'].includes(this.statusOf(project.id, c.id)))
        .map(c => this.stop(project.id, c.id))
    )
  }

  /** 应用重启后的状态恢复：服务命令 pid 存活 && 端口有服务 → running（此后可按 pgid 停止）；
   *  快捷命令（任务模式）pid 存活即 running，无需端口；否则丢弃记录 */
  async restore(projects: Project[], runtime: RuntimeFile): Promise<void> {
    this.runtime = {}
    for (const p of projects) {
      // [commandId, 是否任务模式]：服务命令 + 快捷命令（spec 2026-09-04）
      const cmdList: Array<[string, boolean]> = [
        ...p.commands.map(c => [c.id, false] as [string, boolean]),
        ...(p.quickCommands ?? []).map(q => [q.id, true] as [string, boolean])
      ]
      for (const [cid, isTask] of cmdList) {
        const k = runtimeKey(p.id, cid)
        const rec = runtime[k]
        if (!rec) continue
        const live = this.alive(rec.pid)
        if (!live) continue
        // hardening 2b：恢复接管前验证组长身份——lstart 缺失（旧记录）或不匹配
        // （PID 可能已被无关进程复用）一律不接管，宁保守丢弃
        if (!rec.lstart || procStart(rec.pid) !== rec.lstart) continue
        // v1.1a: 动态命令端口为 0，固定地址必探不通——改探 runtime 记录里持久化的 discoveredUrl；
        // 记录缺失（旧版 runtime.json）则无法验证真实端口，按 stopped 丢弃，宁错杀不误杀
        // v1.1g: 探测双栈化（127.0.0.1 与 [::1]）——恢复与启动同一套语义，dev server 可能只绑 IPv6 回环
        const c = p.commands.find(x => x.id === cid)
        let ok = true
        if (!isTask && c) {
          if (c.portMode === 'dynamic') {
            const pp = rec.discoveredUrl ? portFromUrl(rec.discoveredUrl) : null
            ok = pp ? await probePort(pp) : false // 缺 discoveredUrl：探不通即丢弃记录
          } else {
            const custom = c.healthCheckUrl?.trim()
            ok = custom ? await probe(custom) : await probePort(c.port)
          }
        }
        if (!ok) continue
        const e = this.entry(k)
        e.status = 'running'
        e.pid = rec.pid
        e.lstart = rec.lstart // 采纳即持有身份，后续 stop/stopAll 凭此验身
        if (isTask) e.task = true
        else if (c?.portMode === 'dynamic') {
          e.dynamic = true
          e.discoveredUrl = rec.discoveredUrl // 卡片显示真实端口
        }
        this.runtime[k] = rec
        this.adoptLogTail(k, e) // v1.1b: 采用后从文件头播种日志缓冲并续读增量，重开后日志面板可见本次运行从头开始的日志
      }
    }
    this.emitRuntime()
  }

  // ---- 内部工具 ----

  /** 公共落盘/spawn/日志接管（服务与任务模式共用）：日志文件 stdio（v1.1a 防 EPIPE）、
   *  会话头行落文件（v1.1b）、tail 轮询、exit/error 处理（语义按 e.task 分支） */
  private launch(
    k: string, e: Entry, gen: number,
    projectId: string, commandId: string, cmd: string, cwd: string,
    runtimeExtra: Partial<RuntimeRecord> = {}
  ): ChildProcess {
    const file = this.logFileFor(k)
    mkdirSync(this.opts.logDir(), { recursive: true })
    const header = `$ ${cmd}  (cwd: ${cwd}) @ ${new Date().toLocaleString()}\n`
    writeFileSync(file, header)
    const fd = openSync(file, 'a')
    const child = spawn(cmd, {
      shell: true,
      detached: true, // 新进程组（pgid === child.pid），保证整组可杀
      cwd,
      env: childEnv(),
      stdio: ['ignore', fd, fd]
    })
    closeSync(fd)
    e.child = child
    e.pid = child.pid
    // hardening 2b：采集组长系统身份（ps lstart）随记录持久化——恢复/停止前凭此验身
    e.lstart = child.pid ? procStart(child.pid) ?? undefined : undefined
    this.runtime[k] = {
      pid: child.pid as number, startedAt: Date.now(),
      ...(e.lstart ? { lstart: e.lstart } : {}),
      ...runtimeExtra
    }
    this.emitRuntime()
    this.append(e, `$ ${cmd}  (cwd: ${cwd})`) // 头行进缓冲/订阅推送（带时间前缀）；文件里的一份由上方 writeFileSync 落盘

    e.logFile = file
    e.decoder = new StringDecoder() // 会话头是截断点：解码状态全新（hardening 批次三）
    e.offset = Buffer.byteLength(header) // 字节计游标——表头含中文时字节数 ≠ 字符数
    this.startTail(k, e, gen)

    child.on('exit', code => {
      // 代际守卫：旧进程退出时该 entry 可能已被新一轮 start 接管，不能动新运行的状态/timers/runtime
      if (gen !== e.gen) return
      this.drainTail(e) // 临终输出有界补读（review 修正 #2）：积压超窗口时跳到尾部窗口，最新日志不漏
      this.clearTimers(e)
      const was = e.status
      e.child = undefined
      delete this.runtime[k]
      this.emitRuntime()
      if (e.task) {
        // 任务模式：已被停止/新一轮处置的不再改状态；退出码 0=完成，非 0/信号=失败
        if (was !== 'running' && was !== 'starting') return
        if (code === 0) this.setStatus(k, e, projectId, commandId, 'stopped')
        else {
          this.append(e, `[进程退出，退出码 ${code ?? 'null'}]`)
          this.setStatus(k, e, projectId, commandId, 'failed')
        }
      } else {
        // 服务模式：starting 中退出 = 启动失败；running 后退出 = 回到已停止；已 failed/stopped 的跳过（超时/手动停止已处理）
        if (was === 'starting') this.setStatus(k, e, projectId, commandId, 'failed')
        else if (was === 'running') this.setStatus(k, e, projectId, commandId, 'stopped')
      }
    })
    child.on('error', err => {
      // 代际守卫：同 exit——旧 child 的 error 不属于当前运行
      if (gen !== e.gen) return
      // spawn 失败（如 workdir 指向不存在的目录）：异步 error 事件，exit 可能不再触发
      this.append(e, `[错误] ${String(err)}`)
      this.drainTail(e) // 有界补读，与 exit 路径一致
      this.clearTimers(e)
      const was = e.status
      e.child = undefined
      delete this.runtime[k]
      this.emitRuntime()
      // 仅在尚未被超时/停止流程处置时标记 failed，避免重复发事件
      if (was === 'starting' || was === 'running') this.setStatus(k, e, projectId, commandId, 'failed')
    })
    return child
  }

  private entry(k: string): Entry {
    let e = this.entries.get(k)
    if (!e) {
      e = {
        status: 'stopped', key: k, logs: [], partial: '', pending: [],
        logSubs: new Set(), gen: 0, dynamic: false, task: false, offset: 0, partialBytes: 0
      }
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

  /** 增量解码入缓冲（hardening 批次三）：经 StringDecoder 处理跨读取边界的 UTF-8
   *  字符（读取块切在汉字中间不出乱码）；无换行超长行按字节上限强制成行冲刷 */
  protected ingest(e: Entry, d: Buffer): void {
    e.decoder ??= new StringDecoder()
    e.partial += e.decoder.write(d)
    let i = e.partial.indexOf('\n')
    while (i !== -1) {
      this.append(e, e.partial.slice(0, i))
      e.partial = e.partial.slice(i + 1)
      i = e.partial.indexOf('\n')
    }
    e.partialBytes = Buffer.byteLength(e.partial)
    if (e.partialBytes > PARTIAL_MAX_BYTES) {
      // 无换行超长行：强制成行（decoder 内的未完成字节留给后续块补完，不切字符）
      this.append(e, `${e.partial} [超长行截断]`)
      e.partial = ''
      e.partialBytes = 0
    }
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

  /** 单次增量读取（hardening 批次三 + review 修正）：**轮转检查先行**——静默的
   *  超大文件（恢复接管后无新增）同样会被限容（修正 #3）；读取走 readAt（只含
   *  已填充字节，修正 #1）；积压超过单轮上限分多轮追 */
  protected tailOnce(e: Entry): void {
    if (!e.logFile) return
    let size: number
    try {
      size = statSync(e.logFile).size
    } catch {
      return // 文件被外部删除/暂不可读：本轮跳过（restore 场景允许文件不存在）
    }
    if (size >= LOG_ROTATE_THRESHOLD) {
      this.rotateLog(e) // 轮转后游标已映射进新文件坐标，保留窗口内未读内容继续消费（修正 #2）
      try {
        size = statSync(e.logFile).size
      } catch {
        return
      }
    }
    if (size <= e.offset) return // 无新增（或被截短：游标保持，等 O_APPEND 新内容追上）
    const want = Math.min(size - e.offset, LOG_READ_CHUNK)
    const chunk = readAt(e.logFile, e.offset, want)
    if (!chunk || chunk.length === 0) return
    e.offset += chunk.length
    this.ingest(e, chunk)
  }

  /** 进程退出前的有界尾部补读（review 修正 #2 + 追加修正）：积压超过保留窗口时
   *  跳到尾部窗口再读——单轮 ≤4MB 覆盖 2MB 窗口，界面上能看到最新日志。
   *  跳读是截断点：重置 partial/decoder（旧位置的半行/半个汉字不得与新尾部
   *  拼接），并对齐窗口起点到行边界（残行连同可能的半个多字节字符一并丢弃），
   *  补一条「已跳过」标记告知用户 */
  protected drainTail(e: Entry): void {
    if (!e.logFile) return
    let size: number
    try {
      size = statSync(e.logFile).size
    } catch {
      return
    }
    if (size - e.offset <= LOG_KEEP_WINDOW) {
      this.tailOnce(e) // 积压在窗口内：顺序读完，无需跳读
      return
    }
    const rawStart = size - LOG_KEEP_WINDOW
    const window = readAt(e.logFile, rawStart, LOG_KEEP_WINDOW) ?? Buffer.alloc(0)
    const nl = window.indexOf(0x0a)
    // 无换行的巨型行无法对齐：keptStart 取窗口起点（行首可能有少量替换字符，容忍）
    const keptStart = rawStart + (nl === -1 ? 0 : nl + 1)
    const skipped = Math.max(0, keptStart - e.offset)
    // 截断点重置：旧位置的解码状态属于被跳过的内容
    e.decoder = new StringDecoder()
    e.partial = ''
    e.partialBytes = 0
    e.offset = keptStart
    this.tailOnce(e)
    // 标记放在补读之后追加——若放前面会被窗口内的行挤出 500 行环形缓冲
    this.append(e, `[已跳过 ${skipped} 字节积压日志，以上为最近内容]`)
  }

  /** 轮转截断（hardening 批次三 + review 修正 #1/#2）：文件超阈值时在**原文件**上
   *  重写、只保留尾部窗口（禁止临时文件 + rename——子进程 O_APPEND fd 指向原
   *  inode）。窗口读取走 readAt——读到长度不符（文件中途被截短等）即中止，
   *  **不覆盖原日志**；重写瞬间子进程的新写入可能丢失，属文档化边界。
   *  游标映射进新文件坐标：保留窗口内尚未消费的内容不会被跳过（修正 #2） */
  private rotateLog(e: Entry): void {
    if (!e.logFile) return
    let size: number
    try {
      size = statSync(e.logFile).size
    } catch {
      return
    }
    const start = Math.max(0, size - LOG_KEEP_WINDOW)
    const want = size - start
    const window = readAt(e.logFile, start, want)
    if (!window || window.length < want) return // 短读：文件在读取期间变化，保持原样不动
    // 对齐换行：窗口从文件中间起（轮转触发时 size ≥ 10MB，start 恒 > 0），
    // 丢弃首个换行前的残行（可能截半）；无换行保留整窗口
    const nl = start > 0 ? window.indexOf(0x0a) : -1
    const keptStart = start + (nl === -1 ? 0 : nl + 1)
    const kept = window.subarray(keptStart - start)
    const prefix = Buffer.from(`\n…[日志已限容：前 ${keptStart} 字节截断]…\n`, 'utf8')
    try {
      writeFileSync(e.logFile, Buffer.concat([prefix, kept])) // 原地截断重写，inode 不变
    } catch {
      return
    }
    // 游标映射：旧坐标 o（已消费到）→ 新坐标。o 在保留区间内 → 对应位置；
    // o 在丢弃区间（未消费到窗口）→ 窗口起点，保留窗口由后续 tail 消费（不跳过）
    const o = e.offset
    const newSize = prefix.length + kept.length
    e.offset = o >= size ? newSize
      : o >= keptStart ? prefix.length + (o - keptStart)
      : prefix.length
    // 截断点统一重置：decoder/partial 清空（旧内容不拼进续写）
    e.decoder = new StringDecoder()
    e.partial = ''
    e.partialBytes = 0
  }

  /** v1.1b + hardening 批次三：接管日志改**有界尾部读取**——窗口对齐换行、
   *  无换行的超长文件保留窗口字节并标记截断；游标落到当前末尾续读增量。
   *  不再全量读入（GB 级文件防内存冲击）；播种行保留文件原样（无时间前缀） */
  protected adoptLogTail(k: string, e: Entry): void {
    const file = this.logFileFor(k)
    e.logFile = file
    e.decoder = new StringDecoder()
    e.partial = ''
    e.partialBytes = 0
    try {
      const size = statSync(file).size
      const start = Math.max(0, size - LOG_KEEP_WINDOW)
      const window = readAt(file, start, size - start) ?? Buffer.alloc(0) // 短读只取已填充部分
      // 对齐换行：仅当窗口从文件中间起（可能截在残行中）才丢弃首段残行；
      // 从文件头起的窗口本就是行边界；无换行保留整窗口
      const nl = start > 0 ? window.indexOf(0x0a) : -1
      const kept = nl === -1 ? window : window.subarray(nl + 1)
      const lines = kept.toString('utf8').split('\n').filter(l => l !== '')
      // 先按上限裁剪再补标记行——标记必须留在缓冲内，不能被 slice 切掉
      e.logs = lines.slice(-(MAX_LOG_LINES - 1))
      if (start > 0) e.logs.unshift('[恢复截断：历史日志仅保留最近约 2MB]')
      e.offset = size // 游标=当前末尾，只续读增量
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

  /** 杀整个进程组并确认消亡（review 修正）：SIGTERM → 宽限 → SIGKILL → 确认。
   *  返回 ok=组已消亡；signal-failed=信号发不出且组仍存活；still-alive=SIGKILL
   *  后宽限期内组仍存活。信号发送失败先复查组是否恰好已消亡（review 修正
   *  P2-2：身份检查后进程自行退出属正常，按成功处理）。可注入/覆写（测试用） */
  protected async signalGroup(pid: number): Promise<'ok' | 'signal-failed' | 'still-alive'> {
    const grace = this.opts.killGraceMs ?? 5000
    const postKillWait = Math.min(grace, 2000)
    if (!this.killGroup(pid, 'SIGTERM')) {
      if (!this.groupAlive(pid)) return 'ok' // 组恰已消亡（自然退出竞态）：视为成功
      if (!this.killGroup(pid, 'SIGKILL')) {
        if (!this.groupAlive(pid)) return 'ok'
        return 'signal-failed'
      }
    }
    const t0 = Date.now()
    while (this.groupAlive(pid) && Date.now() - t0 < grace) {
      await new Promise(r => setTimeout(r, 200))
    }
    if (!this.groupAlive(pid)) return 'ok'
    if (!this.killGroup(pid, 'SIGKILL')) {
      if (!this.groupAlive(pid)) return 'ok'
      return 'signal-failed'
    }
    const t1 = Date.now()
    while (this.groupAlive(pid) && Date.now() - t1 < postKillWait) {
      await new Promise(r => setTimeout(r, 100))
    }
    return this.groupAlive(pid) ? 'still-alive' : 'ok'
  }

  /** 杀整个进程组并清理 runtime 记录；失败时保留记录（review 修正：
   *  未确认消亡不得删记录、不得报成功） */
  private async killEntry(k: string, e: Entry): Promise<'ok' | 'signal-failed' | 'still-alive'> {
    const pid = e.pid
    const gen = e.gen // 停止期间可能已被新一轮 start 接管：旧 pid 照杀，但 runtime 清理需守卫
    const result = pid !== undefined ? await this.signalGroup(pid) : 'ok'
    if (result === 'ok' && gen === e.gen) {
      delete this.runtime[k]
      this.emitRuntime()
    }
    return result
  }

  /** 测试后门：清理本 manager 启动的所有进程——与生产 stopAll 同一套
   *  「组存活 + 身份验证」守卫（hardening 2b：测试进程有 child 句柄，全部可信） */
  async stopProjectForTest(): Promise<void> {
    await this.stopAll()
  }
}

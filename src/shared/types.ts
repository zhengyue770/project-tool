// ---- 运行状态 ----
export type CommandRuntimeStatus = 'stopped' | 'starting' | 'running' | 'failed'
export type ProjectAggStatus = 'stopped' | 'starting' | 'running' | 'failed' | 'partial'

// ---- 项目配置（projects.json）----
export interface CommandConfig {
  id: string
  name: string
  cmd: string
  workdir: string // 相对项目根目录，默认 '.'
  port: number // fixed 模式必填；dynamic 模式忽略，存 0
  /** v1.1: 端口模式——'fixed' 固定端口探测（现状）；'dynamic' 从启动日志捕获真实地址再探测。缺省按 fixed 读（兼容旧配置） */
  portMode?: 'fixed' | 'dynamic'
  /** v1.1: 仅动态模式有效——自定义端口捕获正则；留空用内置规则 */
  successPattern?: string
  healthCheckUrl?: string // 覆盖默认探测地址 http://127.0.0.1:{port}（动态模式下忽略）
}
export interface UrlConfig { id: string; name: string; url: string }
export interface Account { id: string; label: string; username: string; password: string; role: string }
export interface Project {
  id: string
  name: string
  path: string
  commands: CommandConfig[]
  urls: UrlConfig[]
  accounts: Account[]
  createdAt: number
  /** 快捷命令（spec 2026-09-04-quick-commands）：可选字段，旧配置缺省为无 */
  quickCommands?: QuickCommand[]
  /** 上次同步快捷命令的时间戳 */
  quickSyncedAt?: number
  /** 已删除的同步命令 id（排除列表）：同步时跳过，不再加回；源文件删除后自动清理 */
  quickExcluded?: string[]
  /** 编程应用名（spec 2026-09-04-open-in-ide）：macOS open -a 用的应用显示名，如 "Visual Studio Code"；缺省不显示 IDE 按钮 */
  ideApp?: string
}
export interface ProjectsFile { version: number; projects: Project[] }

// ---- 快捷命令（spec 2026-09-04-quick-commands）----
export type QuickSyncSource = 'package.json' | 'Makefile' | 'Justfile' | 'composer.json'
export interface QuickCommand {
  /** 同步命令用稳定 id `sync:<source>:<name>`（重同步后运行状态/日志不丢）；手动命令用 uuid */
  id: string
  name: string
  cmd: string
  /** 仅手动命令使用；缺省 '.'（项目根目录） */
  workdir?: string
  source: 'manual' | QuickSyncSource
}

// ---- 应用设置（settings.json）----
export interface AppSettings { startupTimeoutMs: number; autoLaunch: boolean }

// ---- 运行时（runtime.json，key = `${projectId}:${commandId}`）----
export interface RuntimeRecord {
  pid: number
  startedAt: number
  /** v1.1a: 动态端口模式捕获到的服务地址（如 http://127.0.0.1:5173）；应用重启后 restore 凭它探测真实端口。仅动态模式有值 */
  discoveredUrl?: string
  /** 快捷命令（任务模式）标记：restore 时只查 pid 存活即恢复 running，不探端口 */
  task?: boolean
}
export type RuntimeFile = Record<string, RuntimeRecord>

export function runtimeKey(projectId: string, commandId: string): string {
  return `${projectId}:${commandId}`
}

// ---- 界面视图 ----
export interface ProjectView extends Project {
  aggStatus: ProjectAggStatus
  commandStates: Record<string, CommandRuntimeStatus>
  /** 动态模式命令实际发现的端口（仅运行中有值）；固定模式恒 null */
  discoveredPorts: Record<string, number | null>
  /** 快捷命令运行状态（未运行缺省 stopped） */
  quickStates: Record<string, CommandRuntimeStatus>
  /** 当前 git 分支（spec 2026-09-04-git-branch）：string=分支名；null=非 git 仓库；undefined=尚未读取 */
  branch?: string | null
}

// ---- git 分支（spec 2026-09-04-git-branch）----
export interface BranchList {
  current: string
  locals: string[]
  /** 未提交改动文件数（提示用；切换是否被拒绝由 git 自身判断） */
  dirtyCount: number
}

// ---- IPC 事件负载 ----
export interface ProjectsEventPayload {
  projectId: string
  aggStatus: ProjectAggStatus
  commandStates: Record<string, CommandRuntimeStatus>
  discoveredPorts: Record<string, number | null>
  quickCommandStates: Record<string, CommandRuntimeStatus>
}
export interface LogAppendPayload { projectId: string; commandId: string; lines: string[] }

// ---- 存储 ----
export interface StorageInfo { dir: string; isDefault: boolean; sizeBytes: number }
export type MigrationResult = { ok: true; to: string } | { ok: false; error: string }

// ---- 自动更新（spec 2026-09-04-auto-update-design）----
export type UpdateStatus =
  | 'idle' | 'checking' | 'available' | 'not-available'
  | 'downloading' | 'downloaded' | 'installing' | 'error'
export interface UpdateProgress { receivedBytes: number; totalBytes: number } // totalBytes=0 表示未知
export interface UpdateState {
  status: UpdateStatus
  currentVersion: string
  remoteVersion?: string
  notes?: string
  progress?: UpdateProgress
  message?: string
}

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
}
export interface ProjectsFile { version: number; projects: Project[] }

// ---- 应用设置（settings.json）----
export interface AppSettings { startupTimeoutMs: number; autoLaunch: boolean }

// ---- 运行时（runtime.json，key = `${projectId}:${commandId}`）----
export interface RuntimeRecord { pid: number; startedAt: number }
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
}

// ---- IPC 事件负载 ----
export interface ProjectsEventPayload {
  projectId: string
  aggStatus: ProjectAggStatus
  commandStates: Record<string, CommandRuntimeStatus>
  discoveredPorts: Record<string, number | null>
}
export interface LogAppendPayload { projectId: string; commandId: string; lines: string[] }

// ---- 存储 ----
export interface StorageInfo { dir: string; isDefault: boolean; sizeBytes: number }
export type MigrationResult = { ok: true; to: string } | { ok: false; error: string }

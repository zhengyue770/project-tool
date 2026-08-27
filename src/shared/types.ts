// ---- 运行状态 ----
export type CommandRuntimeStatus = 'stopped' | 'starting' | 'running' | 'failed'
export type ProjectAggStatus = 'stopped' | 'starting' | 'running' | 'failed' | 'partial'

// ---- 项目配置（projects.json）----
export interface CommandConfig {
  id: string
  name: string
  cmd: string
  workdir: string // 相对项目根目录，默认 '.'
  port: number
  healthCheckUrl?: string // 覆盖默认探测地址 http://127.0.0.1:{port}
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
}

// ---- IPC 事件负载 ----
export interface ProjectsEventPayload {
  projectId: string
  aggStatus: ProjectAggStatus
  commandStates: Record<string, CommandRuntimeStatus>
}
export interface LogAppendPayload { projectId: string; commandId: string; lines: string[] }

// ---- 存储 ----
export interface StorageInfo { dir: string; isDefault: boolean; sizeBytes: number }
export type MigrationResult = { ok: true; to: string } | { ok: false; error: string }

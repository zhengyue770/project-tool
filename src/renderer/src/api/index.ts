import type {
  AppSettings, LogAppendPayload, MigrationResult, Project, ProjectView, StorageInfo
} from '../../../shared/types'

export interface RendererApi {
  listProjects(): Promise<ProjectView[]>
  createProject(p: Project): Promise<void>
  updateProject(id: string, p: Project): Promise<void>
  deleteProject(id: string): Promise<void>
  startProject(id: string, commandId?: string): Promise<void>
  stopProject(id: string, commandId?: string): Promise<void>
  getLogs(projectId: string, commandId: string): Promise<string[]>
  clearLogs(projectId: string, commandId: string): Promise<void>
  subscribeLogs(projectId: string, commandId: string): Promise<void>
  unsubscribeLogs(projectId: string, commandId: string): Promise<void>
  onLogAppend(cb: (d: LogAppendPayload) => void): () => void
  onProjectsEvent(cb: () => void): () => void
  pickDirectory(): Promise<string | null>
  openExternal(url: string): Promise<void>
  getStorageInfo(): Promise<StorageInfo>
  changeDataDir(dir: string): Promise<MigrationResult>
  getSettings(): Promise<AppSettings>
  setSettings(s: AppSettings): Promise<void>
}

declare global {
  interface Window { api: RendererApi }
}

export const api: RendererApi = window.api

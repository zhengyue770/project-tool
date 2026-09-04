import type {
  AppSettings, BranchList, LogAppendPayload, MigrationResult, Project, ProjectView, StorageInfo, UpdateState
} from '../../../shared/types'

export interface RendererApi {
  listProjects(): Promise<ProjectView[]>
  createProject(p: Project): Promise<void>
  updateProject(id: string, p: Project): Promise<void>
  deleteProject(id: string): Promise<void>
  startProject(id: string, commandId?: string): Promise<void>
  stopProject(id: string, commandId?: string): Promise<void>
  executeQuickCommand(id: string, commandId: string): Promise<void>
  stopQuickCommand(id: string, commandId: string): Promise<void>
  syncQuickCommands(id: string): Promise<ProjectView>
  getLogs(projectId: string, commandId: string): Promise<string[]>
  clearLogs(projectId: string, commandId: string): Promise<void>
  subscribeLogs(projectId: string, commandId: string): Promise<void>
  unsubscribeLogs(projectId: string, commandId: string): Promise<void>
  onLogAppend(cb: (d: LogAppendPayload) => void): () => void
  onProjectsEvent(cb: () => void): () => void
  pickDirectory(): Promise<string | null>
  openExternal(url: string): Promise<void>
  openTerminal(projectId: string): Promise<void>
  openIde(projectId: string): Promise<void>
  listIdeApps(): Promise<string[]>
  getBranches(projectId: string): Promise<BranchList | null>
  switchBranch(projectId: string, branch: string): Promise<void>
  getStorageInfo(): Promise<StorageInfo>
  changeDataDir(dir: string): Promise<MigrationResult>
  getSettings(): Promise<AppSettings>
  setSettings(s: AppSettings): Promise<void>
  getUpdateState(): Promise<UpdateState>
  checkUpdate(): Promise<UpdateState>
  downloadUpdate(): Promise<UpdateState>
  installUpdate(): Promise<void>
  onUpdateState(cb: (s: UpdateState) => void): () => void
}

declare global {
  interface Window { api: RendererApi }
}

export const api: RendererApi = window.api

import { contextBridge, ipcRenderer } from 'electron'
import type {
  AppSettings, BranchList, LogAppendPayload, MigrationResult, Project, ProjectInput, ProjectView, StorageInfo, UpdateState
} from '../shared/types'

const api = {
  listProjects: (): Promise<ProjectView[]> => ipcRenderer.invoke('projects:list'),
  createProject: (p: ProjectInput): Promise<void> => ipcRenderer.invoke('projects:create', p),
  updateProject: (id: string, p: ProjectInput): Promise<void> => ipcRenderer.invoke('projects:update', id, p),
  deleteProject: (id: string): Promise<void> => ipcRenderer.invoke('projects:delete', id),
  startProject: (id: string, commandId?: string): Promise<void> =>
    ipcRenderer.invoke('projects:start', id, commandId),
  stopProject: (id: string, commandId?: string): Promise<void> =>
    ipcRenderer.invoke('projects:stop', id, commandId),
  executeQuickCommand: (id: string, commandId: string): Promise<void> =>
    ipcRenderer.invoke('quick:execute', id, commandId),
  stopQuickCommand: (id: string, commandId: string): Promise<void> =>
    ipcRenderer.invoke('quick:stop', id, commandId),
  syncQuickCommands: (id: string): Promise<ProjectView> =>
    ipcRenderer.invoke('quick:sync', id),
  getLogs: (projectId: string, commandId: string): Promise<string[]> =>
    ipcRenderer.invoke('projects:logs', projectId, commandId),
  clearLogs: (projectId: string, commandId: string): Promise<void> =>
    ipcRenderer.invoke('projects:clearLogs', projectId, commandId),
  subscribeLogs: (projectId: string, commandId: string): Promise<void> =>
    ipcRenderer.invoke('logs:subscribe', projectId, commandId),
  unsubscribeLogs: (projectId: string, commandId: string): Promise<void> =>
    ipcRenderer.invoke('logs:unsubscribe', projectId, commandId),
  onLogAppend: (cb: (d: LogAppendPayload) => void): (() => void) => {
    const l = (_e: Electron.IpcRendererEvent, d: LogAppendPayload): void => cb(d)
    ipcRenderer.on('logs:append', l)
    return () => ipcRenderer.removeListener('logs:append', l)
  },
  onProjectsEvent: (cb: () => void): (() => void) => {
    const l = (): void => cb()
    ipcRenderer.on('projects:events', l)
    return () => ipcRenderer.removeListener('projects:events', l)
  },
  pickDirectory: (): Promise<string | null> => ipcRenderer.invoke('dialog:pickDirectory'),
  openExternal: (url: string): Promise<void> => ipcRenderer.invoke('shell:openExternal', url),
  openTerminal: (projectId: string): Promise<void> => ipcRenderer.invoke('shell:openTerminal', projectId),
  openIde: (projectId: string): Promise<void> => ipcRenderer.invoke('shell:openIde', projectId),
  listIdeApps: (): Promise<string[]> => ipcRenderer.invoke('system:listIdeApps'),
  getBranches: (projectId: string): Promise<BranchList | null> =>
    ipcRenderer.invoke('git:listBranches', projectId),
  switchBranch: (projectId: string, branch: string): Promise<void> =>
    ipcRenderer.invoke('git:switchBranch', projectId, branch),
  getStorageInfo: (): Promise<StorageInfo> => ipcRenderer.invoke('storage:getInfo'),
  changeDataDir: (dir: string): Promise<MigrationResult> => ipcRenderer.invoke('storage:change', dir),
  getSettings: (): Promise<AppSettings> => ipcRenderer.invoke('settings:get'),
  setSettings: (s: AppSettings): Promise<void> => ipcRenderer.invoke('settings:set', s),
  getUpdateState: (): Promise<UpdateState> => ipcRenderer.invoke('update:getState'),
  checkUpdate: (): Promise<UpdateState> => ipcRenderer.invoke('update:check'),
  downloadUpdate: (): Promise<UpdateState> => ipcRenderer.invoke('update:download'),
  installUpdate: (): Promise<void> => ipcRenderer.invoke('update:install'),
  onUpdateState: (cb: (s: UpdateState) => void): (() => void) => {
    const l = (_e: Electron.IpcRendererEvent, s: UpdateState): void => cb(s)
    ipcRenderer.on('update:state', l)
    return () => ipcRenderer.removeListener('update:state', l)
  }
}

contextBridge.exposeInMainWorld('api', api)

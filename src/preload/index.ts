import { contextBridge, ipcRenderer } from 'electron'
import type {
  AppSettings, LogAppendPayload, MigrationResult, Project, ProjectView, StorageInfo
} from '../shared/types'

const api = {
  listProjects: (): Promise<ProjectView[]> => ipcRenderer.invoke('projects:list'),
  createProject: (p: Project): Promise<void> => ipcRenderer.invoke('projects:create', p),
  updateProject: (id: string, p: Project): Promise<void> => ipcRenderer.invoke('projects:update', id, p),
  deleteProject: (id: string): Promise<void> => ipcRenderer.invoke('projects:delete', id),
  startProject: (id: string, commandId?: string): Promise<void> =>
    ipcRenderer.invoke('projects:start', id, commandId),
  stopProject: (id: string, commandId?: string): Promise<void> =>
    ipcRenderer.invoke('projects:stop', id, commandId),
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
  getStorageInfo: (): Promise<StorageInfo> => ipcRenderer.invoke('storage:getInfo'),
  changeDataDir: (dir: string): Promise<MigrationResult> => ipcRenderer.invoke('storage:change', dir),
  getSettings: (): Promise<AppSettings> => ipcRenderer.invoke('settings:get'),
  setSettings: (s: AppSettings): Promise<void> => ipcRenderer.invoke('settings:set', s)
}

contextBridge.exposeInMainWorld('api', api)

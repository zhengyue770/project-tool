import { ipcMain, dialog, shell, app } from 'electron'
import { existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type {
  AppSettings, CommandRuntimeStatus, Project, ProjectView, StorageInfo
} from '../shared/types'
import { aggregateProjectStatus } from './process/state'
import type { ProcessManager } from './process/manager'
import type { StoragePaths } from './store/storagePaths'
import type { ProjectsStore } from './store/projectsStore'
import type { SettingsStore } from './store/settingsStore'
import type { RuntimeStore } from './store/runtimeStore'
import { migrateDataDir } from './store/migrator'

interface IpcCtx {
  getWin: () => Electron.BrowserWindow | null
  paths: StoragePaths
  projectsStore: ProjectsStore
  settingsStore: SettingsStore
  runtimeStore: RuntimeStore
  manager: ProcessManager
}

function toView(p: Project, m: ProcessManager): ProjectView {
  const commandStates: Record<string, CommandRuntimeStatus> = {}
  const discoveredPorts: Record<string, number | null> = {}
  for (const c of p.commands) {
    commandStates[c.id] = m.statusOf(p.id, c.id)
    discoveredPorts[c.id] = m.discoveredPortOf(p.id, c.id) // 固定模式恒 null
  }
  return { ...p, commandStates, discoveredPorts, aggStatus: aggregateProjectStatus(Object.values(commandStates)) }
}

function validateProject(p: Project): void {
  if (!p.name?.trim()) throw new Error('项目名称不能为空')
  if (!existsSync(p.path)) throw new Error(`项目路径不存在：${p.path}`)
  if (!p.commands?.length) throw new Error('至少需要一条启动命令')
  for (const c of p.commands) {
    if (!c.cmd?.trim()) throw new Error('启动命令不能为空')
    if (c.portMode === 'dynamic') {
      // 动态模式：端口被忽略（存 0），改校验自定义正则可编译
      const pat = c.successPattern?.trim()
      if (pat) {
        try { new RegExp(pat) } catch (err) {
          throw new Error(`命令「${c.name}」的自定义匹配正则无法编译：${(err as Error).message}`)
        }
      }
    } else if (!Number.isInteger(c.port) || c.port < 1 || c.port > 65535) {
      // fixed（含缺省 portMode 的旧配置）：维持现行端口校验
      throw new Error(`命令「${c.name}」端口需为 1-65535 的整数`)
    }
  }
}

export function registerIpc(ctx: IpcCtx): void {
  const { manager, projectsStore, settingsStore, paths } = ctx

  // 状态事件：任一命令状态变化 → 推送该项目聚合视图（渲染层收到后刷新列表）
  const pushEvent = (projectId: string): void => {
    const win = ctx.getWin()
    const p = projectsStore.load().projects.find(x => x.id === projectId)
    if (!win || !p) return
    const view = toView(p, manager)
    win.webContents.send('projects:events', {
      projectId, aggStatus: view.aggStatus, commandStates: view.commandStates,
      discoveredPorts: view.discoveredPorts
    })
  }
  manager.setStatusListener(ev => pushEvent(ev.projectId))

  // 日志订阅（单窗口：同 key 重复订阅先退订旧的）
  const logSubs = new Map<string, () => void>()
  const subKey = (pid: string, cid: string): string => `${pid}:${cid}`

  ipcMain.handle('projects:list', () => projectsStore.load().projects.map(p => toView(p, manager)))

  ipcMain.handle('projects:create', (_e, p: Project) => {
    validateProject(p)
    projectsStore.upsert(p)
  })

  ipcMain.handle('projects:update', (_e, id: string, p: Project) => {
    if (!projectsStore.load().projects.some(x => x.id === id)) throw new Error('项目不存在')
    validateProject(p)
    projectsStore.upsert({ ...p, id })
  })

  ipcMain.handle('projects:delete', async (_e, id: string) => {
    const p = projectsStore.load().projects.find(x => x.id === id)
    if (p) await manager.stopProject(p)
    projectsStore.remove(id)
  })

  ipcMain.handle('projects:start', (_e, id: string, commandId?: string) => {
    const p = projectsStore.load().projects.find(x => x.id === id)
    if (!p) throw new Error('项目不存在')
    if (commandId) {
      const c = p.commands.find(x => x.id === commandId)
      if (c) manager.start(p, c)
    } else {
      for (const c of p.commands) {
        if (['stopped', 'failed'].includes(manager.statusOf(p.id, c.id))) manager.start(p, c)
      }
    }
  })

  ipcMain.handle('projects:stop', async (_e, id: string, commandId?: string) => {
    const p = projectsStore.load().projects.find(x => x.id === id)
    if (!p) throw new Error('项目不存在')
    if (commandId) await manager.stop(id, commandId)
    else await manager.stopProject(p)
  })

  ipcMain.handle('projects:logs', (_e, projectId: string, commandId: string) =>
    manager.logsOf(projectId, commandId))

  ipcMain.handle('projects:clearLogs', (_e, projectId: string, commandId: string) => {
    manager.clearLogs(projectId, commandId)
  })

  ipcMain.handle('logs:subscribe', (_e, projectId: string, commandId: string) => {
    const k = subKey(projectId, commandId)
    logSubs.get(k)?.()
    logSubs.set(k, manager.subscribeLogs(projectId, commandId, lines => {
      ctx.getWin()?.webContents.send('logs:append', { projectId, commandId, lines })
    }))
  })

  ipcMain.handle('logs:unsubscribe', (_e, projectId: string, commandId: string) => {
    const k = subKey(projectId, commandId)
    logSubs.get(k)?.()
    logSubs.delete(k)
  })

  ipcMain.handle('dialog:pickDirectory', async () => {
    const win = ctx.getWin()
    if (!win) return null
    const r = await dialog.showOpenDialog(win, { properties: ['openDirectory'], title: '选择文件夹' })
    return r.canceled ? null : (r.filePaths[0] ?? null)
  })

  ipcMain.handle('shell:openExternal', (_e, url: string) => {
    if (!/^https?:\/\//.test(url)) throw new Error('仅支持 http/https 地址')
    return shell.openExternal(url)
  })

  ipcMain.handle('storage:getInfo', (): StorageInfo => {
    const dir = paths.getDataDir()
    let sizeBytes = 0
    for (const f of ['projects.json', 'settings.json', 'runtime.json']) {
      const fp = join(dir, f)
      if (existsSync(fp)) sizeBytes += statSync(fp).size
    }
    return { dir, isDefault: paths.isDefault(dir), sizeBytes }
  })

  ipcMain.handle('storage:change', (_e, nextDir: string) => migrateDataDir(paths, nextDir))

  ipcMain.handle('settings:get', () => settingsStore.load())

  ipcMain.handle('settings:set', (_e, s: AppSettings) => {
    settingsStore.save(s)
    app.setLoginItemSettings({ openAtLogin: !!s.autoLaunch })
  })
}

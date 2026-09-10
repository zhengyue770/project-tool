import { ipcMain, dialog, shell, app, safeStorage } from 'electron'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { join } from 'node:path'
import type {
  AccountInput, AppSettings, BranchList, CommandRuntimeStatus, Project, ProjectView,
  StorageInfo, StoredAccount, UpdateState
} from '../shared/types'
import { aggregateProjectStatus } from './process/state'
import type { ProcessManager } from './process/manager'
import type { StoragePaths } from './store/storagePaths'
import type { ProjectsStore } from './store/projectsStore'
import type { SettingsStore } from './store/settingsStore'
import type { RuntimeStore } from './store/runtimeStore'
import { migrateDataDir } from './store/migrator'
import { scanQuickCommands } from './quick/scan'
import { applySync, dropStartupDuplicates, filterExcluded, cleanExcluded } from '../shared/quickSync'
import { mergeAccounts, projectToRenderer, type SafeCrypto } from './store/passwordCrypto'
import type { AppUpdater } from './updater/updater'
import type { GitBranchService } from './git/branch'
import type { QuitGateway } from './quitGateway'

/** safeStorage 适配（app ready 后才被调用；渲染层/测试不直接依赖 electron） */
const crypto: SafeCrypto = {
  isEncryptionAvailable: () => safeStorage.isEncryptionAvailable(),
  encryptString: s => safeStorage.encryptString(s),
  decryptString: b => safeStorage.decryptString(b)
}

interface IpcCtx {
  getWin: () => Electron.BrowserWindow | null
  paths: StoragePaths
  projectsStore: ProjectsStore
  settingsStore: SettingsStore
  runtimeStore: RuntimeStore
  manager: ProcessManager
  updater: AppUpdater
  branches: GitBranchService
  quit: QuitGateway
}

function toView(p: Project, m: ProcessManager, branches: GitBranchService): ProjectView {
  const commandStates: Record<string, CommandRuntimeStatus> = {}
  const discoveredPorts: Record<string, number | null> = {}
  for (const c of p.commands) {
    commandStates[c.id] = m.statusOf(p.id, c.id)
    discoveredPorts[c.id] = m.discoveredPortOf(p.id, c.id) // 固定模式恒 null
  }
  const quickStates: Record<string, CommandRuntimeStatus> = {}
  for (const q of p.quickCommands ?? []) quickStates[q.id] = m.statusOf(p.id, q.id)
  return {
    ...projectToRenderer(crypto, p), commandStates, discoveredPorts, quickStates, // 账号出参：解密，密文不外泄
    aggStatus: aggregateProjectStatus(Object.values(commandStates)),
    branch: branches.cachedOf(p.id) // 缓存直读：未读取 undefined / 非 git null，界面据此隐藏
  }
}

function validateProject(p: Project): void {
  if (!p.name?.trim()) throw new Error('项目名称不能为空')
  if (!existsSync(p.path)) throw new Error(`项目路径不存在：${p.path}`)
  if (!p.commands?.length) throw new Error('至少需要一条启动命令')
  for (const c of p.commands) {
    if (!c.name?.trim()) throw new Error('命令名称不能为空')
    if (!c.cmd?.trim()) throw new Error('命令的启动命令不能为空')
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
  // 快捷命令（spec 2026-09-04）：手动命令名称/命令必填；同步命令内容来自源头不校验
  for (const q of p.quickCommands ?? []) {
    if (q.source === 'manual' && (!q.name?.trim() || !q.cmd?.trim())) {
      throw new Error('快捷命令的名称和命令不能为空')
    }
  }
}

/** 快捷命令自动同步（spec §4）：按项目当前路径重扫 → 剔除与启动命令重复的 →
 *  应用排除列表（删除的同步命令不再加回）并清理失效排除项 → applySync 保序合并；
 *  create/update 保存后与手动同步（quick:sync）共用 */
function autoSyncQuick(p: Project): Project {
  const scanned = dropStartupDuplicates(p.commands, scanQuickCommands(p.path))
  const excluded = cleanExcluded(p.quickExcluded ?? [], scanned)
  const merged = applySync(p.quickCommands, filterExcluded(scanned, excluded))
  const rest = { ...p }
  if (merged.length) rest.quickCommands = merged
  else delete rest.quickCommands
  rest.quickSyncedAt = Date.now() // 无论结果如何，同步发生过
  if (excluded.length) rest.quickExcluded = excluded
  else delete rest.quickExcluded
  return rest
}

export function registerIpc(ctx: IpcCtx): void {
  const { manager, projectsStore, settingsStore, paths } = ctx

  // 状态事件：任一命令状态变化 → 推送该项目聚合视图（渲染层收到后刷新列表）
  const pushEvent = (projectId: string): void => {
    const win = ctx.getWin()
    const p = projectsStore.load().projects.find(x => x.id === projectId)
    if (!win || !p) return
    const view = toView(p, manager, ctx.branches)
    win.webContents.send('projects:events', {
      projectId, aggStatus: view.aggStatus, commandStates: view.commandStates,
      discoveredPorts: view.discoveredPorts, quickCommandStates: view.quickStates
    })
  }
  manager.setStatusListener(ev => pushEvent(ev.projectId))

  // 日志订阅（单窗口：同 key 重复订阅先退订旧的）
  const logSubs = new Map<string, () => void>()
  const subKey = (pid: string, cid: string): string => `${pid}:${cid}`

  ipcMain.handle('projects:list', () =>
    projectsStore.load().projects.map(p => toView(p, manager, ctx.branches)))

  ipcMain.handle('projects:create', (_e, pIn: Project) => {
    // hardening 批次四：入参密码经哨兵合并（新项目全部视为新密码，逐个加密）
    // 落盘形态（账号密码可能为密文对象）与 Project 运行时同构，受控转换
    const p = { ...pIn, accounts: mergeAccounts(crypto, [], pIn.accounts as AccountInput[]) } as unknown as Project
    validateProject(p)
    const saved = autoSyncQuick(p) // 保存后自动读 package.json 等生成同步命令
    projectsStore.upsert(saved)
    // 分支缓存启动时才预热——新建项目补一次并推送，否则界面看不到分支入口
    void ctx.branches.refresh(saved.id).then(() => pushEvent(saved.id))
  })

  ipcMain.handle('projects:update', (_e, id: string, pIn: Project) => {
    const prior = projectsStore.load().projects.find(x => x.id === id)
    if (!prior) throw new Error('项目不存在')
    // 密码未改动（undefined 哨兵）→ 保留存储原值（密文字节不动）；有值 → 加密
    const p = {
      ...pIn,
      accounts: mergeAccounts(crypto, (prior.accounts ?? []) as unknown as StoredAccount[], pIn.accounts as AccountInput[])
    } as unknown as Project
    validateProject(p)
    const saved = autoSyncQuick({ ...p, id }) // 路径可能已变，重扫一遍
    projectsStore.upsert(saved)
    void ctx.branches.refresh(id).then(() => pushEvent(id)) // 路径变了分支也可能变
  })

  ipcMain.handle('projects:delete', async (_e, id: string) => {
    const p = projectsStore.load().projects.find(x => x.id === id)
    if (p) {
      // 快捷命令与启动命令一并停止后再删（spec §5：删除项目停全部）
      for (const q of p.quickCommands ?? []) await manager.stop(id, q.id)
      await manager.stopProject(p)
    }
    projectsStore.remove(id)
    ctx.branches.evict(id)
  })

  ipcMain.handle('projects:start', (_e, id: string, commandId?: string) => {
    if (manager.draining) throw new Error('应用正在退出，无法启动新命令') // hardening 2a
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

  // 快捷命令（spec 2026-09-04 §6）
  ipcMain.handle('quick:execute', (_e, projectId: string, commandId: string) => {
    if (manager.draining) throw new Error('应用正在退出，无法启动新命令') // hardening 2a
    const p = projectsStore.load().projects.find(x => x.id === projectId)
    const q = p?.quickCommands?.find(c => c.id === commandId)
    if (!p || !q) throw new Error('快捷命令不存在（可能已被同步移除，请重新打开设置）')
    manager.runTask(p, q)
  })

  ipcMain.handle('quick:stop', (_e, projectId: string, commandId: string) =>
    manager.stop(projectId, commandId))

  ipcMain.handle('quick:sync', (_e, projectId: string): ProjectView => {
    const p = projectsStore.load().projects.find(x => x.id === projectId)
    if (!p) throw new Error('项目不存在')
    const next = autoSyncQuick(p)
    projectsStore.upsert(next)
    pushEvent(projectId) // 卡片同步刷新
    return toView(next, manager, ctx.branches)
  })

  // git 分支（spec 2026-09-04-git-branch）：分支缓存变化（启动预热/切换成功）即推送刷新卡片
  ctx.branches.setOnChange(pushEvent)
  ipcMain.handle('git:listBranches', (_e, projectId: string) => ctx.branches.list(projectId))
  ipcMain.handle('git:switchBranch', async (_e, projectId: string, branch: string) => {
    const p = projectsStore.load().projects.find(x => x.id === projectId)
    if (!p) throw new Error('项目不存在')
    // v3：不自动停止——任一启动/快捷命令运行中即拒绝切换（渲染层已弹提示，这里兜并发竞态）
    const busy = [
      ...p.commands.filter(c => ['running', 'starting'].includes(manager.statusOf(projectId, c.id))),
      ...(p.quickCommands ?? []).filter(q => ['running', 'starting'].includes(manager.statusOf(projectId, q.id)))
    ]
    if (busy.length) {
      throw new Error(`有 ${busy.length} 个命令正在运行，请先手动停止后再切换分支`)
    }
    await ctx.branches.switch(projectId, branch)
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

  // 在系统终端（Terminal.app）中打开项目目录：execFile 参数数组传递，路径含空格/中文无需转义
  const execFileAsync = promisify(execFile)
  ipcMain.handle('shell:openTerminal', async (_e, projectId: string) => {
    if (process.platform !== 'darwin') throw new Error('仅支持 macOS')
    const p = projectsStore.load().projects.find(x => x.id === projectId)
    if (!p) throw new Error('项目不存在')
    if (!existsSync(p.path)) throw new Error(`项目路径不存在：${p.path}`)
    await execFileAsync('open', ['-a', 'Terminal', p.path])
  })

  // 编程应用（spec 2026-09-04-open-in-ide）：open -a "应用名" <项目路径>，
  // VS Code/Cursor/WebStorm/IDEA 等对文件夹参数一律支持
  ipcMain.handle('shell:openIde', async (_e, projectId: string) => {
    if (process.platform !== 'darwin') throw new Error('仅支持 macOS')
    const p = projectsStore.load().projects.find(x => x.id === projectId)
    if (!p) throw new Error('项目不存在')
    if (!p.ideApp) throw new Error('该项目未配置编程应用')
    if (!existsSync(p.path)) throw new Error(`项目路径不存在：${p.path}`)
    await execFileAsync('open', ['-a', p.ideApp, p.path])
  })

  // 常见编程应用中已安装的（扫描 /Applications 与 ~/Applications 的 .app 名）
  const IDE_CANDIDATES = [
    'Visual Studio Code', 'Cursor', 'Trae', 'WebStorm', 'IntelliJ IDEA', 'IntelliJ IDEA CE',
    'PyCharm', 'GoLand', 'PhpStorm', 'RubyMine', 'Xcode', 'Sublime Text', 'Zed'
  ]
  ipcMain.handle('system:listIdeApps', (): string[] => {
    const dirs = ['/Applications', join(homedir(), 'Applications')]
    const installed = new Set(
      dirs.flatMap(d => { try { return readdirSync(d) } catch { return [] } })
    )
    return IDE_CANDIDATES.filter(name => installed.has(`${name}.app`))
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

  // 自动更新（spec 2026-09-04 §7）：状态推送 + 手动操作
  ctx.updater.onState(s => ctx.getWin()?.webContents.send('update:state', s))
  ipcMain.handle('update:getState', (): UpdateState => ctx.updater.getState())
  ipcMain.handle('update:check', () => ctx.updater.check())
  ipcMain.handle('update:download', () => ctx.updater.download())
  ipcMain.handle('update:install', async () => {
    // hardening 2a（review 修正 #4）：与普通退出共用网关——确认对话先于脚本
    // spawn，busy 期间两套流程互斥；取消/失败路径由网关撤销排空
    const ok = await ctx.quit.requestUpdate()
    if (ok !== 'proceed') return
    ctx.updater.install() // 成功则内部经网关 confirmed 标记退出
    // 应用未随之退出（如更新会话创建失败）：撤销排空，回到可用状态
    if (ctx.quit.getStage() !== 'confirmed') ctx.quit.release()
  })
}

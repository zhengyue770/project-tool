import { app, BrowserWindow, dialog } from 'electron'
import { join } from 'node:path'
import { existsSync, rmSync } from 'node:fs'
import { StoragePaths } from './store/storagePaths'
import { ProjectsStore } from './store/projectsStore'
import { SettingsStore } from './store/settingsStore'
import { RuntimeStore } from './store/runtimeStore'
import { ProcessManager } from './process/manager'
import { registerIpc } from './ipc'
import { augmentPathFromLoginShell } from './env'
import { AppUpdater } from './updater/updater'
import { resolveAppBundle } from './updater/installer'
import { GitBranchService } from './git/branch'

// spec §4.1：固定默认数据目录为 .../project-tool（Electron 默认会优先取 productName「项目启动器」）
app.setPath('userData', join(app.getPath('appData'), 'project-tool'))

// v1.1f：GUI 启动的打包应用不继承终端环境，PATH 缺用户目录（npm/nvm 不可见），
// 任何 spawn 之前先从登录 shell 合并用户 PATH；dev 模式重复合并无害
augmentPathFromLoginShell()

let win: BrowserWindow | null = null

function createWindow(): void {
  win = new BrowserWindow({
    width: 1100,
    height: 760,
    title: '项目启动器',
    webPreferences: { preload: join(__dirname, '../preload/index.js') }
  })
  win.on('closed', () => { win = null })
  if (process.env['ELECTRON_RENDERER_URL']) win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  else win.loadFile(join(__dirname, '../renderer/index.html'))
}

app.whenReady().then(async () => {
  createWindow()

  const paths = new StoragePaths(app.getPath('userData'))
  const settingsStore = new SettingsStore(() => paths.getDataDir())
  const projectsStore = new ProjectsStore(() => paths.getDataDir())
  const runtimeStore = new RuntimeStore(() => paths.getDataDir())

  // spec §4.4：自定义数据目录不可访问（如外接盘未插入）
  const pointed = paths.getDataDir()
  if (pointed !== paths.defaultDir && !existsSync(pointed) && win) {
    try {
      const pick = await dialog.showMessageBox(win, {
        type: 'warning',
        title: '数据目录不可访问',
        message: `配置的数据目录当前不可访问：\n${pointed}`,
        buttons: ['重新选择目录', '暂时用默认目录'],
        defaultId: 0,
        cancelId: 1
      })
      if (pick.response === 0) {
        for (;;) {
          const r = await dialog.showOpenDialog(win, {
            properties: ['openDirectory'],
            title: '选择包含 projects.json 的数据目录'
          })
          if (r.canceled || !r.filePaths[0]) { paths.setSessionDir(paths.defaultDir); break }
          const dir = r.filePaths[0]
          if (existsSync(join(dir, 'projects.json'))) { paths.setDataDir(dir); break }
          await dialog.showMessageBox(win, {
            type: 'error',
            message: '所选目录中没有项目数据（缺少 projects.json），请重选'
          })
        }
      } else {
        paths.setSessionDir(paths.defaultDir) // 本次会话用默认目录，指针不动，之后可再切回
      }
    } catch {
      // 窗口中途被销毁等异常：本次会话退回默认目录，保证后续装配继续
      paths.setSessionDir(paths.defaultDir)
    }
  }

  // spec §8：projects.json 损坏时界面提示（仅启动时检查一次，本会话后续 projects:list 不再弹）
  let projectsCorrupted = false
  const projectsFile = projectsStore.load(() => { projectsCorrupted = true })
  if (projectsCorrupted) {
    dialog.showErrorBox(
      '配置文件已损坏',
      'projects.json 无法解析，已备份为 projects.json.bak 并重建了空配置。原数据在备份文件中，可手动恢复。'
    )
  }

  const manager = new ProcessManager({
    startupTimeoutMs: () => settingsStore.load().startupTimeoutMs,
    onRuntimeChange: rf => runtimeStore.save(rf),
    // v1.1a: 子进程日志落 <userData>/logs（文件 stdio——管道会在应用退出时让子进程 EPIPE 崩溃）
    logDir: () => join(app.getPath('userData'), 'logs')
  })
  await manager.restore(projectsFile.projects, runtimeStore.load())

  // 自动更新（spec 2026-09-04）：清空上次缓存（zip/解压产物/替换脚本）；
  // appName 须与 electron-builder.yml 的 productName 一致（zip 内 .app 的名字）
  const updateCacheDir = join(app.getPath('userData'), 'update-cache')
  rmSync(updateCacheDir, { recursive: true, force: true })
  const updater = new AppUpdater({
    repo: 'zhengyue770/project-tool',
    appName: '项目启动器',
    currentVersion: app.getVersion(),
    isPackaged: app.isPackaged,
    platform: process.platform,
    arch: process.arch,
    appBundlePath: resolveAppBundle(app.getAppPath(), app.isPackaged),
    cacheDir: updateCacheDir,
    quitApp: () => app.quit()
  })
  if (app.isPackaged) {
    // 启动 8s 后首次检查（不抢启动性能），此后每 6h 复查
    setTimeout(() => void updater.check(), 8000)
    setInterval(() => void updater.check(), 6 * 60 * 60 * 1000)
  }

  // git 分支（spec 2026-09-04-git-branch）：启动后台预热各项目当前分支，完成后逐项目推送刷新
  const branches = new GitBranchService(() => projectsStore.load().projects)
  void branches.refreshAll()

  registerIpc({ getWin: () => win, paths, projectsStore, settingsStore, runtimeStore, manager, updater, branches })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow()
})
// 注意：退出应用不杀项目进程（detached 存活），下次启动由 restore 恢复状态（spec §5.4）

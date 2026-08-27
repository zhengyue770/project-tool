import { app, BrowserWindow, dialog } from 'electron'
import { join } from 'node:path'
import { existsSync } from 'node:fs'
import { StoragePaths } from './store/storagePaths'
import { ProjectsStore } from './store/projectsStore'
import { SettingsStore } from './store/settingsStore'
import { RuntimeStore } from './store/runtimeStore'
import { ProcessManager } from './process/manager'
import { registerIpc } from './ipc'

// spec §4.1：固定默认数据目录为 .../project-tool（Electron 默认会优先取 productName「项目启动器」）
app.setPath('userData', join(app.getPath('appData'), 'project-tool'))

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

  const manager = new ProcessManager({
    startupTimeoutMs: () => settingsStore.load().startupTimeoutMs,
    onRuntimeChange: rf => runtimeStore.save(rf)
  })
  await manager.restore(projectsStore.load().projects, runtimeStore.load())

  registerIpc({ getWin: () => win, paths, projectsStore, settingsStore, runtimeStore, manager })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow()
})
// 注意：退出应用不杀项目进程（detached 存活），下次启动由 restore 恢复状态（spec §5.4）

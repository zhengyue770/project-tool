import { app, BrowserWindow, dialog, safeStorage } from 'electron'
import { join } from 'node:path'
import { existsSync, readdirSync, renameSync, rmSync } from 'node:fs'
import { StoragePaths } from './store/storagePaths'
import { ProjectsStore } from './store/projectsStore'
import { SettingsStore } from './store/settingsStore'
import { RuntimeStore } from './store/runtimeStore'
import { ProcessManager } from './process/manager'
import { registerIpc } from './ipc'
import { augmentPathFromLoginShell } from './env'
import { AppUpdater } from './updater/updater'
import { resolveAppBundle } from './updater/installer'
import { cleanupUpdateSessions } from './updater/session'
import { GitBranchService } from './git/branch'
import { QuitGateway } from './quitGateway'
import { migratePlaintextAccounts, selfTest, type SafeCrypto } from './store/passwordCrypto'

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

  // 密码加密（hardening 批次四）：safeStorage 自检取证 + 明文迁移（全有或全无）
  const crypto: SafeCrypto = {
    isEncryptionAvailable: () => safeStorage.isEncryptionAvailable(),
    encryptString: s => safeStorage.encryptString(s),
    decryptString: b => safeStorage.decryptString(b)
  }
  const st = selfTest(crypto)
  console.log(`[safeStorage] available=${st.available} roundtrip=${st.roundtrip}（ad-hoc 实测取证：升级后旧密文能否解开以此日志对照）`)
  if (st.available && st.roundtrip) {
    const mig = migratePlaintextAccounts(crypto, projectsFile.projects)
    if (mig.ok && mig.changed) {
      try {
        projectsStore.save({ version: 1, projects: mig.projects! })
        console.log(`[safeStorage] 已将 ${mig.encrypted} 个明文密码迁移为密文（迁移前已逐项解密核对）`)
      } catch (err) {
        // review 修正：迁移落盘失败不得中断初始化——旧明文保留，下次启动重试
        console.warn(`[safeStorage] 明文迁移落盘失败（${(err as Error).message}），已保留原文件，下次启动重试`)
      }
    } else if (!mig.ok) {
      console.warn('[safeStorage] 明文密码迁移校验未通过（加密或解密核对失败），已保留原文件，下次启动重试')
    }
  } else {
    console.warn('[safeStorage] 自检未通过（不可用或往返失败），跳过明文迁移，已保留原文件')
  }

  // 自动更新（spec 2026-09-04）：清空上次缓存（zip/解压产物/替换脚本）；
  // appName 须与 electron-builder.yml 的 productName 一致（zip 内 .app 的名字）
  const updateCacheDir = join(app.getPath('userData'), 'update-cache')
  // beta.2 实测暴露：残留解压树可能让 rmSync 抛错（ENOTDIR）并中断整个 whenReady
  // （IPC 未注册、界面全坏）——清缓存绝不能杀启动：失败改名隔离，下载器按需重建
  const wipeQuarantines = (): void => {
    try {
      for (const name of readdirSync(app.getPath('userData'))) {
        if (name.startsWith('update-cache.quarantine-')) {
          rmSync(join(app.getPath('userData'), name), { recursive: true, force: true })
        }
      }
    } catch { /* 尽力清理旧隔离目录，失败留待下次 */ }
  }
  try {
    rmSync(updateCacheDir, { recursive: true, force: true })
    wipeQuarantines()
  } catch (err) {
    console.warn(`[updater] 清空更新缓存失败（${(err as Error).message}），改名隔离后继续启动`)
    try {
      renameSync(updateCacheDir, `${updateCacheDir}.quarantine-${Date.now()}`)
    } catch (err2) {
      console.warn(`[updater] 缓存隔离也失败（${(err2 as Error).message}），继续启动（下载前会重建目录）`)
    }
  }

  // 退出网关（hardening 2a，review 修正 #3/#4）：普通退出与更新安装共用，
  // 单一阶段状态防并行；取消/失败路径统一撤销排空
  const quit = new QuitGateway({
    manager,
    getWin: () => win,
    // 无窗口（已关窗）时用不绑定父窗口的对话框——菜单退出同样要确认（review 修正 #3）
    showMessageBox: (w, opts) =>
      w ? dialog.showMessageBox(w, opts) : dialog.showMessageBox(opts),
    quit: () => app.quit()
  })
  app.on('before-quit', e => {
    if (!quit.interceptBeforeQuit()) e.preventDefault()
  })

  const updater = new AppUpdater({
    repo: 'zhengyue770/project-tool',
    appName: '项目启动器',
    currentVersion: app.getVersion(),
    isPackaged: app.isPackaged,
    platform: process.platform,
    arch: process.arch,
    appBundlePath: resolveAppBundle(app.getAppPath(), app.isPackaged),
    cacheDir: updateCacheDir,
    userDataDir: app.getPath('userData'),
    // 更新确认在 ipc update:install 内经网关完成（对话先于脚本 spawn），
    // 安装成功后经网关带 confirmed 标记直接退出
    quitApp: () => quit.markConfirmedAndQuit()
  })
  if (app.isPackaged) {
    // 启动 8s 后首次检查（不抢启动性能），此后每 6h 复查
    setTimeout(() => void updater.check(), 8000)
    setInterval(() => void updater.check(), 6 * 60 * 60 * 1000)
  }

  // git 分支（spec 2026-09-04-git-branch）：启动后台预热各项目当前分支，完成后逐项目推送刷新
  const branches = new GitBranchService(() => projectsStore.load().projects)
  void branches.refreshAll()

  registerIpc({ getWin: () => win, paths, projectsStore, settingsStore, runtimeStore, manager, updater, branches, quit })

  // 更新会话清理（hardening 2c）：基本初始化完成后执行——四条件全满足才删备份，
  // 任何不确定保留并告警；失败不阻断启动
  if (app.isPackaged) {
    const bundlePath = resolveAppBundle(app.getAppPath(), app.isPackaged)
    if (bundlePath) {
      const report = cleanupUpdateSessions(app.getPath('userData'), bundlePath, app.getVersion())
      for (const k of report.kept) console.warn(`[更新残留] ${k.dir}：${k.reason}（保留未删，请自行确认）`)
    }
  }
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow()
})
// 注意：退出应用不杀项目进程（detached 存活），下次启动由 restore 恢复状态（spec §5.4）

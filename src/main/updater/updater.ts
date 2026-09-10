import { dirname, join } from 'node:path'
import type { UpdateState } from '../../shared/types'
import { fetchLatestRelease, pickMacZipAsset, type FetchLike, type ReleaseAsset } from './feed'
import { isNewerVersion } from './version'
import { downloadToFile, type ProgressReport } from './downloader'
import { ensureDirWritable, extractAndLocateApp, installAndRelaunch, type InstallPlan } from './installer'
import { openUpdateSession, stagingOf, type UpdateRecord } from './session'

// 自动更新状态机（spec 2026-09-04 §6）：聚合 feed/downloader/installer，
// 网络与副作用全部经构造函数注入（不 import electron），便于单测。

export type DownloadFn = (
  url: string, dest: string,
  expected: { sizeBytes?: number; sha256?: string },
  onProgress: (p: ProgressReport) => void
) => Promise<void>
export type ExtractFn = (zipPath: string, destDir: string, appName: string) => Promise<string>
export type InstallFn = (plan: InstallPlan) => void
export type OpenSessionFn = (
  userDataDir: string, appPath: string, oldVersion: string, newVersion: string
) => { record: UpdateRecord; sessionDir: string } | null
export type WritableCheckFn = (dir: string) => void

export interface UpdaterEnv {
  repo: string
  /** .app 内的应用名（对应 electron-builder.yml 的 productName） */
  appName: string
  currentVersion: string
  isPackaged: boolean
  platform: NodeJS.Platform
  arch: string
  /** 打包后当前 .app bundle 路径；dev 为 null */
  appBundlePath: string | null
  /** 下载/解压缓存目录（应用启动时整体清空） */
  cacheDir: string
  /** userData 目录（更新会话记录所在） */
  userDataDir: string
  fetchImpl?: FetchLike
  download?: DownloadFn
  extract?: ExtractFn
  openSession?: OpenSessionFn
  install?: InstallFn
  ensureWritable?: WritableCheckFn
  getPid?: () => number
  quitApp: () => void
}

const msg = (err: unknown): string => (err instanceof Error ? err.message : String(err))

export class AppUpdater {
  private state: UpdateState
  private readonly listeners = new Set<(s: UpdateState) => void>()
  private asset: ReleaseAsset | null = null
  private extractedApp: string | null = null

  constructor(private readonly env: UpdaterEnv) {
    this.state = { status: 'idle', currentVersion: env.currentVersion }
  }

  getState(): UpdateState {
    return this.state
  }

  onState(cb: (s: UpdateState) => void): () => void {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }

  private setState(patch: Partial<UpdateState>): void {
    this.state = { ...this.state, ...patch }
    for (const l of this.listeners) l(this.state)
  }

  async check(): Promise<UpdateState> {
    if (!this.env.isPackaged) {
      this.setState({ status: 'error', message: '开发模式不支持检查更新' })
      return this.state
    }
    if (this.env.platform !== 'darwin') {
      this.setState({ status: 'error', message: '仅支持 macOS 自动更新' })
      return this.state
    }
    // 下载/安装进行中不打断；已下载暂未安装也跳过（重查只会丢弃已就位的新版）
    if (['downloading', 'installing', 'downloaded'].includes(this.state.status)) return this.state

    this.setState({ status: 'checking', message: undefined })
    try {
      const rel = await fetchLatestRelease(this.env.repo, this.env.fetchImpl)
      const remoteVersion = rel.tagName.replace(/^v/, '')
      if (!isNewerVersion(remoteVersion, this.env.currentVersion)) {
        this.asset = null
        this.setState({ status: 'not-available', remoteVersion: undefined, notes: undefined, message: undefined })
        return this.state
      }
      const asset = pickMacZipAsset(rel.assets, this.env.arch)
      if (!asset) throw new Error('Release 中找不到当前架构的 zip 安装包')
      this.asset = asset
      this.setState({ status: 'available', remoteVersion, notes: rel.notes, message: undefined })
    } catch (err) {
      this.setState({ status: 'error', message: `检查更新失败：${msg(err)}` })
    }
    return this.state
  }

  async download(): Promise<UpdateState> {
    // available 正常入口；error 允许重试（资产已选好）；其余（idle/checking/downloading…）忽略
    if ((this.state.status !== 'available' && this.state.status !== 'error') || !this.asset) return this.state
    if (!this.env.appBundlePath) {
      this.setState({ status: 'error', message: '无法定位当前应用位置，请手动到 Release 页下载' })
      return this.state
    }
    const sha256 = this.asset.digest?.replace(/^sha256:/, '')
    if (!sha256) {
      this.setState({ status: 'error', message: 'GitHub 未提供安装包摘要（sha256），已拒绝安装' })
      return this.state
    }
    try {
      (this.env.ensureWritable ?? ensureDirWritable)(dirname(this.env.appBundlePath))
    } catch {
      this.setState({ status: 'error', message: '应用所在目录不可写，无法自动更新，请手动下载' })
      return this.state
    }

    const zipPath = join(this.env.cacheDir, this.asset.name)
    this.setState({ status: 'downloading', progress: { receivedBytes: 0, totalBytes: this.asset.size } })
    try {
      const doDownload = this.env.download ?? downloadToFile
      await doDownload(this.asset.url, zipPath, { sizeBytes: this.asset.size, sha256 },
        p => this.setState({ progress: p }))
    } catch (err) {
      this.setState({ status: 'error', message: `下载更新失败：${msg(err)}` })
      return this.state
    }
    try {
      const doExtract = this.env.extract ?? extractAndLocateApp
      this.extractedApp = await doExtract(zipPath, join(this.env.cacheDir, 'extracted'), this.env.appName)
      this.setState({ status: 'downloaded', message: undefined })
    } catch (err) {
      this.setState({ status: 'error', message: `安装包处理失败：${msg(err)}` })
    }
    return this.state
  }

  install(): void {
    // downloaded 正常入口；error 允许重试（新 .app 已解压就位）
    if ((this.state.status !== 'downloaded' && this.state.status !== 'error')
      || !this.extractedApp || !this.env.appBundlePath) return
    if (!this.state.remoteVersion) return
    if (this.env.appBundlePath.startsWith('/Volumes/')) {
      this.setState({ status: 'error', message: '应用正从安装镜像(dmg)运行，请先将其拖入「应用程序」文件夹后重试' })
      return
    }
    this.setState({ status: 'installing' })
    // hardening 2c：先独占创建更新会话（会话目录/备份/暂存容器同 token 绑定），
    // 再 spawn 替换脚本；任何位置已有残留 → 中止，交由启动清理处理
    const session = (this.env.openSession ?? openUpdateSession)(
      this.env.userDataDir, this.env.appBundlePath, this.env.currentVersion, this.state.remoteVersion
    )
    if (!session) {
      this.setState({ status: 'error', message: '更新会话创建失败（可能存在上次更新的残留），请重启应用后重试' })
      return
    }
    try {
      const plan: InstallPlan = {
        appPid: (this.env.getPid ?? (() => process.pid))(),
        bundlePath: this.env.appBundlePath,
        extractedApp: this.extractedApp,
        stagingApp: join(stagingOf(this.env.appBundlePath, session.record.token), 'app'),
        backupPrev: join(session.record.backup, 'prev.app'),
        sessionDir: session.sessionDir
      }
      const doInstall = this.env.install ?? installAndRelaunch
      doInstall(plan)
    } catch (err) {
      this.setState({ status: 'error', message: `启动更新失败：${msg(err)}` })
      return
    }
    this.env.quitApp()
  }
}

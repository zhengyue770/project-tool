import { describe, it, expect, vi } from 'vitest'
import { AppUpdater, type UpdaterEnv } from './updater'

// 自动更新状态机（spec 2026-09-04 §6）：check/download/install 的守卫与流转。
// 网络、下载、解压、替换脚本均为注入桩——真实链路 macOS 手动走查（spec §10）。

const RELEASE = {
  tag_name: 'v1.3.0',
  name: 'v1.3.0',
  body: '修复若干问题',
  assets: [
    { name: 'project-tool-1.3.0-arm64.zip', browser_download_url: 'https://x/a.zip', size: 100, digest: 'sha256:abc' },
    { name: 'project-tool-1.3.0-x64.zip', browser_download_url: 'https://x/x.zip', size: 100, digest: 'sha256:def' }
  ]
}

function makeEnv(over: Partial<UpdaterEnv> = {}): UpdaterEnv {
  return {
    repo: 'zhengyue770/project-tool',
    appName: '项目启动器',
    currentVersion: '1.2.0',
    isPackaged: true,
    platform: 'darwin',
    arch: 'arm64',
    appBundlePath: '/Applications/项目启动器.app',
    cacheDir: '/tmp/update-cache',
    userDataDir: '/tmp/pt-user',
    openSession: () => ({
      record: {
        token: '0123456789abcdef',
        oldVersion: '1.2.0',
        newVersion: '1.3.0',
        appPath: '/Applications/项目启动器.app',
        backup: '/Applications/项目启动器.app.old.0123456789abcdef'
      },
      sessionDir: '/tmp/pt-user/update-sessions/0123456789abcdef'
    }),
    fetchImpl: async () => new Response(JSON.stringify(RELEASE), { status: 200 }),
    download: vi.fn(async (
      _u: string, _d: string,
      _e: { sizeBytes?: number; sha256?: string },
      onProgress: (p: { receivedBytes: number; totalBytes: number }) => void
    ) => {
      onProgress({ receivedBytes: 50, totalBytes: 100 })
      onProgress({ receivedBytes: 100, totalBytes: 100 })
    }),
    extract: vi.fn(async () => '/tmp/update-cache/extracted/项目启动器.app'),
    install: vi.fn(),
    ensureWritable: vi.fn(),
    getPid: () => 4321,
    quitApp: vi.fn(),
    ...over
  }
}

const okResponse = (j: unknown): Promise<Response> =>
  Promise.resolve(new Response(JSON.stringify(j), { status: 200 }))

describe('AppUpdater.check', () => {
  it('dev 模式 → error 且不发网络请求', async () => {
    const fetchImpl = vi.fn()
    const u = new AppUpdater(makeEnv({ isPackaged: false, fetchImpl: fetchImpl as never }))
    const s = await u.check()
    expect(s.status).toBe('error')
    expect(s.message).toContain('开发模式')
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('非 darwin → error', async () => {
    const u = new AppUpdater(makeEnv({ platform: 'win32' }))
    expect((await u.check()).status).toBe('error')
  })

  it('远端不比本地新 → not-available（清掉旧提示信息）', async () => {
    const u = new AppUpdater(makeEnv({ currentVersion: '1.3.0' }))
    const s = await u.check()
    expect(s.status).toBe('not-available')
    expect(s.message).toBeUndefined()
  })

  it('远端更新 → available，带版本与说明；状态事件依次推送', async () => {
    const seen: string[] = []
    const u = new AppUpdater(makeEnv())
    u.onState(s => seen.push(s.status))
    const s = await u.check()
    expect(s.status).toBe('available')
    expect(s.remoteVersion).toBe('1.3.0')
    expect(s.notes).toBe('修复若干问题')
    expect(seen).toEqual(['checking', 'available'])
  })

  it('Release 里没有当前架构的 zip → error', async () => {
    const empty = { ...RELEASE, assets: [RELEASE.assets[0]] } // 只有 arm64
    const u = new AppUpdater(makeEnv({ arch: 'x64', fetchImpl: () => okResponse(empty) }))
    const s = await u.check()
    expect(s.status).toBe('error')
    expect(s.message).toContain('架构')
  })

  it('网络失败 → error（前缀「检查更新失败」），状态机可再次 check', async () => {
    const u = new AppUpdater(makeEnv({ fetchImpl: async () => { throw new Error('boom') } }))
    expect((await u.check()).message).toContain('检查更新失败')
    const u2 = new AppUpdater(makeEnv())
    expect((await u2.check()).status).toBe('available')
  })

  it('已 downloaded 暂未安装 → 定时复查不打扰（状态保持 downloaded）', async () => {
    const fetchImpl = vi.fn(() => okResponse(RELEASE))
    const u = new AppUpdater(makeEnv({ fetchImpl }))
    await u.check()
    await u.download()
    expect((await u.check()).status).toBe('downloaded')
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })
})

describe('AppUpdater.download', () => {
  it('available → downloading(进度推送) → downloaded；下载参数带去掉前缀的 sha256 与尺寸', async () => {
    const env = makeEnv()
    const u = new AppUpdater(env)
    await u.check()
    const events: number[] = []
    u.onState(s => { if (s.progress) events.push(s.progress.receivedBytes) })
    const s = await u.download()
    expect(s.status).toBe('downloaded')
    expect(env.download).toHaveBeenCalledWith(
      'https://x/a.zip',
      '/tmp/update-cache/project-tool-1.3.0-arm64.zip',
      { sizeBytes: 100, sha256: 'abc' },
      expect.any(Function)
    )
    expect(env.extract).toHaveBeenCalled()
    expect(events.at(-1)).toBe(100)
  })

  it('非 available 状态调用 → 忽略（状态不变）', async () => {
    const env = makeEnv()
    const u = new AppUpdater(env)
    await u.download()
    expect(env.download).not.toHaveBeenCalled()
    expect(u.getState().status).toBe('idle')
  })

  it('资产无 digest → 拒绝下载', async () => {
    const noDigest = { ...RELEASE, assets: [{ ...RELEASE.assets[0], digest: null }] }
    const env = makeEnv({ fetchImpl: () => okResponse(noDigest) })
    const u = new AppUpdater(env)
    await u.check()
    const s = await u.download()
    expect(s.status).toBe('error')
    expect(s.message).toContain('摘要')
    expect(env.download).not.toHaveBeenCalled()
  })

  it('下载失败 → error（前缀「下载更新失败」），重试可再次下载', async () => {
    let fail = true
    const env = makeEnv({
      download: vi.fn(async () => {
        if (fail) throw new Error('网络中断')
      })
    })
    const u = new AppUpdater(env)
    await u.check()
    const s = await u.download()
    expect(s.status).toBe('error')
    expect(s.message).toContain('下载更新失败')
    fail = false
    const s2 = await u.download() // 从 error 重试
    expect(s2.status).toBe('downloaded')
    expect(env.download).toHaveBeenCalledTimes(2)
  })

  it('解压/定位 .app 失败 → error（前缀「安装包处理失败」）', async () => {
    const env = makeEnv({ extract: vi.fn(async () => { throw new Error('未找到 .app') }) })
    const u = new AppUpdater(env)
    await u.check()
    const s = await u.download()
    expect(s.status).toBe('error')
    expect(s.message).toContain('安装包处理失败')
  })

  it('应用所在目录不可写 → 提前失败，不开始下载', async () => {
    const env = makeEnv({ ensureWritable: vi.fn(() => { throw new Error('EACCES') }) })
    const u = new AppUpdater(env)
    await u.check()
    const s = await u.download()
    expect(s.status).toBe('error')
    expect(s.message).toContain('不可写')
    expect(env.download).not.toHaveBeenCalled()
  })

  it('dev（无 bundle 路径）→ error', async () => {
    const env = makeEnv({ appBundlePath: null })
    const u = new AppUpdater(env)
    // 直接构造 available 态：先正常 check，再把 bundle 置空模拟
    await u.check()
    const s = await u.download()
    expect(s.status).toBe('error')
  })
})

describe('AppUpdater.install', () => {
  async function ready(env = makeEnv()): Promise<AppUpdater> {
    const u = new AppUpdater(env)
    await u.check()
    await u.download()
    return u
  }

  it('downloaded → installing → 建立更新会话并按计划 spawn 替换脚本、退出应用', async () => {
    const env = makeEnv()
    const u = new AppUpdater(env)
    await u.check()
    await u.download()
    u.install()
    expect(u.getState().status).toBe('installing')
    expect(env.install).toHaveBeenCalledWith({
      appPid: 4321,
      bundlePath: '/Applications/项目启动器.app',
      extractedApp: '/tmp/update-cache/extracted/项目启动器.app',
      stagingApp: '/Applications/项目启动器.app.new.0123456789abcdef/app',
      backupPrev: '/Applications/项目启动器.app.old.0123456789abcdef/prev.app',
      sessionDir: '/tmp/pt-user/update-sessions/0123456789abcdef'
    })
    expect(env.quitApp).toHaveBeenCalled()
  })

  it('hardening 2c：更新会话创建失败（残留）→ error 且不 spawn、不退出', async () => {
    const env = makeEnv({ openSession: () => null })
    const u = new AppUpdater(env)
    await u.check()
    await u.download()
    u.install()
    expect(u.getState().status).toBe('error')
    expect(u.getState().message).toContain('会话')
    expect(env.install).not.toHaveBeenCalled()
    expect(env.quitApp).not.toHaveBeenCalled()
  })

  it('应用在 dmg（/Volumes）中运行 → error 且不替换', async () => {
    const env = makeEnv({ appBundlePath: '/Volumes/项目启动器/项目启动器.app' })
    const u = await ready(env)
    u.install()
    expect(u.getState().status).toBe('error')
    expect(u.getState().message).toContain('安装镜像')
    expect(env.install).not.toHaveBeenCalled()
    expect(env.quitApp).not.toHaveBeenCalled()
  })

  it('替换脚本 spawn 失败 → error 且不退出应用；重试可再次安装', async () => {
    let fail = true
    const env = makeEnv({ install: vi.fn(() => { if (fail) throw new Error('spawn fail') }) })
    const u = await ready(env)
    u.install()
    expect(u.getState().status).toBe('error')
    expect(u.getState().message).toContain('启动更新失败')
    expect(env.quitApp).not.toHaveBeenCalled()
    fail = false
    u.install() // 从 error 重试
    expect(u.getState().status).toBe('installing')
    expect(env.quitApp).toHaveBeenCalled()
  })

  it('未 downloaded 时调用 → 忽略', async () => {
    const env = makeEnv()
    const u = new AppUpdater(env)
    u.install()
    expect(env.install).not.toHaveBeenCalled()
    expect(env.quitApp).not.toHaveBeenCalled()
  })
})

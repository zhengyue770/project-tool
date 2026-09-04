import { describe, it, expect } from 'vitest'
import { fetchLatestRelease, pickMacZipAsset } from './feed'

// 自动更新（spec 2026-09-04 §4）：更新源为 GitHub /releases/latest（公开仓库免鉴权，
// 天然排除 draft/prerelease）。资产按「-{arch}.zip」后缀选择；digest 形如 sha256:<hex>，
// 由更新器在下载前强制校验（缺失即拒绝安装），这里只负责解析与挑选。

const REAL_ASSETS = [
  { name: 'project-tool-1.2.0-arm64.dmg', browser_download_url: 'https://x/arm64.dmg', size: 1, digest: 'sha256:aaa' },
  { name: 'project-tool-1.2.0-arm64.zip', browser_download_url: 'https://x/arm64.zip', size: 2, digest: 'sha256:bbb' },
  { name: 'project-tool-1.2.0-x64.dmg', browser_download_url: 'https://x/x64.dmg', size: 3, digest: 'sha256:ccc' },
  { name: 'project-tool-1.2.0-x64.zip', browser_download_url: 'https://x/x64.zip', size: 4, digest: 'sha256:ddd' }
]

describe('fetchLatestRelease', () => {
  it('映射 GitHub API 字段（tag_name/body/assets 含 digest）', async () => {
    const apiJson = {
      tag_name: 'v1.3.0',
      name: 'v1.3.0 更新说明',
      body: '\n### 新功能\n- 自动更新\n',
      assets: REAL_ASSETS
    }
    const rel = await fetchLatestRelease('zhengyue770/project-tool', async () =>
      new Response(JSON.stringify(apiJson), { status: 200 })
    )
    expect(rel.tagName).toBe('v1.3.0')
    expect(rel.name).toBe('v1.3.0 更新说明')
    expect(rel.notes).toBe('### 新功能\n- 自动更新')
    expect(rel.assets).toHaveLength(4)
    expect(rel.assets[1]).toEqual({
      name: 'project-tool-1.2.0-arm64.zip', url: 'https://x/arm64.zip', size: 2, digest: 'sha256:bbb'
    })
  })

  it('字段缺失时兜底（name 用 tag、body 空、digest null）', async () => {
    const rel = await fetchLatestRelease('a/b', async () =>
      new Response(JSON.stringify({ tag_name: 'v2.0.0', assets: [{ name: 'z.zip', browser_download_url: 'u', size: 9 }] }), { status: 200 })
    )
    expect(rel.name).toBe('v2.0.0')
    expect(rel.notes).toBe('')
    expect(rel.assets[0]?.digest).toBeNull()
  })

  it('非 200 → 抛错（含状态码）', async () => {
    await expect(fetchLatestRelease('a/b', async () => new Response('rate limited', { status: 403 })))
      .rejects.toThrow('403')
  })

  it('请求头带 User-Agent 与 Accept', async () => {
    let headers: Headers | null = null
    await fetchLatestRelease('a/b', async (_url, init) => {
      headers = new Headers(init?.headers)
      return new Response(JSON.stringify({ tag_name: 'v1.0.0', assets: [] }), { status: 200 })
    })
    expect(headers!.get('user-agent')).toBeTruthy()
    expect(headers!.get('accept')).toContain('application/vnd.github')
  })
})

describe('pickMacZipAsset', () => {
  it('arm64 → 选 arm64 zip', () => {
    const a = pickMacZipAsset(REAL_ASSETS as never, 'arm64')
    expect(a?.name).toBe('project-tool-1.2.0-arm64.zip')
  })

  it('x64 → 选 x64 zip', () => {
    const a = pickMacZipAsset(REAL_ASSETS as never, 'x64')
    expect(a?.name).toBe('project-tool-1.2.0-x64.zip')
  })

  it('无匹配架构的 zip → null', () => {
    expect(pickMacZipAsset(REAL_ASSETS.slice(0, 2) as never, 'x64')).toBeNull()
    expect(pickMacZipAsset([], 'arm64')).toBeNull()
  })

  it('按后缀匹配，不依赖文件名前缀', () => {
    const assets = [{ name: 'anything-1.0.0-arm64.zip', browser_download_url: 'u', size: 1, digest: null }]
    expect(pickMacZipAsset(assets as never, 'arm64')?.name).toBe('anything-1.0.0-arm64.zip')
  })
})

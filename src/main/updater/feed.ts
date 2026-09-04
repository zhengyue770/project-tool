// 自动更新（spec 2026-09-04 §4）：更新源为 GitHub /releases/latest（公开仓库免鉴权，
// 天然排除 draft/prerelease）。资产按「-{arch}.zip」后缀选择；digest 形如 sha256:<hex>，
// 由更新器在下载前强制校验（缺失即拒绝安装），这里只负责解析与挑选。

export interface ReleaseAsset {
  name: string
  url: string
  size: number
  digest: string | null
}
export interface ReleaseInfo {
  tagName: string
  name: string
  notes: string
  assets: ReleaseAsset[]
}

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>

const API_BASE = 'https://api.github.com/repos'

export async function fetchLatestRelease(repo: string, fetchImpl: FetchLike = fetch): Promise<ReleaseInfo> {
  const res = await fetchImpl(`${API_BASE}/${repo}/releases/latest`, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'project-tool-updater' },
    signal: AbortSignal.timeout(10_000)
  })
  if (!res.ok) throw new Error(`GitHub API ${res.status}`)
  const j = (await res.json()) as {
    tag_name: string; name?: string; body?: string
    assets?: { name: string; browser_download_url: string; size: number; digest?: string }[]
  }
  return {
    tagName: j.tag_name,
    name: j.name || j.tag_name,
    notes: (j.body || '').trim(),
    assets: (j.assets || []).map(a => ({
      name: a.name, url: a.browser_download_url, size: a.size, digest: a.digest ?? null
    }))
  }
}

export function pickMacZipAsset(assets: ReleaseAsset[], arch: string): ReleaseAsset | null {
  const re = new RegExp(`-${arch}\\.zip$`)
  return assets.find(a => re.test(a.name)) ?? null
}

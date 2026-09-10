import { createHash } from 'node:crypto'
import { createWriteStream, mkdirSync, rmSync } from 'node:fs'
import { once } from 'node:events'
import { dirname } from 'node:path'

// 自动更新（spec 2026-09-04 §5）：流式下载到文件，边写边算 sha256 与进度
// （节流 200ms）；大小/摘要不符或网络失败时删除残留文件后抛错。
// P0 修复：update-cache 每次启动被清空，这里必须自建父目录；写流错误
// （目录被删/磁盘满/目标是目录）必须转为拒绝——无监听的流 error 事件会
// 直接抛未捕获异常打崩主进程，try/catch 接不住。

export interface DownloadExpected { sizeBytes?: number; sha256?: string }
export type ProgressReport = { receivedBytes: number; totalBytes: number }

// 110MB 级全量包，慢网络放宽到 30 分钟
const DOWNLOAD_TIMEOUT_MS = 30 * 60 * 1000
const PROGRESS_INTERVAL_MS = 200

export async function downloadToFile(
  url: string,
  destPath: string,
  expected: DownloadExpected,
  onProgress: (p: ProgressReport) => void
): Promise<void> {
  const res = await fetch(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) })
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`)
  const total = Number(res.headers.get('content-length')) || expected.sizeBytes || 0

  mkdirSync(dirname(destPath), { recursive: true })
  const out = createWriteStream(destPath)
  // 写流失败信号：drain/finish 等待处用 race 感知，否则错误后永远等不到 drain
  const failed = new Promise<never>((_, reject) => { out.on('error', reject) })
  failed.catch(() => undefined) // 兜底：未被 race 到的拒绝不升级为 unhandledRejection
  const cleanup = (): void => {
    out.destroy()
    try { rmSync(destPath, { force: true }) } catch { /* 残留由下次启动清空 update-cache 兜底 */ }
  }

  const hash = createHash('sha256')
  let received = 0
  let lastEmit = 0
  try {
    for await (const chunk of res.body as unknown as AsyncIterable<Buffer>) {
      hash.update(chunk)
      received += chunk.length
      if (!out.write(chunk)) await Promise.race([once(out, 'drain'), failed])
      const now = Date.now()
      if (now - lastEmit >= PROGRESS_INTERVAL_MS) {
        lastEmit = now
        onProgress({ receivedBytes: received, totalBytes: total })
      }
    }
    out.end()
    await Promise.race([once(out, 'finish'), failed])
    onProgress({ receivedBytes: received, totalBytes: total || received })

    if (expected.sizeBytes && received !== expected.sizeBytes) {
      throw new Error(`下载不完整（${received}/${expected.sizeBytes} 字节）`)
    }
    if (expected.sha256 && hash.digest('hex') !== expected.sha256) {
      throw new Error('sha256 校验失败，安装包可能被篡改或损坏')
    }
  } catch (err) {
    cleanup()
    throw err
  }
}

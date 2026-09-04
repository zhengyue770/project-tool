import { describe, it, expect, afterEach } from 'vitest'
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http'
import { type AddressInfo } from 'node:net'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { createHash } from 'node:crypto'
import { downloadToFile } from './downloader'

// P0 修复回归：update-cache 每次启动被清空，downloadToFile 必须自建父目录；
// 写流错误（目录被删/磁盘满/目标是目录）必须转为拒绝而非未捕获的 error 事件。
// 用本地 http 服务模拟真实下载（fetch 需 http(s) URL）。

const BODY = randomBytes(300 * 1024)
const BODY_SHA = createHash('sha256').update(BODY).digest('hex')

const servers: Server[] = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map(
    s => new Promise<void>(r => s.close(() => r()))
  ))
})

async function serve(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<string> {
  const s = createServer(handler)
  servers.push(s)
  await new Promise<void>(r => s.listen(0, '127.0.0.1', r))
  return `http://127.0.0.1:${(s.address() as AddressInfo).port}/project-tool-1.3.0.zip`
}

const okHandler = (_req: IncomingMessage, res: ServerResponse): void => {
  res.writeHead(200, { 'content-length': String(BODY.length) })
  res.end(BODY)
}

function tmpDir(): string { return mkdtempSync(join(tmpdir(), 'pt-dl-')) }

describe('downloadToFile', () => {
  it('父目录不存在 → 自动创建并完整下载，sha256 与进度回调正确', async () => {
    const url = await serve(okHandler)
    const dest = join(tmpDir(), 'update-cache', 'sub', 'project-tool-1.3.0.zip')
    expect(existsSync(dirname(dest))).toBe(false) // 复现 P0：目录不存在
    const progress: number[] = []
    await downloadToFile(url, dest, { sizeBytes: BODY.length, sha256: BODY_SHA },
      p => progress.push(p.receivedBytes))
    expect(existsSync(dest)).toBe(true)
    expect(statSync(dest).size).toBe(BODY.length)
    expect(createHash('sha256').update(readFileSync(dest)).digest('hex')).toBe(BODY_SHA)
    expect(progress.at(-1)).toBe(BODY.length)
  })

  it('HTTP 失败 → 拒绝且不留残留文件', async () => {
    const url = await serve((_q, res) => { res.writeHead(500); res.end('boom') })
    const dir = tmpDir()
    const dest = join(dir, 'x.zip')
    await expect(downloadToFile(url, dest, {}, () => undefined)).rejects.toThrow('500')
    expect(existsSync(dest)).toBe(false)
  })

  it('sha256 不符 → 拒绝并删除文件', async () => {
    const url = await serve(okHandler)
    const dest = join(tmpDir(), 'x.zip')
    await expect(
      downloadToFile(url, dest, { sha256: 'deadbeef' }, () => undefined)
    ).rejects.toThrow('sha256')
    expect(existsSync(dest)).toBe(false)
  })

  it('写流打开失败（目标是目录）→ 转为拒绝，不产生未捕获异常', async () => {
    const url = await serve(okHandler)
    const dest = tmpDir() // destPath 本身是目录 → createWriteStream 异步 error
    mkdirSync(dest, { recursive: true })
    await expect(downloadToFile(url, dest, {}, () => undefined)).rejects.toThrow()
    rmSync(dest, { recursive: true, force: true }) // 清理兜底失败也不会误删目录内容，手动复位
  })
})

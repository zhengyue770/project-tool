import { existsSync, readFileSync, renameSync, unlinkSync } from 'node:fs'
import { closeSync, openSync, writeSync } from 'node:fs'
import { randomUUID } from 'node:crypto'

/** 读取 JSON；损坏时备份为 .bak 并返回 fallback */
export function readJson<T>(file: string, fallback: T, onCorrupt?: (bak: string) => void): T {
  if (!existsSync(file)) return fallback
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as T
  } catch {
    const bak = file + '.bak'
    try { renameSync(file, bak); onCorrupt?.(bak) } catch { /* 备份失败也继续用 fallback */ }
    return fallback
  }
}

const defaultTmpPath = (file: string): string => `${file}.tmp-${randomUUID().slice(0, 8)}`

/** 写入原语（可注入，仅供测试模拟短写）：返回本次实际写入字节数 */
export type WriteChunk = (fd: number, buf: Buffer, offset: number, length: number) => number
const writeChunk: WriteChunk = (fd, buf, offset, length) => writeSync(fd, buf, offset, length)

/** 原子写：同目录独占创建随机临时文件，**完整写入**后 rename 替换（hardening 1c）。
 *  - open('wx') 成功才拥有该文件（记所有权）——EEXIST 撞名时临时文件属于别人，绝不清理
 *  - 完整写入循环：write(2) 对普通文件也可能短写且不抛错（错误延迟到下次调用），
 *    不检查返回值就 rename 会把残缺 JSON 盖到原文件上（review 修正）
 *  - makeTmpPath / writeChunkFn 仅供测试注入 */
export function writeJsonAtomic(
  file: string,
  data: unknown,
  makeTmpPath: (file: string) => string = defaultTmpPath,
  writeChunkFn: WriteChunk = writeChunk
): void {
  const tmp = makeTmpPath(file)
  const payload = Buffer.from(JSON.stringify(data, null, 2), 'utf8')
  let fd: number | undefined
  let owned = false
  try {
    fd = openSync(tmp, 'wx')
    owned = true
    let offset = 0
    while (offset < payload.length) {
      const n = writeChunkFn(fd, payload, offset, payload.length - offset)
      if (!(n > 0)) throw new Error('write 返回非正数，写入未推进')
      offset += n
    }
    closeSync(fd)
    fd = undefined
    renameSync(tmp, file)
  } catch (err) {
    if (fd !== undefined) {
      try { closeSync(fd) } catch { /* 写失败后 fd 状态未知，尽力关闭 */ }
    }
    if (owned) {
      try { unlinkSync(tmp) } catch { /* 自己的临时文件删不掉，留随机名残留无害 */ }
    }
    throw err
  }
}

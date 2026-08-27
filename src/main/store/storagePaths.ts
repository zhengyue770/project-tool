import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const POINTER_FILE = 'storage-pointer.json'

/** 指针文件永远在默认 userData 目录，决定其余数据文件从哪读 */
export class StoragePaths {
  private sessionDir: string | null = null
  constructor(readonly defaultDir: string) {}

  get pointerFile(): string { return join(this.defaultDir, POINTER_FILE) }

  getDataDir(): string {
    if (this.sessionDir) return this.sessionDir
    try {
      const raw = JSON.parse(readFileSync(this.pointerFile, 'utf8')) as { dataDir?: unknown }
      if (typeof raw.dataDir === 'string' && raw.dataDir) return raw.dataDir
    } catch {
      // 无指针或损坏 → 用默认目录
    }
    return this.defaultDir
  }

  /** 正式切换数据目录（写指针）。迁移流程校验通过后调用 */
  setDataDir(dir: string): void {
    mkdirSync(this.defaultDir, { recursive: true })
    writeFileSync(this.pointerFile, JSON.stringify({ dataDir: dir }, null, 2))
    this.sessionDir = null
  }

  /** 本次会话临时用某目录（自定义目录不可访问时的"暂用默认"），不改指针 */
  setSessionDir(dir: string | null): void { this.sessionDir = dir }

  isDefault(dir: string): boolean { return dir === this.defaultDir }
}

import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'

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

/** 原子写：先写 .tmp 再 rename，避免写一半损坏 */
export function writeJsonAtomic(file: string, data: unknown): void {
  const tmp = file + '.tmp'
  writeFileSync(tmp, JSON.stringify(data, null, 2))
  renameSync(tmp, file)
}

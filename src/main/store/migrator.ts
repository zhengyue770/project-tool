import { copyFileSync, existsSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { MigrationResult } from '../../shared/types'
import type { StoragePaths } from './storagePaths'

export const DATA_FILES = ['projects.json', 'settings.json', 'runtime.json'] as const

function canWrite(dir: string): boolean {
  const probe = join(dir, '.pt-write-probe')
  try {
    writeFileSync(probe, 'ok')
    unlinkSync(probe)
    return true
  } catch {
    return false
  }
}

/** 迁移数据目录：校验 → 复制 → 校验 → 切指针。任何一步失败都保持原目录可用 */
export function migrateDataDir(paths: StoragePaths, nextDir: string): MigrationResult {
  const cur = paths.getDataDir()
  if (!existsSync(nextDir)) return { ok: false, error: '目标目录不存在' }
  if (!canWrite(nextDir)) return { ok: false, error: '目标目录不可写' }
  if (existsSync(join(nextDir, 'projects.json')))
    return { ok: false, error: '目标目录已有项目数据，为避免覆盖请更换目录' }
  try {
    for (const name of DATA_FILES) {
      const from = join(cur, name)
      if (!existsSync(from)) continue
      const to = join(nextDir, name)
      copyFileSync(from, to)
      if (statSync(from).size !== statSync(to).size) throw new Error(`文件校验不一致: ${name}`)
    }
  } catch (e) {
    return { ok: false, error: `迁移失败：${(e as Error).message}，已保持原目录` }
  }
  paths.setDataDir(nextDir)
  return { ok: true, to: nextDir }
}

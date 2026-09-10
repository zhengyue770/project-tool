import { constants, copyFileSync, existsSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import type { MigrationResult } from '../../shared/types'
import type { StoragePaths } from './storagePaths'

export const DATA_FILES = ['projects.json', 'settings.json', 'runtime.json'] as const

/** 写权限探测（hardening 1b）：随机后缀 + wx 独占创建——固定探针名会截断并
 *  删除他人同名文件；wx 撞名（EEXIST）换名重试，其他错误直接判不可写；
 *  finally 只删除本次成功创建的探针。mkName 仅供测试注入固定名构造撞名 */
export function canWrite(dir: string, mkName: () => string = () => `.pt-write-probe-${randomUUID().slice(0, 8)}`): boolean {
  for (let attempt = 0; attempt < 3; attempt++) {
    const probe = join(dir, mkName())
    let created = false
    try {
      writeFileSync(probe, 'ok', { flag: 'wx' })
      created = true
      return true
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') return false
    } finally {
      if (created) {
        try { unlinkSync(probe) } catch { /* 删除失败的探针残留无害（随机名） */ }
      }
    }
  }
  return false
}

/** 迁移数据目录：校验 → 复制 → 校验 → 切指针。任何一步失败都保持原目录可用
 *  （hardening 1c）：三个数据文件都预检存在性；复制用 COPYFILE_EXCL 兜住预检
 *  与复制间的并发创建；复制失败与指针写入失败同路回滚——删除本次已创建的
 *  文件保证重试不被自己挡住，清理失败把残留文件名报告给用户 */
export function migrateDataDir(paths: StoragePaths, nextDir: string): MigrationResult {
  const cur = paths.getDataDir()
  if (!existsSync(nextDir)) return { ok: false, error: '目标目录不存在' }
  if (!canWrite(nextDir)) return { ok: false, error: '目标目录不可写' }
  const conflict = DATA_FILES.find(f => existsSync(join(nextDir, f)))
  if (conflict) {
    return { ok: false, error: `目标目录已有 ${conflict}，为避免覆盖请更换目录` }
  }

  const created: string[] = []
  try {
    for (const name of DATA_FILES) {
      const from = join(cur, name)
      if (!existsSync(from)) continue
      const to = join(nextDir, name)
      copyFileSync(from, to, constants.COPYFILE_EXCL)
      created.push(to)
      if (statSync(from).size !== statSync(to).size) throw new Error(`文件校验不一致: ${name}`)
    }
    paths.setDataDir(nextDir) // 原子写指针；失败同样回滚，旧指针保持完好
  } catch (e) {
    const leftovers: string[] = []
    for (const f of [...created].reverse()) {
      try { unlinkSync(f) } catch { leftovers.push(f) }
    }
    const base = `迁移失败：${(e as Error).message}，已保持原目录`
    return {
      ok: false,
      error: leftovers.length ? `${base}；以下文件未能清理，请手动删除：${leftovers.join('、')}` : base
    }
  }
  return { ok: true, to: nextDir }
}

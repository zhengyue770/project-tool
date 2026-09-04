import type { CommandConfig, QuickCommand } from './types'

// 快捷命令同步合并（spec 2026-09-04-quick-commands §4）：
// 就地替换同步子集、保留用户排序——手动命令原位保留；同步命令仍在源头的原位更新
// （cmd 变更生效、id/位置不变），已从源头删除的移除；扫描新增的按扫描顺序追加末尾。
// 主进程（持久化）与编辑弹窗（刷新暂存列表）共用，必须保持纯函数。

export function applySync(existing: QuickCommand[] | undefined, scanned: QuickCommand[]): QuickCommand[] {
  const byId = new Map(scanned.map(q => [q.id, q]))
  const out: QuickCommand[] = []
  for (const q of existing ?? []) {
    if (q.source === 'manual') {
      out.push(q)
      continue
    }
    const fresh = byId.get(q.id)
    // 位置不动，内容对齐源头；未变更时保留原对象（引用稳定，调用方可做浅比较）
    if (fresh) out.push(fresh.cmd === q.cmd ? q : { ...q, cmd: fresh.cmd })
    // 源头已删 → 不再保留
  }
  const known = new Set(out.map(q => q.id))
  for (const q of scanned) {
    if (!known.has(q.id)) out.push(q)
  }
  return out
}

/** 与启动命令重复的同步命令不导入：命令串一致且启动命令也在项目根执行才算重复
 *  （同步命令固定在项目根跑；启动命令配了子目录则是另一回事）。后续启动命令变更
 *  与同步命令撞车时，下次同步即自动移除已有的重复同步命令。 */
export function dropStartupDuplicates(startup: CommandConfig[], scanned: QuickCommand[]): QuickCommand[] {
  const dup = new Set(startup.map(c => `${c.cmd.trim()}\u0000${c.workdir || '.'}`))
  return scanned.filter(q => !dup.has(`${q.cmd.trim()}\u0000.`))
}

/** 排除列表（同步命令可删除）：命中排除 id 的扫描命令不参与同步，
 *  删除的同步命令不会被下次同步加回 */
export function filterExcluded(scanned: QuickCommand[], excluded: string[]): QuickCommand[] {
  if (!excluded.length) return scanned
  const skip = new Set(excluded)
  return scanned.filter(q => !skip.has(q.id))
}

/** 清理失效排除项：源文件已无此脚本（扫描不到）的排除 id 移除——
 *  脚本删掉又重新加回时它会再次出现，属预期行为 */
export function cleanExcluded(excluded: string[], scanned: QuickCommand[]): string[] {
  if (!excluded.length) return []
  const alive = new Set(scanned.map(q => q.id))
  return excluded.filter(id => alive.has(id))
}

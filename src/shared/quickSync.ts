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

/** 与启动命令重复的同步命令不导入。比较用**保守识别**（hardening 计划 1a）：
 *  只认扫描器实际生成的明确形式（同 runner 才比较），名字槽位允许一层成对
 *  单引号；npm 裸名（npm dev）、内置命令（yarn add / bun install）、含操作符
 *  或任何无法确定的语法 → 一律不判重——宁可多显示一条快捷命令，不错误隐藏。 */
export function dropStartupDuplicates(startup: CommandConfig[], scanned: QuickCommand[]): QuickCommand[] {
  const dup = new Set<string>()
  for (const c of startup) {
    const key = commandScriptKey(c.cmd)
    // 同步命令固定在项目根执行；启动命令配了子目录不算重复
    if (key && (c.workdir || '.') === '.') dup.add(`${key.runner}\u0000${key.name}`)
  }
  return scanned.filter(q => {
    const k = commandScriptKey(q.cmd)
    return !(k && dup.has(`${k.runner}\u0000${k.name}`))
  })
}

/** 识别「<runner> run <名字>」等扫描器生成的命令形式，提取 (runner, 名字)；
 *  无法确定返回 null。裸名只允许安全字面量字符——不含括号（`foo(bar)` 裸拼在
 *  sh 里是语法错误，与带引号的合法形式判等会错误隐藏有效快捷命令，review 修正）；
 *  带引号的槽位可含任意非单引号字符。出现 $、反引号、操作符、多段命令 → null */
export function commandScriptKey(cmd: string): { runner: string; name: string } | null {
  const s = cmd.trim()
  const NAME = `([A-Za-z0-9_@:./+=%-]+|'[^']*')`
  const slot = (raw: string): string => (raw.startsWith("'") ? raw.slice(1, -1) : raw)
  let m = new RegExp(`^(npm|pnpm|yarn|bun) run ${NAME}$`).exec(s)
  if (m) return { runner: m[1], name: slot(m[2]) }
  m = new RegExp(`^make ${NAME}$`).exec(s)
  if (m) return { runner: 'make', name: slot(m[1]) }
  m = new RegExp(`^just ${NAME}$`).exec(s)
  if (m) return { runner: 'just', name: slot(m[1]) }
  m = new RegExp(`^composer run ${NAME}$`).exec(s)
  if (m) return { runner: 'composer', name: slot(m[1]) }
  return null
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

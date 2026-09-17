import type { Project } from '../shared/types'

/** review P2 守卫（两轮）：找出「旧配置有、新配置没有、且进程组仍存活」的
 *  启动/快捷命令名称。projects:update / quick:sync 直接覆盖配置，若不拦截，
 *  被移除命令的进程会失去卡片停止入口（删除项目也只遍历新配置），成为孤儿。
 *  isLive 由调用方注入管理器的 hasLiveProcessGroup——**进程组存活真值**而非展示
 *  状态：stop() 先同步置 stopped 再异步杀组的窗口内、停止失败恢复运行态后，
 *  守卫都必须仍然拒绝。新配置取 autoSyncQuick 之后的最终落盘形态——同步丢弃
 *  运行中命令同样拦截。 */
export function removedLiveNames(
  prior: Project,
  next: Project,
  isLive: (commandId: string) => boolean
): string[] {
  const nextIds = new Set([
    ...next.commands.map(c => c.id),
    ...(next.quickCommands ?? []).map(q => q.id)
  ])
  const names: string[] = []
  for (const c of prior.commands) {
    if (!nextIds.has(c.id) && isLive(c.id)) names.push(c.name)
  }
  for (const q of prior.quickCommands ?? []) {
    if (!nextIds.has(q.id) && isLive(q.id)) names.push(q.name)
  }
  return names
}

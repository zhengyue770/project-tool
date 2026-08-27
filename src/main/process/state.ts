import type { CommandRuntimeStatus, ProjectAggStatus } from '../../shared/types'

/** spec §5.3：全 running=运行中；任一 starting=启动中；任一 failed=失败；全 stopped=已停止；其余=部分运行 */
export function aggregateProjectStatus(states: CommandRuntimeStatus[]): ProjectAggStatus {
  if (states.length === 0) return 'stopped'
  if (states.every(s => s === 'running')) return 'running'
  if (states.some(s => s === 'starting')) return 'starting'
  if (states.some(s => s === 'failed')) return 'failed'
  if (states.every(s => s === 'stopped')) return 'stopped'
  return 'partial'
}

import { describe, expect, it } from 'vitest'
import { removedLiveNames } from './projectGuard'
import type { Project } from '../shared/types'

// review P2 回归（两轮）：运行中的命令被保存操作移除（含清空全部启动命令）时，
// 主进程必须拒绝保存。判据是**进程组存活**而非展示状态——stop() 先同步置 stopped
// 再异步杀组的窗口内、停止失败恢复运行态后，都必须仍然拒绝
const cmd = (id: string, name = id): Project['commands'][number] =>
  ({ id, name, cmd: 'x', workdir: '.', port: 3000 })
const quick = (id: string, name = id): NonNullable<Project['quickCommands']>[number] =>
  ({ id, name, cmd: 'x', source: 'manual' })
const project = (commands: Project['commands'], quickCommands: Project['quickCommands'] = []): Project =>
  ({ id: 'p1', name: 'p', path: '/tmp', commands, quickCommands, urls: [], accounts: [], createdAt: 0 }) as Project

describe('removedLiveNames（移除存活进程命令的保存守卫）', () => {
  const live = (ids: string[]) => (id: string): boolean => ids.includes(id)

  it('进程组仍存活的启动命令被移除 → 报出其名称', () => {
    const prior = project([cmd('a', '前端'), cmd('b', '后端')])
    const next = project([cmd('b', '后端')])
    expect(removedLiveNames(prior, next, live(['a']))).toEqual(['前端'])
  })

  it('回归：运行中删除最后一条启动命令（保存空命令列表）→ 拦截', () => {
    const prior = project([cmd('only', '启动')])
    const next = project([])
    expect(removedLiveNames(prior, next, live(['only']))).toEqual(['启动'])
  })

  it('进程已消亡（自然退出或停止确认完成）→ 放行移除', () => {
    const prior = project([cmd('a'), cmd('b')])
    const next = project([])
    expect(removedLiveNames(prior, next, live([]))).toEqual([])
  })

  it('存活的快捷命令被移除（手动删除或同步丢弃）→ 拦截', () => {
    const prior = project([], [quick('q1', '构建')])
    const next = project([])
    expect(removedLiveNames(prior, next, live(['q1']))).toEqual(['构建'])
  })

  it('保留的命令（ID 未变）不受影响', () => {
    const prior = project([cmd('a')], [quick('q1')])
    const next = project([cmd('a')], [quick('q1')])
    expect(removedLiveNames(prior, next, live(['a', 'q1']))).toEqual([])
  })
})

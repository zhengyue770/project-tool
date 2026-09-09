import { describe, it, expect, vi } from 'vitest'
import type { BrowserWindow } from 'electron'
import { QuitGateway, type MessageBoxOptions, type QuitManagerLike } from './quitGateway'

// hardening 2a（review 修正 #2/#3/#4）：退出网关的状态机——取消/失败路径必须撤销
// 排空并回到 idle；busy 防重入；对话框异常视为未确认；无窗口也弹确认。

interface Setup {
  count?: number
  stopResult?: { stopped: string[]; skipped: Array<{ key: string; reason: string }> }
  responses?: number[] // 依次弹窗的按钮选择
  dialogThrows?: boolean
}

function mk(setup: Setup = {}) {
  const manager: QuitManagerLike = {
    draining: false,
    beginDraining: vi.fn(),
    endDraining: vi.fn(),
    activeInventory: () => ({ count: setup.count ?? 0 }),
    stopAll: vi.fn(async () => setup.stopResult ?? { stopped: ['p:c'], skipped: [] })
  }
  const responses = [...(setup.responses ?? [])]
  const dialogs: Array<{ win: BrowserWindow | null; opts: MessageBoxOptions }> = []
  const quits: number[] = []
  const gateway = new QuitGateway({
    manager,
    getWin: () => null, // 全部场景都在"无窗口"下运行（review 修正 #3 的覆盖）
    showMessageBox: async (win, opts) => {
      dialogs.push({ win, opts })
      if (setup.dialogThrows) throw new Error('dialog boom')
      return { response: responses.shift() ?? 0 }
    },
    quit: () => { quits.push(quits.length) }
  })
  return { gateway, manager, dialogs, quits }
}

describe('QuitGateway.requestQuit', () => {
  it('无运行命令 → 直接确认退出（不弹窗），stage=confirmed', async () => {
    const { gateway, quits, dialogs } = mk()
    expect(await gateway.requestQuit()).toBe('quit')
    expect(quits).toHaveLength(1)
    expect(dialogs).toEqual([])
    expect(gateway.getStage()).toBe('confirmed')
  })

  it('有命令 + 取消 → 回 idle、未排空、未退出，且可再次发起', async () => {
    const { gateway, manager, quits } = mk({ count: 2, responses: [0] })
    expect(await gateway.requestQuit()).toBe('cancel')
    expect(gateway.getStage()).toBe('idle')
    expect(manager.beginDraining).not.toHaveBeenCalled()
    expect(quits).toHaveLength(0)
    expect(manager.draining).toBe(false)
    // 网关未卡死，可再次发起
    void gateway.requestQuit()
  })

  it('让它们继续运行 → 退出（进入排空但无需撤销）', async () => {
    const { gateway, manager, quits } = mk({ count: 1, responses: [1] })
    expect(await gateway.requestQuit()).toBe('quit')
    expect(manager.beginDraining).toHaveBeenCalled()
    expect(manager.endDraining).not.toHaveBeenCalled()
    expect(quits).toHaveLength(1)
  })

  it('停止并退出 + 全部停止成功 → 退出', async () => {
    const { gateway, quits, dialogs } = mk({ count: 1, responses: [2] })
    expect(await gateway.requestQuit()).toBe('quit')
    expect(quits).toHaveLength(1)
    expect(dialogs).toHaveLength(1) // 无失败，无二次弹窗
  })

  it('停止失败 + 二次确认取消 → 撤销排空回 idle（review 修正 #2）', async () => {
    const { gateway, manager, quits } = mk({
      count: 1,
      responses: [2, 0],
      stopResult: { stopped: [], skipped: [{ key: 'p:c', reason: '信号发送失败，进程组仍存活' }] }
    })
    expect(await gateway.requestQuit()).toBe('cancel')
    expect(manager.beginDraining).toHaveBeenCalled()
    expect(manager.endDraining).toHaveBeenCalled() // 排空被撤销
    expect(manager.draining).toBe(false)
    expect(gateway.getStage()).toBe('idle')
    expect(quits).toHaveLength(0)
  })

  it('对话框异常 → 视为未确认：cancel、不退出、回 idle（review 修正 #3）', async () => {
    const { gateway, quits } = mk({ count: 1, dialogThrows: true })
    expect(await gateway.requestQuit()).toBe('cancel')
    expect(gateway.getStage()).toBe('idle')
    expect(quits).toHaveLength(0)
  })

  it('busy 防重入：首流程未决时第二次 requestQuit 返回 busy，不并行第二套（review 修正 #4）', async () => {
    let resolveDlg: (r: { response: number }) => void = () => undefined
    const manager: QuitManagerLike = {
      draining: false,
      beginDraining: vi.fn(),
      endDraining: vi.fn(),
      activeInventory: () => ({ count: 1 }),
      stopAll: vi.fn(async () => ({ stopped: [], skipped: [] }))
    }
    const gateway = new QuitGateway({
      manager,
      getWin: () => null,
      showMessageBox: () => new Promise(r => { resolveDlg = r }),
      quit: () => undefined
    })
    const first = gateway.requestQuit()
    expect(gateway.getStage()).toBe('busy')
    expect(await gateway.requestQuit()).toBe('busy')
    expect(gateway.interceptBeforeQuit()).toBe(false) // Cmd+Q 被拦截
    resolveDlg({ response: 0 })
    expect(await first).toBe('cancel')
    expect(gateway.getStage()).toBe('idle')
  })
})

describe('QuitGateway.requestUpdate', () => {
  it('取消 → cancel 且撤销排空；确认 → proceed 且不替调用方退出', async () => {
    const { gateway, manager, quits } = mk({ count: 1, responses: [0] })
    expect(await gateway.requestUpdate()).toBe('cancel')
    expect(gateway.getStage()).toBe('idle')
    expect(quits).toHaveLength(0)

    const g2 = mk({ count: 1, responses: [1] }) // 直接更新
    expect(await g2.gateway.requestUpdate()).toBe('proceed')
    expect(g2.gateway.getStage()).toBe('busy') // 等待调用方 install→quitApp 或 release
    expect(g2.quits).toHaveLength(0) // 不越俎代庖退出

    // 失败路径（会话创建失败等）：release 后回到可用，可再发起退出
    g2.gateway.release()
    expect(g2.gateway.getStage()).toBe('idle')
    expect(g2.manager.endDraining).toHaveBeenCalled()
  })

  it('先停止再更新 + 停止失败 + 二次取消 → cancel 且撤销排空', async () => {
    const { gateway, manager } = mk({
      count: 2,
      responses: [2, 0],
      stopResult: { stopped: [], skipped: [{ key: 'p:c', reason: '组长已退出，组内后代身份无法验证' }] }
    })
    expect(await gateway.requestUpdate()).toBe('cancel')
    expect(manager.endDraining).toHaveBeenCalled()
    expect(gateway.getStage()).toBe('idle')
  })

  it('markConfirmedAndQuit → 退出且 before-quit 放行（更新安装成功路径）', async () => {
    const { gateway, quits } = mk()
    gateway.markConfirmedAndQuit()
    expect(quits).toHaveLength(1)
    expect(gateway.interceptBeforeQuit()).toBe(true)
  })
})

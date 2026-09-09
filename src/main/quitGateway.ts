import type { BrowserWindow } from 'electron'

// hardening 2a/2c（review 修正 #3/#4）：普通退出与更新安装共用同一退出网关——
// 单一阶段状态防两套流程并行；确认到退出之间排空（拒绝新启动），取消/失败且
// 应用继续运行的所有路径一律撤销排空；无窗口时用不绑定父窗口的对话框；
// 对话框异常视为"未确认"，绝不直接放行退出。

export type QuitStage = 'idle' | 'busy' | 'confirmed'

export interface MessageBoxOptions {
  type: 'warning' | 'info' | 'error'
  title: string
  message: string
  detail?: string
  buttons: string[]
  defaultId: number
  cancelId: number
}

/** 网关依赖的最小 manager 面（ProcessManager 满足；测试注入桩） */
export interface QuitManagerLike {
  draining: boolean
  beginDraining(): void
  endDraining(): void
  activeInventory(): { count: number }
  stopAll(): Promise<{ stopped: string[]; skipped: Array<{ key: string; reason: string }> }>
}

export interface QuitGatewayDeps {
  manager: QuitManagerLike
  getWin: () => BrowserWindow | null
  showMessageBox: (win: BrowserWindow | null, opts: MessageBoxOptions) => Promise<{ response: number }>
  quit: () => void
}

export class QuitGateway {
  private stage: QuitStage = 'idle'

  constructor(private readonly deps: QuitGatewayDeps) {}

  getStage(): QuitStage { return this.stage }

  /** 更新流程用：updater 的 quitApp 回调——确认后直接带 confirmed 退出，
   *  不再触发 before-quit 网关二次确认 */
  markConfirmedAndQuit(): void {
    this.stage = 'confirmed'
    this.deps.quit()
  }

  /** before-quit 调用：confirmed 放行（返回 true），否则拦截并异步走确认流程 */
  interceptBeforeQuit(): boolean {
    if (this.stage === 'confirmed') return true
    if (this.stage === 'idle') void this.requestQuit()
    // busy：已有退出/更新流程在途，拦截本次触发，不并行第二套
    return false
  }

  /** 用户发起退出（Cmd+Q/菜单）。busy 时返回 'busy'（不并行） */
  async requestQuit(): Promise<'quit' | 'cancel' | 'busy'> {
    if (this.stage !== 'idle') return this.stage === 'busy' ? 'busy' : 'cancel'
    this.stage = 'busy'
    const ok = await this.confirmRunningCommands('quit')
    if (!ok) {
      this.release()
      return 'cancel'
    }
    this.markConfirmedAndQuit()
    return 'quit'
  }

  /** 更新安装前确认（对话先于替换脚本 spawn）。busy 时返回 'cancel'（更新中止） */
  async requestUpdate(): Promise<'proceed' | 'cancel'> {
    if (this.stage !== 'idle') return 'cancel'
    this.stage = 'busy'
    const ok = await this.confirmRunningCommands('update')
    if (!ok) {
      this.release()
      return 'cancel'
    }
    // 此处只做确认；spawn 与退出由调用方（updater.install + quitApp）完成。
    // 应用未随之退出的失败路径（如会话创建失败）由调用方调 release()
    return 'proceed'
  }

  /** 回到 idle 并撤销排空——"应用继续运行"的所有路径（取消/失败）统一走这里 */
  release(): void {
    this.stage = 'idle'
    this.deps.manager.endDraining()
  }

  /** 有运行中命令时弹确认（可能再弹停止失败二次确认）；返回是否继续退出流程。
   *  无窗口时用不绑定父窗口的对话框（关窗后从菜单退出也要确认）；
   *  对话框异常一律视为未确认 */
  private async confirmRunningCommands(mode: 'quit' | 'update'): Promise<boolean> {
    try {
      const inv = this.deps.manager.activeInventory()
      if (inv.count === 0) return true
      const win = this.deps.getWin()
      const choice = await this.deps.showMessageBox(win, {
        type: 'warning',
        title: '有命令正在运行',
        message: `有 ${inv.count} 个命令正在运行。`,
        detail: mode === 'quit'
          ? '命令进程独立于应用存活：可以让它们继续在后台运行，也可以先停止再退出。'
          : '命令进程独立于应用存活：重启更新后它们将继续在后台运行。',
        buttons: ['取消', mode === 'quit' ? '让它们继续运行' : '直接更新', '停止并' + (mode === 'quit' ? '退出' : '更新')],
        defaultId: 0,
        cancelId: 0
      })
      if (choice.response === 0) return false
      // 已确认要退出/更新：进入排空，拒绝新启动（无论停不停命令）
      this.deps.manager.beginDraining()
      if (choice.response === 1) return true
      // 停止并退出/更新
      const r = await this.deps.manager.stopAll()
      if (r.skipped.length === 0) return true
      const again = await this.deps.showMessageBox(this.deps.getWin(), {
        type: 'warning',
        title: '部分命令未能停止',
        message: `以下 ${r.skipped.length} 项未能停止：`,
        detail: r.skipped.map(s => `${s.key}（${s.reason}）`).join('\n'),
        buttons: ['取消', mode === 'quit' ? '仍然退出' : '仍然更新'],
        defaultId: 0,
        cancelId: 0
      })
      return again.response !== 0
    } catch {
      return false // 对话框异常 ≠ 用户同意退出
    }
  }
}

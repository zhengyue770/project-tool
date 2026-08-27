import { describe, it, expect, afterEach } from 'vitest'
import { join } from 'node:path'
import { kill } from 'node:process'
import type { Project, RuntimeFile } from '../../shared/types'
import { ProcessManager } from './manager'
import { probe } from './health'
import { waitFor } from '../../../tests/helpers'

const FIXTURE = join(process.cwd(), 'tests/fixtures/server.mjs')
const port = (): number => 45670 + Math.floor(Math.random() * 1000)

function mkProject(p: number, cmd: string): Project {
  return {
    id: 'p1', name: 't', path: process.cwd(),
    commands: [{ id: 'c1', name: 'srv', cmd, workdir: '.', port: p }],
    urls: [], accounts: [], createdAt: 0
  }
}
function alive(pid: number): boolean { try { kill(pid, 0); return true } catch { return false } }

const managers: ProcessManager[] = []
afterEach(() => { for (const m of managers.splice(0)) void m.stopProjectForTest() })

function mkManager(over: Partial<ConstructorParameters<typeof ProcessManager>[0]> = {}): ProcessManager {
  const m = new ProcessManager({ startupTimeoutMs: () => 5000, healthIntervalMs: 300, ...over })
  managers.push(m)
  return m
}

describe('ProcessManager 启动链路', () => {
  it('starting → running（健康检查通过）', async () => {
    const p = port()
    const proj = mkProject(p, `node ${FIXTURE} ${p}`)
    const m = mkManager()
    m.start(proj, proj.commands[0])
    expect(m.statusOf('p1', 'c1')).toBe('starting')
    await waitFor(() => m.statusOf('p1', 'c1') === 'running')
  })

  it('进程启动即退出 → failed，日志可查', async () => {
    const p = port()
    const proj = mkProject(p, 'node -e "console.error(\'boom\'); process.exit(3)"')
    const m = mkManager()
    m.start(proj, proj.commands[0])
    await waitFor(() => m.statusOf('p1', 'c1') === 'failed')
    expect(m.logsOf('p1', 'c1').join('\n')).toContain('boom')
  })

  it('健康检查超时 → failed 且进程被杀', async () => {
    const p = port()
    const proj = mkProject(p, `node ${FIXTURE} ${p} 8000`) // 8 秒后才监听
    const m = mkManager({ startupTimeoutMs: () => 800 })
    m.start(proj, proj.commands[0])
    await waitFor(() => m.statusOf('p1', 'c1') === 'failed')
    // 从日志抓孙进程 pid 验证整组被杀
    const line = m.logsOf('p1', 'c1').find(l => l.includes('GRANDCHILD_PID'))
    const pid = Number(line?.match(/GRANDCHILD_PID:(\d+)/)?.[1])
    await waitFor(() => !alive(pid))
  })

  it('workdir 不存在 → spawn error → failed 且错误入日志（无未捕获异常）', async () => {
    const p = port()
    const proj = mkProject(p, `node ${FIXTURE} ${p}`)
    proj.commands[0].workdir = 'no-such-dir'
    const m = mkManager()
    m.start(proj, proj.commands[0])
    await waitFor(() => m.statusOf('p1', 'c1') === 'failed')
    expect(m.logsOf('p1', 'c1').join('\n')).toContain('[错误]')
  })

  it('运行后日志保留在环形缓冲且 pid 写入 runtime', async () => {
    const p = port()
    const proj = mkProject(p, `node ${FIXTURE} ${p}`)
    let saved: RuntimeFile | undefined
    const m = mkManager({ onRuntimeChange: rf => (saved = rf) })
    m.start(proj, proj.commands[0])
    await waitFor(() => m.statusOf('p1', 'c1') === 'running')
    expect(saved?.['p1:c1']?.pid).toBeGreaterThan(0)
    await waitFor(() => m.logsOf('p1', 'c1').some(l => l.includes('heartbeat')))
  })
})

describe('ProcessManager 停止与恢复', () => {
  it('stop 杀整个进程组（孙进程一并退出）', async () => {
    const p = port()
    const proj = mkProject(p, `node ${FIXTURE} ${p}`)
    const m = mkManager()
    m.start(proj, proj.commands[0])
    await waitFor(() => m.statusOf('p1', 'c1') === 'running')
    const line = m.logsOf('p1', 'c1').find(l => l.includes('GRANDCHILD_PID'))
    const grand = Number(line?.match(/GRANDCHILD_PID:(\d+)/)?.[1])
    expect(alive(grand)).toBe(true)
    await m.stop('p1', 'c1')
    expect(m.statusOf('p1', 'c1')).toBe('stopped')
    await waitFor(() => !alive(grand))
  })

  it('拒收 SIGTERM 的进程在宽限后被 SIGKILL', async () => {
    const p = port()
    const proj = mkProject(p, `node ${FIXTURE} ${p} 0 ignore-term`)
    const m = mkManager({ killGraceMs: 800 })
    m.start(proj, proj.commands[0])
    await waitFor(() => m.statusOf('p1', 'c1') === 'running')
    await m.stop('p1', 'c1')
    const line = m.logsOf('p1', 'c1').find(l => l.includes('GRANDCHILD_PID'))
    const grand = Number(line?.match(/GRANDCHILD_PID:(\d+)/)?.[1])
    await waitFor(() => !alive(grand))
  })

  it('停止未完成时重启：旧进程退出不污染新启动', async () => {
    const p1 = port()
    const proj = mkProject(p1, `node ${FIXTURE} ${p1} 0 ignore-term`) // 拒收 SIGTERM，拉宽停止窗口
    let saved: RuntimeFile | undefined
    const m = mkManager({ killGraceMs: 500, onRuntimeChange: rf => (saved = rf) })
    m.start(proj, proj.commands[0])
    await waitFor(() => m.statusOf('p1', 'c1') === 'running')
    void m.stop('p1', 'c1') // 不等待：killEntry 异步走 SIGTERM→宽限→SIGKILL
    const p2 = port()
    proj.commands[0].port = p2 // 同一命令配置换成新端口的第二个实例后立即重启
    proj.commands[0].cmd = `node ${FIXTURE} ${p2} 0 ignore-term`
    m.start(proj, proj.commands[0])
    await waitFor(() => m.statusOf('p1', 'c1') === 'running')
    const newPid = saved?.['p1:c1']?.pid
    expect(newPid).toBeGreaterThan(0)
    // 等旧进程被 SIGKILL、其 exit 事件回来之后：新运行必须仍是 running 且 runtime 记录仍指向新 pid
    await new Promise(r => setTimeout(r, 2000))
    expect(m.statusOf('p1', 'c1')).toBe('running')
    expect(saved?.['p1:c1']?.pid).toBe(newPid)
  })

  it('restore：pid 存活且端口有服务 → 恢复 running 且可停止', async () => {
    const p = port()
    // 手动 detached 起一个"上次遗留"的进程（pgid === pid）
    const { spawn } = await import('node:child_process')
    const left = spawn(`node ${FIXTURE} ${p}`, { shell: true, detached: true, stdio: 'ignore' })
    for (let i = 0; i < 100 && !(await probe(`http://127.0.0.1:${p}`)); i++) {
      await new Promise(r => setTimeout(r, 50))
    }
    const proj = mkProject(p, `node ${FIXTURE} ${p}`)
    const m = mkManager()
    await m.restore([proj], { 'p1:c1': { pid: left.pid as number, startedAt: Date.now() } })
    expect(m.statusOf('p1', 'c1')).toBe('running')
    await m.stop('p1', 'c1')
    await waitFor(() => !alive(left.pid as number))
  })

  it('restore：pid 已死 → stopped', async () => {
    const p = port()
    const proj = mkProject(p, `node ${FIXTURE} ${p}`)
    const m = mkManager()
    await m.restore([proj], { 'p1:c1': { pid: 99999, startedAt: Date.now() } })
    expect(m.statusOf('p1', 'c1')).toBe('stopped')
  })

  it('statusListener 收到 starting/running 事件', async () => {
    const p = port()
    const proj = mkProject(p, `node ${FIXTURE} ${p}`)
    const m = mkManager()
    const got: string[] = []
    m.setStatusListener(e => got.push(e.status))
    m.start(proj, proj.commands[0])
    await waitFor(() => m.statusOf('p1', 'c1') === 'running')
    expect(got).toContain('starting')
    expect(got).toContain('running')
    await m.stop('p1', 'c1')
    expect(got).toContain('stopped')
  })

  it('subscribeLogs 推送新增日志行', async () => {
    const p = port()
    const proj = mkProject(p, `node ${FIXTURE} ${p}`)
    const m = mkManager()
    m.start(proj, proj.commands[0])
    await waitFor(() => m.statusOf('p1', 'c1') === 'running')
    const received: string[] = []
    m.subscribeLogs('p1', 'c1', lines => received.push(...lines))
    await waitFor(() => received.some(l => l.includes('heartbeat')))
  })
})

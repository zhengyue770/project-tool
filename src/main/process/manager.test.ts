import { describe, it, expect, afterEach } from 'vitest'
import { join } from 'node:path'
import { kill } from 'node:process'
import type { Project, RuntimeFile } from '../../shared/types'
import { ProcessManager } from './manager'
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

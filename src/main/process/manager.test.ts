import { describe, it, expect, afterEach } from 'vitest'
import { join } from 'node:path'
import { kill } from 'node:process'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import type { CommandConfig, Project, RuntimeFile } from '../../shared/types'
import { ProcessManager } from './manager'
import { probe } from './health'
import { waitFor } from '../../../tests/helpers'

const FIXTURE = join(process.cwd(), 'tests/fixtures/server.mjs')
const port = (): number => 45670 + Math.floor(Math.random() * 1000)

function mkProject(p: number, cmd: string, over?: Partial<CommandConfig>): Project {
  return {
    id: 'p1', name: 't', path: process.cwd(),
    commands: [{ id: 'c1', name: 'srv', cmd, workdir: '.', port: p, ...over }],
    urls: [], accounts: [], createdAt: 0
  }
}
function alive(pid: number): boolean { try { kill(pid, 0); return true } catch { return false } }

const managers: ProcessManager[] = []
afterEach(() => { for (const m of managers.splice(0)) void m.stopProjectForTest() })

function mkManager(over: Partial<ConstructorParameters<typeof ProcessManager>[0]> = {}): ProcessManager {
  // v1.1a：日志文件化——每个 manager 独立临时日志目录（模拟各自的 userData/logs）
  const dir = mkdtempSync(join(tmpdir(), 'pt-log-'))
  const m = new ProcessManager({ startupTimeoutMs: () => 5000, healthIntervalMs: 300, logDir: () => dir, ...over })
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

describe('ProcessManager 动态端口', () => {
  it('动态模式：从日志捕获真实端口并确认后 running', async () => {
    const proj = mkProject(0, `node ${FIXTURE} auto`, { portMode: 'dynamic' })
    const m = mkManager()
    m.start(proj, proj.commands[0])
    await waitFor(() => m.statusOf('p1', 'c1') === 'running')
    // 捕获的端口必须等于 fixture 实际监听端口（从 Local: 行反查）
    const localLine = m.logsOf('p1', 'c1').find(l => l.includes('Local:'))
    const realPort = Number(localLine?.match(/localhost:(\d+)/)?.[1])
    expect(realPort).toBeGreaterThan(0)
    expect(m.discoveredPortOf('p1', 'c1')).toBe(realPort)
    expect(m.logsOf('p1', 'c1').join('\n')).toContain('[自动发现]')
  })

  it('动态模式：日志无地址则超时失败', async () => {
    const proj = mkProject(0, 'node -e "setInterval(()=>{},1000)"', { portMode: 'dynamic' })
    const m = mkManager({ startupTimeoutMs: () => 800 })
    m.start(proj, proj.commands[0])
    await waitFor(() => m.statusOf('p1', 'c1') === 'failed')
    const all = m.logsOf('p1', 'c1').join('\n')
    expect(all).toContain('超时')
    // 动态模式超时提示须注明未从日志发现地址（区别于固定模式的"端口 N 未就绪"）
    expect(all).toContain('未从日志发现服务地址')
    expect(m.discoveredPortOf('p1', 'c1')).toBeNull()
  })

  it('动态模式：discoveredUrl 持久化到 runtime 记录', async () => {
    const proj = mkProject(0, `node ${FIXTURE} auto`, { portMode: 'dynamic' })
    let saved: RuntimeFile | undefined
    const m = mkManager({ onRuntimeChange: rf => (saved = rf) })
    m.start(proj, proj.commands[0])
    await waitFor(() => m.statusOf('p1', 'c1') === 'running')
    const localLine = m.logsOf('p1', 'c1').find(l => l.includes('Local:'))
    const realPort = Number(localLine?.match(/localhost:(\d+)/)?.[1])
    // 捕获成功即写入 runtime 记录（供应用重启后 restore 探测真实端口）
    expect(saved?.['p1:c1']?.discoveredUrl).toBe(`http://127.0.0.1:${realPort}`)
  })

  it('宿主换代后动态命令恢复 running 且带真实端口', async () => {
    const proj = mkProject(0, `node ${FIXTURE} auto`, { portMode: 'dynamic' })
    let saved: RuntimeFile | undefined
    const a = mkManager({ onRuntimeChange: rf => (saved = rf) })
    a.start(proj, proj.commands[0])
    await waitFor(() => a.statusOf('p1', 'c1') === 'running')
    const rec = saved?.['p1:c1']
    expect(rec?.discoveredUrl).toBeTruthy()
    const realPort = a.discoveredPortOf('p1', 'c1')
    // 宿主换代：新 manager（新日志目录）凭持久化的 discoveredUrl 采用同一存活进程
    const b = mkManager()
    await b.restore([proj], { 'p1:c1': rec! })
    expect(b.statusOf('p1', 'c1')).toBe('running')
    expect(b.discoveredPortOf('p1', 'c1')).toBe(realPort)
    await b.stop('p1', 'c1') // 清理（a 的 stopProjectForTest 幂等兜底）
  })

  it('日志写入文件且随运行增长', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pt-log-'))
    const p = port()
    const proj = mkProject(p, `node ${FIXTURE} ${p}`)
    const m = mkManager({ logDir: () => dir })
    m.start(proj, proj.commands[0])
    await waitFor(() => m.statusOf('p1', 'c1') === 'running')
    // stdout/stderr 走文件而非管道（键中 ':' 换 '__'）——这是应用退出后子进程不因 EPIPE 死亡的机制保证
    const file = join(dir, 'p1__c1.log')
    await waitFor(() => readFileSync(file, 'utf8').includes('GRANDCHILD_PID'))
    const before = readFileSync(file, 'utf8')
    await waitFor(() => readFileSync(file, 'utf8').length > before.length) // heartbeat 持续追加
  })

  it('restore 采用后继续 tail 日志', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pt-log-'))
    const proj = mkProject(0, `node ${FIXTURE} auto`, { portMode: 'dynamic' })
    let saved: RuntimeFile | undefined
    const a = mkManager({ logDir: () => dir, onRuntimeChange: rf => (saved = rf) })
    a.start(proj, proj.commands[0])
    await waitFor(() => a.statusOf('p1', 'c1') === 'running')
    // 宿主换代但沿用同一日志目录：B 采用后从文件末尾续读，新输出继续进日志面板
    const b = mkManager({ logDir: () => dir })
    await b.restore([proj], { 'p1:c1': saved!['p1:c1']! })
    expect(b.statusOf('p1', 'c1')).toBe('running')
    await waitFor(() => b.logsOf('p1', 'c1').some(l => l.includes('heartbeat')))
    await b.stop('p1', 'c1')
  })

  it('restore 采用后从文件头播种历史日志（原始行无时间前缀）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pt-log-'))
    const proj = mkProject(0, `node ${FIXTURE} auto`, { portMode: 'dynamic' })
    let saved: RuntimeFile | undefined
    const a = mkManager({ logDir: () => dir, onRuntimeChange: rf => (saved = rf) })
    a.start(proj, proj.commands[0])
    await waitFor(() => a.statusOf('p1', 'c1') === 'running')
    // 换代前先等历史行（启动头行已同步落文件；端口行/孙进程行经 tail 进缓冲）确已产生
    await waitFor(() => {
      const logs = a.logsOf('p1', 'c1')
      return logs.some(l => l.includes('Local:')) && logs.some(l => l.includes('GRANDCHILD_PID'))
    })
    // 宿主换代但沿用同一日志目录：B 采用后缓冲由文件头播种，日志面板重开即见本次运行从头开始的日志
    const b = mkManager({ logDir: () => dir })
    await b.restore([proj], { 'p1:c1': saved!['p1:c1']! })
    expect(b.statusOf('p1', 'c1')).toBe('running')
    const logs = b.logsOf('p1', 'c1')
    expect(logs.some(l => l.startsWith('$ '))).toBe(true) // 会话头行也在（v1.1b 启动写入文件）
    expect(logs.some(l => l.includes('Local:'))).toBe(true) // 历史播种：核心断言
    expect(logs.some(l => l.includes('GRANDCHILD_PID'))).toBe(true)
    // 播种行保留文件原样，不带 [时间] 前缀（与恢复后新行的时间前缀天然区分）
    expect(logs.some(l => l.includes('Local:') && !l.startsWith('['))).toBe(true)
    await b.stop('p1', 'c1')
  })

  it('启动头行写入日志文件', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pt-log-'))
    const p = port()
    const proj = mkProject(p, `node ${FIXTURE} ${p}`)
    const m = mkManager({ logDir: () => dir })
    m.start(proj, proj.commands[0])
    await waitFor(() => m.statusOf('p1', 'c1') === 'running')
    // 头行随启动截断一并落文件（v1.1b）：应用重开 restore 播种时它也在最前
    const text = readFileSync(join(dir, 'p1__c1.log'), 'utf8')
    expect(text.split('\n').some(l => l.startsWith('$ '))).toBe(true)
  })
})

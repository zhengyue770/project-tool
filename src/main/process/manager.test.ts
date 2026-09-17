import { describe, it, expect, afterEach, vi } from 'vitest'
import { join } from 'node:path'
import { kill } from 'node:process'
import { mkdtempSync, readFileSync, appendFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import type { CommandConfig, Project, RuntimeFile } from '../../shared/types'
import { ProcessManager, procStart, readAt } from './manager'
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
/** 整组消亡判定（与 manager.groupAlive 同语义：EPERM 视为组仍存活） */
function groupDead(pid: number): boolean {
  try {
    kill(-pid, 0)
    return false
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== 'EPERM'
  }
}

const managers: ProcessManager[] = []
// P1 修复：清理必须被 await——void 触发的异步停止与下一个用例并发，
// 残留进程/定时器会互相干扰并让用例窗口收不住
afterEach(async () => {
  await Promise.all(managers.splice(0).map(m => m.stopProjectForTest()))
})

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
    // hardening 2b：记录需带系统身份（lstart）才会被接管
    const lstart = procStart(left.pid as number)
    expect(lstart).toBeTruthy()
    await m.restore([proj], { 'p1:c1': { pid: left.pid as number, startedAt: Date.now(), lstart: lstart! } })
    expect(m.statusOf('p1', 'c1')).toBe('running')
    await m.stop('p1', 'c1')
    await waitFor(() => !alive(left.pid as number))
  })

  it('hardening 2b：记录缺 lstart（旧数据）或 lstart 不匹配（PID 复用）→ 不接管', async () => {
    const p = port()
    const { spawn } = await import('node:child_process')
    const left = spawn(`node ${FIXTURE} ${p}`, { shell: true, detached: true, stdio: 'ignore' })
    for (let i = 0; i < 100 && !(await probe(`http://127.0.0.1:${p}`)); i++) {
      await new Promise(r => setTimeout(r, 50))
    }
    const proj = mkProject(p, `node ${FIXTURE} ${p}`)
    const m = mkManager()
    // 旧格式（无 lstart）→ 不可信不接管
    await m.restore([proj], { 'p1:c1': { pid: left.pid as number, startedAt: Date.now() } })
    expect(m.statusOf('p1', 'c1')).toBe('stopped')
    // lstart 不匹配 → PID 可能已属于别人，不接管也不发信号
    await m.restore([proj], { 'p1:c1': { pid: left.pid as number, startedAt: Date.now(), lstart: 'Wed Jan  1 00:00:00 2020' } })
    expect(m.statusOf('p1', 'c1')).toBe('stopped')
    expect(alive(left.pid as number)).toBe(true) // 未被误杀
    kill(left.pid as number, 'SIGTERM') // 手动清理
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

// 快捷命令任务模式（spec 2026-09-04-quick-commands §5）：
// spawn 即 running（无 starting/端口探测/超时）；退出码 0→stopped、非 0→failed；
// stop 杀整组；restore 只查 pid 存活即恢复 running 并接管日志。
describe('ProcessManager 快捷命令（任务模式）', () => {
  function mkQuickProject(cmd: string): Project {
    return {
      id: 'p1', name: 't', path: process.cwd(),
      commands: [{ id: 'c1', name: 'srv', cmd: 'true', workdir: '.', port: 1 }],
      urls: [], accounts: [], createdAt: 0,
      quickCommands: [{ id: 'q1', name: 'task', cmd, source: 'manual' }]
    }
  }

  it('spawn 即 running；退出码 0 → stopped，stdout 进日志', async () => {
    const proj = mkQuickProject('node -e "console.log(42); process.exit(0)"')
    const m = mkManager()
    m.runTask(proj, proj.quickCommands![0])
    expect(m.statusOf('p1', 'q1')).toBe('running') // 无 starting 中间态
    await waitFor(() => m.statusOf('p1', 'q1') === 'stopped')
    expect(m.logsOf('p1', 'q1').join('\n')).toContain('42')
  })

  it('退出码非 0 → failed 并补退出码日志行', async () => {
    const proj = mkQuickProject('node -e "process.exit(3)"')
    const m = mkManager()
    m.runTask(proj, proj.quickCommands![0])
    await waitFor(() => m.statusOf('p1', 'q1') === 'failed')
    expect(m.logsOf('p1', 'q1').join('\n')).toContain('退出码 3')
  })

  it('运行中重复 runTask → 忽略（不产生第二份 runtime 记录/进程）', async () => {
    let saved: RuntimeFile | undefined
    const proj = mkQuickProject('node -e "setInterval(() => {}, 200)"')
    const m = mkManager({ onRuntimeChange: rf => (saved = rf) })
    m.runTask(proj, proj.quickCommands![0])
    m.runTask(proj, proj.quickCommands![0])
    expect(m.statusOf('p1', 'q1')).toBe('running')
    const pid = saved!['p1:q1']!.pid
    expect(saved!['p1:q1']!.task).toBe(true) // runtime 记录带任务标记（restore 不探端口）
    await new Promise(r => setTimeout(r, 150))
    expect(saved!['p1:q1']?.pid).toBe(pid) // 未被第二次调用重置
    await m.stop('p1', 'q1')
  })

  it('stop 杀任务进程，状态回 stopped', async () => {
    let saved: RuntimeFile | undefined
    const proj = mkQuickProject('node -e "console.log(1); setInterval(() => {}, 200)"')
    const m = mkManager({ onRuntimeChange: rf => (saved = rf) })
    m.runTask(proj, proj.quickCommands![0])
    await waitFor(() => saved?.['p1:q1']?.pid !== undefined)
    const pid = saved!['p1:q1']!.pid
    await m.stop('p1', 'q1')
    expect(m.statusOf('p1', 'q1')).toBe('stopped')
    await waitFor(() => !alive(pid))
  })

  it('restore：任务记录 pid 存活 → 直接 running 并从文件播种日志（不探端口）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pt-log-'))
    const proj = mkQuickProject('node -e "console.log(\'TASK_LOG\'); setInterval(() => {}, 200)"')
    let saved: RuntimeFile | undefined
    const a = mkManager({ logDir: () => dir, onRuntimeChange: rf => (saved = rf) })
    a.runTask(proj, proj.quickCommands![0])
    await waitFor(() => saved?.['p1:q1']?.pid !== undefined)
    await waitFor(() => a.logsOf('p1', 'q1').some(l => l.includes('TASK_LOG')))
    const b = mkManager({ logDir: () => dir })
    await b.restore([proj], { 'p1:q1': saved!['p1:q1']! }) // 项目无端口可探，存活即恢复
    expect(b.statusOf('p1', 'q1')).toBe('running')
    expect(b.logsOf('p1', 'q1').some(l => l.includes('TASK_LOG'))).toBe(true)
    await b.stop('p1', 'q1')
  })

  it('子进程环境剥离 npm 注入的元数据（npm_config/package/lifecycle_* 与 INIT_CWD），PATH 保留', async () => {
    // 启动器经 npm run 启动时环境里带着 npm_config_*（本测试即运行在 npm 上下文中），
    // 子命令不应继承——否则会以 env 配置优先级覆盖目标项目自己的 .npmrc
    const proj = mkQuickProject(
      'node -e "console.log(\'ENVCHK:\' + JSON.stringify({ npm: Object.keys(process.env).filter(k => /^npm_(config|package|lifecycle)_/i.test(k)), init: process.env.INIT_CWD ?? \'\', hasPath: !!process.env.PATH }))"')
    const m = mkManager()
    m.runTask(proj, proj.quickCommands![0])
    await waitFor(() => m.statusOf('p1', 'q1') === 'stopped')
    const line = m.logsOf('p1', 'q1').find(l => l.includes('ENVCHK:{')) // 头行回显命令源码也含 ENVCHK:，只认真实输出
    const parsed = JSON.parse(line!.slice(line!.indexOf('ENVCHK:') + 'ENVCHK:'.length))
    expect(parsed.npm).toEqual([])
    expect(parsed.init).toBe('')
    expect(parsed.hasPath).toBe(true)
  })
})

// hardening 2a/2b：stopAll 覆盖「本次启动 + 恢复接管」两类进程；
// 组长已退出的遗留组跳过并报告（不猜测、不承诺自动停止）。
describe('ProcessManager stopAll（退出网关）', () => {
  function mkQuick(cmd: string, id = 'p1'): Project {
    return {
      id, name: 't', path: process.cwd(),
      commands: [{ id: 'c1', name: 'srv', cmd: 'true', workdir: '.', port: 1 }],
      urls: [], accounts: [], createdAt: 0,
      quickCommands: [{ id: 'q1', name: 'task', cmd, source: 'manual' }]
    }
  }

  it('本次启动 + 恢复接管的进程都被停止，报告无跳过', async () => {
    const m = mkManager()
    const proj1 = mkQuick('node -e "setInterval(() => {}, 200)"', 'p1')
    m.runTask(proj1, proj1.quickCommands![0])

    const { spawn } = await import('node:child_process')
    const left = spawn('node', ['-e', 'setInterval(() => {}, 200)'], { detached: true, stdio: 'ignore' })
    const lstart = procStart(left.pid as number)
    expect(lstart).toBeTruthy()
    const proj2 = mkQuick('true', 'p2')
    await m.restore([proj2], { 'p2:q1': { pid: left.pid as number, startedAt: Date.now(), lstart: lstart! } })
    expect(m.statusOf('p2', 'q1')).toBe('running')

    expect(m.activeInventory().count).toBe(2)
    const r = await m.stopAll()
    expect(r.skipped).toEqual([])
    expect(r.stopped.sort()).toEqual(['p1:q1', 'p2:q1'])
    // review 修正：恢复接管的命令停止后状态同步为 stopped（不再滞留 running）
    expect(m.statusOf('p1', 'q1')).toBe('stopped')
    expect(m.statusOf('p2', 'q1')).toBe('stopped')
    await waitFor(() => !alive(left.pid as number))
  })

  // review 修正（#1）：停止失败不得谎报成功
  it('信号发送失败 → stopAll 计 skipped、状态维持 running；单条 stop 抛错并保持 running；恢复真实杀灭后可正常停止', async () => {
    const m = mkManager()
    const proj = mkQuick('node -e "setInterval(() => {}, 60000)"', 'p1')
    m.runTask(proj, proj.quickCommands![0])
    await waitFor(() => m.statusOf('p1', 'q1') === 'running')

    const anyM = m as unknown as Record<string, unknown>
    anyM.signalGroup = async () => 'signal-failed' // 两次信号都发不出去
    const r = await m.stopAll()
    expect(r.stopped).toEqual([])
    expect(r.skipped[0]!.reason).toContain('信号')
    expect(m.statusOf('p1', 'q1')).toBe('running')
    await expect(m.stop('p1', 'q1')).rejects.toThrow('停止失败')
    expect(m.statusOf('p1', 'q1')).toBe('running') // 状态回滚，不误报已停止

    delete anyM.signalGroup // 回到真实杀灭路径
    await m.stop('p1', 'q1')
    expect(m.statusOf('p1', 'q1')).toBe('stopped')
  })

  it('SIGKILL 后组仍存活 → 计 skipped 且不删运行记录；恢复真实杀灭后正常停止', async () => {
    const m = mkManager()
    const proj = mkQuick('node -e "setInterval(() => {}, 60000)"', 'p1')
    m.runTask(proj, proj.quickCommands![0])
    await waitFor(() => m.statusOf('p1', 'q1') === 'running')
    const anyM = m as unknown as Record<string, unknown>
    anyM.signalGroup = async () => 'still-alive'
    const r = await m.stopAll()
    expect(r.stopped).toEqual([])
    expect(r.skipped[0]!.reason).toContain('未按期消亡')
    expect(m.statusOf('p1', 'q1')).toBe('running')
    delete anyM.signalGroup
    await m.stop('p1', 'q1')
    expect(m.statusOf('p1', 'q1')).toBe('stopped')
  })

  // review 修正（P2-1）：停止失败后监控必须恢复——starting 恢复后健康轮询继续工作，
  // 服务就绪仍能翻成 running（用延迟监听端口的服务端实测）
  it('停止失败恢复 starting → 重挂健康监控，端口就绪后照常翻 running', async () => {
    const p = port()
    const proj = mkProject(p, `node ${FIXTURE} ${p} 1500`) // 1.5s 后才监听
    const m = mkManager({ startupTimeoutMs: () => 8000, healthIntervalMs: 300 })
    m.start(proj, proj.commands[0])
    expect(m.statusOf('p1', 'c1')).toBe('starting')

    const anyM = m as unknown as Record<string, unknown>
    anyM.signalGroup = async () => 'signal-failed'
    await expect(m.stop('p1', 'c1')).rejects.toThrow('停止失败')
    expect(m.statusOf('p1', 'c1')).toBe('starting') // 恢复原状态而非直接标 running

    delete anyM.signalGroup // 恢复真实杀灭
    await waitFor(() => m.statusOf('p1', 'c1') === 'running') // 监控已重挂，就绪即翻转
    await m.stop('p1', 'c1')
    expect(m.statusOf('p1', 'c1')).toBe('stopped')
  })

  // review 修正（P2-2）：身份检查后进程恰好自行退出——信号发不出但组已消亡 → 视为成功
  it('信号发送失败但组已消亡 → signalGroup 返回 ok（不误报失败）', async () => {
    const anyM = mkManager() as unknown as Record<string, unknown>
    const killGroup = vi.fn(() => false) // 所有信号都"发送失败"
    const groupAlive = vi.fn(() => false) // 但组已消亡（自然退出竞态）
    anyM.killGroup = killGroup
    anyM.groupAlive = groupAlive
    // 注意 this 必须是打好桩的同一实例（review 修正：换实例会让桩失效、向真实组发信号）
    const r = await (anyM.signalGroup as (pid: number) => Promise<string>).call(anyM, 12345)
    expect(r).toBe('ok')
    expect(killGroup).toHaveBeenCalled() // 桩确实生效
    expect(groupAlive).toHaveBeenCalled()
  })

  it('停止 await 期间命令被重新启动 → 旧失败不碰新运行的状态', async () => {
    const p1 = port()
    const p2 = port()
    const proj = mkProject(p1, `node ${FIXTURE} ${p1}`)
    let saved: RuntimeFile | undefined
    const m = mkManager({ onRuntimeChange: rf => (saved = rf) })
    m.start(proj, proj.commands[0])
    await waitFor(() => m.statusOf('p1', 'c1') === 'running')
    // 旧进程身份（pid + lstart）：entry 稍后会被新运行覆盖，afterEach 清理不到它；
    // 清理前须凭 lstart 核对身份（alive 只证明存在，不证明还是同一个进程）
    const oldPid = saved!['p1:c1']!.pid
    const oldLstart = procStart(oldPid)
    expect(oldLstart).toBeTruthy()
    const anyM = m as unknown as Record<string, unknown>
    anyM.signalGroup = async () => {
      await new Promise(r => setTimeout(r, 150))
      return 'signal-failed'
    }
    try {
      const stopping = m.stop('p1', 'c1') // 不 await：await 期间重启
      // 新一轮换端口（旧进程还活着，同端口会 EADDRINUSE），同一 entry 被 gen++ 接管
      const proj2 = mkProject(p2, `node ${FIXTURE} ${p2}`)
      m.start(proj2, proj2.commands[0])
      await expect(stopping).rejects.toThrow('停止失败')
      // 新一轮的状态不受旧失败影响
      expect(['starting', 'running']).toContain(m.statusOf('p1', 'c1'))
      delete anyM.signalGroup // 恢复真实杀灭（finally 里还有兜底 delete，双保险）
      await waitFor(() => m.statusOf('p1', 'c1') === 'running')
      await m.stop('p1', 'c1')
    } finally {
      // review 修正：桩的移除必须最先做——断言中途失败时 afterEach 才能用真实停止逻辑清理新进程
      delete anyM.signalGroup
      // 回收遗留旧进程：身份核对通过才动手；杀组后确认整个进程组消亡（不只组长），
      // SIGKILL 兜底后同样等待确认
      if (oldPid && oldLstart && procStart(oldPid) === oldLstart) {
        kill(-oldPid, 'SIGTERM')
        try {
          await waitFor(() => groupDead(oldPid))
        } catch {
          kill(-oldPid, 'SIGKILL')
        }
        await waitFor(() => groupDead(oldPid))
      }
    }
  })

  it('组长已退出的遗留组 → 跳过并报告原因，组内后代不被误杀', async () => {
    const { spawn } = await import('node:child_process')
    // sh 为组长、node 为组内后代（& + wait 使 sh 不做 exec 优化，杀组长后组仍存活）
    const leader = spawn('sh', ['-c', 'node -e "setInterval(() => {}, 60000)" & wait'], { detached: true, stdio: 'ignore' })
    const lstart = procStart(leader.pid as number)
    expect(lstart).toBeTruthy()
    const m = mkManager()
    const proj = mkQuick('true', 'p1')
    await m.restore([proj], { 'p1:q1': { pid: leader.pid as number, startedAt: Date.now(), lstart: lstart! } })
    expect(m.statusOf('p1', 'q1')).toBe('running')

    kill(leader.pid as number, 'SIGKILL') // 只杀组长，后代继续持有 pgid
    await waitFor(() => !alive(leader.pid as number))

    const r = await m.stopAll()
    expect(r.stopped).toEqual([])
    expect(r.skipped).toHaveLength(1)
    expect(r.skipped[0]!.key).toBe('p1:q1')
    // 组未被误杀（后代仍存活）
    let groupAlive = false
    try { kill(-leader.pid!, 0); groupAlive = true } catch { groupAlive = false }
    expect(groupAlive).toBe(true)
    kill(-leader.pid!, 'SIGKILL') // 手动清理
  })
})

// 日志限容（hardening 批次三，验收场景 9/10/11）：字节偏移全链路、StringDecoder
// 跨界解码、有界接管、原文件轮转、三截断点重置。直接驱动内部方法构造确定性边界。
describe('ProcessManager 日志限容（hardening 批次三）', () => {
  type AnyM = Record<string, unknown>

  function setup(m: ProcessManager, key: string): { e: AnyM; file: string } {
    // 文件必须放在管理器自己的日志目录（adoptLogTail 会按 logFileFor 定位，
    // 不认 entry 上现挂的 logFile）
    const logDir = (m as unknown as { opts: { logDir: () => string } }).opts.logDir()
    const file = join(logDir, `${key.replace(':', '__')}.log`)
    m.logsOf(key.slice(0, key.indexOf(':')), key.slice(key.indexOf(':') + 1)) // 建立 entry
    const e = (m as unknown as { entries: Map<string, AnyM> }).entries.get(key)! as AnyM
    e.logFile = file
    e.offset = 0
    return { e, file }
  }

  it('验收场景 10：增量读取切在汉字中间 → StringDecoder 补完，不出乱码', () => {
    const m = mkManager()
    const { e, file } = setup(m, 'p1:c1')
    const anyM = m as unknown as { tailOnce: (e: AnyM) => void }
    const han = Buffer.from('汉字', 'utf8') // 6 字节
    writeFileSync(file, Buffer.concat([Buffer.from('ab'), han.subarray(0, 2)])) // 切在「汉”中间
    anyM.tailOnce(e)
    expect(m.logsOf('p1', 'c1')).toEqual([]) // 未成行：待补字节留在 decoder
    appendFileSync(file, Buffer.concat([han.subarray(2), Buffer.from('cd\n')]))
    anyM.tailOnce(e)
    expect(m.logsOf('p1', 'c1').some(l => l.includes('ab汉字cd'))).toBe(true) // 完整还原
  })

  it('轮转：超阈值 → 原文件截断重写保留尾部窗口，游标/decoder/partial 重置，续写只读新内容', () => {
    const m = mkManager()
    const { e, file } = setup(m, 'p1:c1')
    const anyM = m as unknown as { tailOnce: (e: AnyM) => void }
    // 11MB 的 64B/行内容 + 一条新行（触发读取与轮转）
    const chunk = Buffer.from(('x'.repeat(63) + '\n').repeat(Math.ceil((11 * 1024 * 1024) / 64)))
    writeFileSync(file, chunk)
    e.offset = statSync(file).size
    appendFileSync(file, 'tail-line\n')
    e.partial = 'stale'
    e.partialBytes = 5

    anyM.tailOnce(e)
    const after = statSync(file).size
    expect(after).toBeGreaterThan(0)
    expect(after).toBeLessThan(3 * 1024 * 1024) // 只剩 ~2MB 窗口 + 标记
    expect(readFileSync(file, 'utf8')).toContain('日志已限容')
    expect(e.offset).toBe(after) // 游标 = 新文件末尾
    expect(e.partial).toBe('')   // 截断点重置
    expect(e.partialBytes).toBe(0)

    // 轮转后追加 → 只续读增量，旧内容不重播
    appendFileSync(file, 'after-rotate\n')
    anyM.tailOnce(e)
    const logs = m.logsOf('p1', 'c1')
    expect(logs.some(l => l.includes('after-rotate'))).toBe(true)
    expect(logs.some(l => l.includes('tail-line'))).toBe(true) // 轮转前已入缓冲的行仍在
  })

  it('验收场景 11：clearLogs 重置 offset/decoder/partial，旧片段不拼进新会话', () => {
    const m = mkManager()
    const { e, file } = setup(m, 'p1:c1')
    const anyM = m as unknown as { tailOnce: (e: AnyM) => void }
    writeFileSync(file, 'old1\n')
    e.offset = statSync(file).size
    e.partial = '旧片段'
    e.partialBytes = 9
    m.clearLogs('p1', 'c1')
    expect(statSync(file).size).toBe(0)
    expect(e.offset).toBe(0)
    expect(e.partial).toBe('')
    appendFileSync(file, 'new1\n')
    anyM.tailOnce(e)
    const logs = m.logsOf('p1', 'c1')
    expect(logs.some(l => l.includes('new1'))).toBe(true)
    expect(logs.some(l => l.includes('旧片段'))).toBe(false)
  })

  it('验收场景 9：恢复接管有界——>2MB 历史只保留尾部窗口并标记，游标=末尾只续增量', () => {
    const m = mkManager()
    const { e, file } = setup(m, 'p1:c1')
    const anyM = m as unknown as { tailOnce: (e: AnyM) => void; adoptLogTail: (k: string, e: AnyM) => void }
    // 3MB：头部哨兵在 1MB 处（会被窗口裁掉），尾部哨兵在末尾
    const line = 'y'.repeat(63) + '\n'
    const head = Buffer.concat([
      Buffer.from(line.repeat(Math.ceil(1024 * 1024 / 64))),
      Buffer.from('前部哨兵-应被裁掉\n'),
      Buffer.from(line.repeat(Math.ceil(2 * 1024 * 1024 / 64)))
    ])
    writeFileSync(file, Buffer.concat([head, Buffer.from('尾部哨兵-应保留\n')]))

    anyM.adoptLogTail('p1:c1', e)
    const logs = m.logsOf('p1', 'c1')
    expect(logs.some(l => l.includes('恢复截断'))).toBe(true)
    expect(logs.some(l => l.includes('前部哨兵'))).toBe(false)
    expect(logs.some(l => l.includes('尾部哨兵'))).toBe(true)
    expect(logs.length).toBeLessThanOrEqual(500)
    expect(e.offset).toBe(statSync(file).size)

    appendFileSync(file, 'post-adopt\n')
    anyM.tailOnce(e)
    expect(m.logsOf('p1', 'c1').some(l => l.includes('post-adopt'))).toBe(true)
  })

  it('无换行的超长文件：接管保留窗口字节并标记；增量超限强制成行', () => {
    const m = mkManager()
    const { e, file } = setup(m, 'p1:c1')
    const anyM = m as unknown as { tailOnce: (e: AnyM) => void; adoptLogTail: (k: string, e: AnyM) => void }
    // 3MB 无换行 → 接管保留 ~2MB 单行 + 截断标记
    writeFileSync(file, Buffer.alloc(3 * 1024 * 1024, 0x7a))
    anyM.adoptLogTail('p1:c1', e)
    const seeded = m.logsOf('p1', 'c1')
    expect(seeded.some(l => l.includes('恢复截断'))).toBe(true)
    expect(e.offset).toBe(statSync(file).size)

    // 300KB 无换行增量（超过 PARTIAL_MAX_BYTES=256KB）→ 强制成行并标记
    appendFileSync(file, Buffer.alloc(300 * 1024, 0x62))
    anyM.tailOnce(e)
    expect(m.logsOf('p1', 'c1').some(l => l.includes('超长行截断'))).toBe(true)
    expect(e.partial).toBe('')
  })
})

// review 修正（批次三四类）：短读只暴露已填充字节；积压轮转后保留窗口当轮消费
// 且不重播；静默大文件轮询也限容；退出路径有界尾部补读。
describe('日志限容 review 修正', () => {
  type AnyM = Record<string, unknown>

  function setup(m: ProcessManager, key: string): { e: AnyM; file: string } {
    const logDir = (m as unknown as { opts: { logDir: () => string } }).opts.logDir()
    const file = join(logDir, `${key.replace(':', '__')}.log`)
    m.logsOf(key.slice(0, key.indexOf(':')), key.slice(key.indexOf(':') + 1))
    const e = (m as unknown as { entries: Map<string, AnyM> }).entries.get(key)! as AnyM
    e.logFile = file
    e.offset = 0
    return { e, file }
  }

  function bigFile(bytes: number, tail: string): Buffer {
    const line = 'x'.repeat(63) + '\n'
    return Buffer.concat([
      Buffer.from(line.repeat(Math.ceil((bytes - tail.length - 64) / 64))),
      Buffer.from(tail)
    ])
  }

  it('review #1：readAt 短读（越过 EOF）只返回实际字节且内容精确；不存在 → null', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pt-log-'))
    const file = join(dir, 'x.log')
    writeFileSync(file, '0123456789')
    expect(readAt(file, 0, 4)?.toString()).toBe('0123')
    expect(readAt(file, 8, 10)?.toString()).toBe('89') // 只要到 2 字节
    expect(readAt(file, 0, 0)?.length).toBe(0)
    expect(readAt(join(dir, `nope-${Date.now()}`), 0, 4)).toBeNull()
  })

  it('review #2：积压超窗口 → 轮转先行 + 同轮消费保留窗口，尾部日志当轮可见', () => {
    const m = mkManager()
    const { e, file } = setup(m, 'p1:c1')
    const anyM = m as unknown as { tailOnce: (e: AnyM) => void }
    writeFileSync(file, bigFile(11 * 1024 * 1024, '尾部标记-必须当轮可见\n'))
    anyM.tailOnce(e) // 单轮：轮转（游标映射到窗口起点）+ 读窗口（2MB < 4MB 单轮上限）
    const logs = m.logsOf('p1', 'c1')
    expect(logs.some(l => l.includes('尾部标记'))).toBe(true) // 不再"磁盘上有、界面永远看不到"
    expect(readFileSync(file, 'utf8')).toContain('日志已限容') // 截断标记在文件里
    expect(statSync(file).size).toBeLessThan(3 * 1024 * 1024)
    expect(e.offset).toBe(statSync(file).size)
  })

  it('review #2：已消费接近 EOF 的轮转只读未消费部分，窗口不重播（无重复行）', () => {
    const m = mkManager()
    const { e, file } = setup(m, 'p1:c1')
    const anyM = m as unknown as { tailOnce: (e: AnyM) => void }
    const line = 'x'.repeat(63) + '\n'
    const body = Buffer.concat([
      Buffer.from(line.repeat(Math.ceil((11 * 1024 * 1024 - 128) / 64))),
      Buffer.from('唯一标记-只许出现一次\n')
    ])
    writeFileSync(file, body)
    e.offset = statSync(file).size - 40 // 该行尚未消费（40 < 行长）
    anyM.tailOnce(e)
    const hits = m.logsOf('p1', 'c1').filter(l => l.includes('唯一标记'))
    expect(hits.length).toBe(1) // 0=被跳过（旧缺陷），2=窗口重播
  })

  it('review #3：静默大文件（恢复接管后无新增）→ 轮询同样触发限容', () => {
    const m = mkManager()
    const { e, file } = setup(m, 'p1:c1')
    const anyM = m as unknown as { tailOnce: (e: AnyM) => void; adoptLogTail: (k: string, e: AnyM) => void }
    writeFileSync(file, Buffer.concat([
      Buffer.alloc(11 * 1024 * 1024, 0x7a), // 无换行主体
      Buffer.from('\n静默尾部标记\n') // 换行让标记独立成行（否则并进巨型残行被对齐丢弃）
    ]))
    anyM.adoptLogTail('p1:c1', e)
    expect(e.offset).toBe(statSync(file).size)
    anyM.tailOnce(e) // 无新增，但轮转检查先行 → 截断
    expect(statSync(file).size).toBeLessThan(3 * 1024 * 1024)
    // 已播种内容不重播：标记只出现一次
    expect(m.logsOf('p1', 'c1').filter(l => l.includes('静默尾部标记')).length).toBe(1)
  })

  it('review #2：退出路径有界补读——积压超窗口时界面能看到最新日志', () => {
    const m = mkManager()
    const { e, file } = setup(m, 'p1:c1')
    const anyM = m as unknown as { drainTail: (e: AnyM) => void }
    writeFileSync(file, bigFile(11 * 1024 * 1024, '退出前尾部标记\n'))
    anyM.drainTail(e) // 跳到尾部窗口 + 轮转先行 → 单轮完成
    const logs = m.logsOf('p1', 'c1')
    expect(logs.some(l => l.includes('退出前尾部标记'))).toBe(true)
    expect(statSync(file).size).toBeLessThan(3 * 1024 * 1024)
  })
})

// review 追加修正：跳读（<10MB 不触发轮转）时旧 partial 不得与新尾部拼接——
// 半行/半个汉字的残行随窗口对齐一并丢弃，并出现「已跳过」标记。
describe('跳读拼接修正', () => {
  type AnyM = Record<string, unknown>

  it('5MB 积压 + 半行半个汉字的旧 partial → 不拼接、有跳过标记、无替换字符', () => {
    const m = mkManager()
    const logDir = (m as unknown as { opts: { logDir: () => string } }).opts.logDir()
    const file = join(logDir, 'p1__c1.log')
    m.logsOf('p1', 'c1')
    const e = (m as unknown as { entries: Map<string, AnyM> }).entries.get('p1:c1')! as AnyM
    e.logFile = file
    e.offset = 0

    // ~4.5MB：前 2MB 常规行 → 消费到「OLD-FRAGMENT:」+ 汉字前 2 字节（半个汉字）处；
    // 之后 ~2.5MB 积压（须大于 2MB 窗口才触发跳读）；末尾是应可见的新行
    const line = 'j'.repeat(63) + '\n'
    const han = Buffer.from('汉', 'utf8') // 3 字节，取前 2 个制造半个汉字
    const body = Buffer.concat([
      Buffer.from(line.repeat(Math.ceil((2 * 1024 * 1024) / 64))),
      Buffer.from('OLD-FRAGMENT:'),
      han.subarray(0, 2), // 半个汉字：残行的一部分
      Buffer.from(line.repeat(Math.ceil((2.5 * 1024 * 1024 - 64) / 64))),
      Buffer.from('尾部新行-不得与旧片段拼接\n')
    ])
    writeFileSync(file, body)
    // 真实路径构造旧状态：把「半行 + 半个汉字」经 ingest 喂入——decoder 真正缓存
    // 这 2 个待补字节（review 建议：手动塞 partial 覆盖不到解码器内部状态）
    ;(m as unknown as { ingest: (e: AnyM, d: Buffer) => void }).ingest(
      e,
      Buffer.concat([Buffer.from('OLD-FRAGMENT:'), han.subarray(0, 2)])
    )
    expect(e.partial).toBe('OLD-FRAGMENT:') // ingest 产出的真实待成行片段
    e.offset = 2 * 1024 * 1024 + Buffer.byteLength('OLD-FRAGMENT:') + 2

    ;(m as unknown as { drainTail: (e: AnyM) => void }).drainTail(e)
    const logs = m.logsOf('p1', 'c1')
    expect(logs.some(l => l.includes('已跳过'))).toBe(true)      // 跳过标记
    expect(logs.some(l => l.includes('尾部新行'))).toBe(true)    // 尾部可见
    expect(logs.some(l => l.includes('OLD-FRAGMENT:'))).toBe(false) // 旧片段不残留
    expect(logs.some(l => l.includes('OLD-FRAGMENT:尾部新行') || l.includes('OLD-FRAGMENT:j'))).toBe(false) // 不拼接
    expect(logs.some(l => l.includes('\uFFFD'))).toBe(false)    // 半个汉字未变成替换字符
  })
})

// review P2（第二轮）：保存守卫的真值源——不看展示状态，看进程组是否仍存活。
// stop() 先同步置 stopped 再异步杀组：窗口期内 statusOf 已是 stopped，但组未消亡；
// 停止失败还会恢复运行态。守卫凭 hasLiveProcessGroup 在这两种情况下都拒绝保存
describe('hasLiveProcessGroup（保存守卫真值源）', () => {
  it('未启动 → false（可自由移除）', () => {
    const m = mkManager()
    expect(m.hasLiveProcessGroup('p1', 'c1')).toBe(false)
  })

  it('停止尚未完成（status 已 stopped、进程组仍活）→ true，守卫拒绝保存', async () => {
    const p = port()
    const proj = mkProject(p, `node ${FIXTURE} ${p} 0 ignore-term`)
    const m = mkManager({ killGraceMs: 800 })
    m.start(proj, proj.commands[0])
    await waitFor(() => m.statusOf('p1', 'c1') === 'running')
    const stopping = m.stop('p1', 'c1') // 不等待：status 同步翻 stopped，杀组在后台走
    await waitFor(() => m.statusOf('p1', 'c1') === 'stopped') // 窗口期：状态已停、组仍活
    expect(m.hasLiveProcessGroup('p1', 'c1')).toBe(true)
    // 端到端：此刻保存空命令列表会被守卫拦下
    const { removedLiveNames } = await import('../projectGuard')
    expect(removedLiveNames(proj, { ...proj, commands: [] }, cid => m.hasLiveProcessGroup('p1', cid)))
      .toEqual(['srv'])
    await stopping // 等 stop 完成（SIGKILL 兜底）→ 组确认消亡后放行
    await waitFor(() => !m.hasLiveProcessGroup('p1', 'c1'))
    expect(removedLiveNames(proj, { ...proj, commands: [] }, cid => m.hasLiveProcessGroup('p1', cid)))
      .toEqual([])
  })

  it('停止失败恢复运行态 → 仍 true（守卫拒绝保存）', async () => {
    const p = port()
    const proj = mkProject(p, `node ${FIXTURE} ${p} 0 ignore-term`)
    const m = mkManager()
    m.start(proj, proj.commands[0])
    await waitFor(() => m.statusOf('p1', 'c1') === 'running')
    const anyM = m as unknown as { signalGroup: (pid: number) => Promise<string> }
    anyM.signalGroup = async () => 'still-alive' // 模拟杀不掉（信号发出但组不消亡）
    await expect(m.stop('p1', 'c1')).rejects.toThrow()
    delete anyM.signalGroup
    expect(m.statusOf('p1', 'c1')).toBe('running') // 状态已恢复
    expect(m.hasLiveProcessGroup('p1', 'c1')).toBe(true)
  })
})

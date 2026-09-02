import { spawnSync } from 'node:child_process'

const MARKER = '__PT_PATH__'

/** 从登录 shell 输出中提取带标记的 PATH 行（容忍 shell 登录噪音） */
export function extractLoginPath(stdout: string): string | null {
  const lines = stdout.split('\n').map(l => l.trim()).filter(Boolean)
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i]
    const at = l.indexOf(MARKER)
    if (at === -1) continue
    const p = l.slice(at + MARKER.length)
    return p.includes('/') ? p : null
  }
  return null
}

/**
 * v1.1f：GUI（Finder/Dock）启动的打包应用不继承终端环境，PATH 仅为
 * /usr/bin:/bin:/usr/sbin:/sbin，用户 npm（/usr/local/bin、nvm 目录等）不可见。
 * 用登录+交互 shell 取回用户真实 PATH 并合并进 process.env（幂等：dev 模式
 * 重复合也无害，子进程 env 继承 process.env，PATH 修正自然传导到 spawn）。
 */
export function augmentPathFromLoginShell(): void {
  const shell = process.env.SHELL || '/bin/zsh'
  let out = ''
  try {
    const r = spawnSync(shell, ['-l', '-i', '-c', `echo ${MARKER}$PATH`], {
      encoding: 'utf8',
      timeout: 5000
    })
    out = r.stdout ?? ''
  } catch {
    return
  }
  const loginPath = extractLoginPath(out)
  if (loginPath) {
    process.env.PATH = `${loginPath}:${process.env.PATH ?? ''}`
  }
}

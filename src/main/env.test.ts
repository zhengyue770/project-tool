import { describe, it, expect } from 'vitest'
import { extractLoginPath } from './env'

// v1.1f：GUI（Finder/Dock）启动的打包应用不继承终端环境，PATH 只有系统默认四目录，
// npm/nvm 不可见 → command not found。主进程启动时从登录 shell 合并用户 PATH。
// augmentPathFromLoginShell 涉及真实 spawn 登录 shell，不做单测（控制器实验已证机制）；
// 这里只测纯解析函数 extractLoginPath。

describe('extractLoginPath', () => {
  it('常规：噪音行 + 带标记的 PATH 行 → 提取标记后的 PATH', () => {
    const out = 'nvm: no such file\n__PT_PATH__/usr/local/bin:/usr/bin:/bin\n'
    expect(extractLoginPath(out)).toBe('/usr/local/bin:/usr/bin:/bin')
  })

  it('多行噪音、标记行在中间 → 仍可提取', () => {
    const out = 'Last login: …\nnvm warning\n__PT_PATH__/usr/local/bin:/usr/bin\n'
      + 'some later noise\nanother noise line\n'
    expect(extractLoginPath(out)).toBe('/usr/local/bin:/usr/bin')
  })

  it('多行噪音、标记行在最后 → 提取', () => {
    const out = 'noise a\nnoise b\n__PT_PATH__/opt/homebrew/bin:/usr/local/bin'
    expect(extractLoginPath(out)).toBe('/opt/homebrew/bin:/usr/local/bin')
  })

  it('标记行后紧跟空行（shell 尾部换行）→ 正确', () => {
    const out = 'noise\n__PT_PATH__/usr/local/bin:/usr/bin\n\n'
    expect(extractLoginPath(out)).toBe('/usr/local/bin:/usr/bin')
  })

  it('无标记 → null', () => {
    expect(extractLoginPath('/usr/bin:/bin\njust noise\n')).toBeNull()
    expect(extractLoginPath('')).toBeNull()
  })

  it('标记后无 /（空或非路径）→ null', () => {
    expect(extractLoginPath('__PT_PATH__\n')).toBeNull()
    expect(extractLoginPath('__PT_PATH__not-a-path')).toBeNull()
  })
})

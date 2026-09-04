import { describe, it, expect } from 'vitest'
import { resolveAppBundle } from './installer'

// 自动更新（spec 2026-09-04 §5）：打包应用 app.getAppPath() 指向
// <bundle>/Contents/Resources/app.asar，向上三级即 .app 根，用于原地替换。

describe('resolveAppBundle', () => {
  it('打包应用（app.asar）→ .app 根', () => {
    expect(resolveAppBundle('/Applications/项目启动器.app/Contents/Resources/app.asar', true))
      .toBe('/Applications/项目启动器.app')
  })

  it('asar 解包形态（Resources/app 目录）→ 同样向上三级', () => {
    expect(resolveAppBundle('/X/Y.app/Contents/Resources/app', true)).toBe('/X/Y.app')
  })

  it('dev 模式 → null', () => {
    expect(resolveAppBundle('/code/project-tool/out/main', false)).toBeNull()
  })

  it('打包但结构不以 .app 结尾 → null（防御）', () => {
    expect(resolveAppBundle('/usr/local/lib/whatever', true)).toBeNull()
  })
})

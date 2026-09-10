import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { extractAndLocateApp, resolveAppBundle } from './installer'

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


// beta.2 实测暴露：electron-builder 的 zip 会多套一层 mac/ 目录——定位器须兼容
// 根布局（自建 zip）与嵌套布局（electron-builder zip）两种形态。
describe('extractAndLocateApp（两种 zip 布局）', () => {
  function fakeAppZip(nested: boolean): { zip: string } {
    const base = mkdtempSync(join(tmpdir(), 'pt-ext-'))
    const src = join(base, 'src')
    const app = join(nested ? join(base, 'wrap', 'mac') : src, '测试.app')
    mkdirSync(join(app, 'Contents'), { recursive: true })
    writeFileSync(join(app, 'Contents', 'Info.plist'), '{}')
    const zip = join(base, nested ? 'nested.zip' : 'root.zip')
    execFileSync('ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent',
      nested ? 'mac' : '测试.app', nested ? join(base, 'nested.zip') : zip],
      { cwd: nested ? join(base, 'wrap') : src })
    return { zip }
  }

  it('根布局 → 解压根下定位', async () => {
    const { zip } = fakeAppZip(false)
    const out = join(mkdtempSync(join(tmpdir(), 'pt-ext-')), 'o')
    const p = await extractAndLocateApp(zip, out, '测试')
    expect(p.endsWith('测试.app')).toBe(true)
    expect(p.startsWith(out)).toBe(true)
  })

  it('mac/ 嵌套布局（electron-builder 实测形态）→ 一层深定位', async () => {
    const { zip } = fakeAppZip(true)
    const out = join(mkdtempSync(join(tmpdir(), 'pt-ext-')), 'o')
    const p = await extractAndLocateApp(zip, out, '测试')
    expect(p).toBe(join(out, 'mac', '测试.app'))
  })

  it('两种布局都没有 → 抛错', async () => {
    const base = mkdtempSync(join(tmpdir(), 'pt-ext-'))
    const emptyZip = join(base, 'e.zip')
    mkdirSync(join(base, '空.app'), { recursive: true })
    execFileSync('ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', '空.app', emptyZip], { cwd: base })
    const out = join(base, 'o')
    await expect(extractAndLocateApp(emptyZip, out, '测试')).rejects.toThrow('未找到')
  })
})

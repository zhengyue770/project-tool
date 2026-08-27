import { describe, it, expect } from 'vitest'
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { StoragePaths } from './storagePaths'

function tmp(): string { return mkdtempSync(join(tmpdir(), 'pt-test-')) }

describe('StoragePaths', () => {
  it('无指针文件时返回默认目录', () => {
    const dir = tmp()
    const p = new StoragePaths(dir)
    expect(p.getDataDir()).toBe(dir)
    rmSync(dir, { recursive: true, force: true })
  })

  it('setDataDir 写指针文件且 getDataDir 返回新目录', () => {
    const dir = tmp()
    const target = tmp()
    const p = new StoragePaths(dir)
    p.setDataDir(target)
    expect(p.getDataDir()).toBe(target)
    expect(JSON.parse(readFileSync(p.pointerFile, 'utf8'))).toEqual({ dataDir: target })
    expect(p.isDefault(target)).toBe(false)
    rmSync(dir, { recursive: true, force: true }); rmSync(target, { recursive: true, force: true })
  })

  it('指针文件损坏时回退默认目录', () => {
    const dir = tmp()
    const p = new StoragePaths(dir)
    p.setDataDir('/tmp/should-not-be-used')
    writeFileSync(p.pointerFile, '{broken json')
    expect(p.getDataDir()).toBe(dir)
    rmSync(dir, { recursive: true, force: true })
  })

  it('setSessionDir 覆盖本次会话但不写指针', () => {
    const dir = tmp()
    const other = tmp()
    const p = new StoragePaths(dir)
    // 前置：先写指针指向 dir（否则指针文件不存在，无法验证“指针未变”）
    p.setDataDir(dir)
    p.setSessionDir(other)
    expect(p.getDataDir()).toBe(other)
    expect(JSON.parse(readFileSync(p.pointerFile, 'utf8')).dataDir).toBe(dir) // 指针未变
    rmSync(dir, { recursive: true, force: true }); rmSync(other, { recursive: true, force: true })
  })
})

import { describe, it, expect } from 'vitest'
import { resolveUrl, portPlaceholderNames } from './urlTemplate'
import type { CommandConfig, Project, ProjectView } from './types'

function mkCmd(partial: Partial<CommandConfig> & Pick<CommandConfig, 'id' | 'name'>): CommandConfig {
  return { cmd: 'npm run dev', workdir: '.', port: 0, ...partial }
}
function view(partial: Partial<Project> & Pick<Project, 'commands'>): ProjectView {
  return {
    id: 'p1', name: '演示项目', path: '/tmp/demo',
    urls: [], accounts: [], createdAt: 0,
    aggStatus: 'stopped', commandStates: {}, discoveredPorts: {},
    ...partial
  }
}

describe('resolveUrl（端口占位符解析）', () => {
  it('无占位符 → 原样返回（兼容既有地址）', () => {
    const r = resolveUrl('http://localhost:8080/admin', view({ commands: [mkCmd({ id: 'c1', name: '前端', port: 8080 })] }))
    expect(r).toEqual({ url: 'http://localhost:8080/admin' })
  })

  it('单命令固定模式：{{port}} 替换为配置端口', () => {
    const r = resolveUrl('http://localhost:{{port}}/x', view({ commands: [mkCmd({ id: 'c1', name: '前端', port: 5173 })] }))
    expect(r).toEqual({ url: 'http://localhost:5173/x' })
  })

  it('旧配置缺省 portMode → 按 fixed 读配置端口', () => {
    const c = mkCmd({ id: 'c1', name: '前端', port: 3000 })
    delete (c as Partial<CommandConfig>).portMode
    const r = resolveUrl('http://127.0.0.1:{{port}}', view({ commands: [c] }))
    expect(r).toEqual({ url: 'http://127.0.0.1:3000' })
  })

  it('动态模式已发现：取 discoveredPorts 实时值（而非配置 port）', () => {
    const r = resolveUrl('http://localhost:{{port}}', view({
      commands: [mkCmd({ id: 'c1', name: '前端', port: 0, portMode: 'dynamic' })],
      discoveredPorts: { c1: 5177 }
    }))
    expect(r).toEqual({ url: 'http://localhost:5177' })
  })

  it('动态模式未发现（null）→ error 提示尚未确定', () => {
    const r = resolveUrl('http://localhost:{{port}}/x', view({
      commands: [mkCmd({ id: 'c1', name: '前端', port: 0, portMode: 'dynamic' })],
      discoveredPorts: { c1: null }
    }))
    expect('error' in r).toBe(true)
    if ('error' in r) {
      expect(r.error).toContain('动态端口尚未确定')
      expect(r.error).toContain('{{port}}')
    }
  })

  it('{{port:命令名}} 按名称解析到指定命令；重名取第一条', () => {
    const r = resolveUrl('http://localhost:{{port:后端}}/api', view({
      commands: [
        mkCmd({ id: 'c1', name: '后端', port: 8080 }),
        mkCmd({ id: 'c2', name: '前端', port: 5173 })
      ]
    }))
    expect(r).toEqual({ url: 'http://localhost:8080/api' })

    const dup = resolveUrl('{{port:服务}}', view({
      commands: [
        mkCmd({ id: 'c1', name: '服务', port: 3000 }),
        mkCmd({ id: 'c2', name: '服务', port: 4000 })
      ]
    }))
    expect(dup).toEqual({ url: '3000' })
  })

  it('{{port:命令名}} 名称不存在 → error', () => {
    const r = resolveUrl('http://localhost:{{port:后端}}', view({
      commands: [mkCmd({ id: 'c1', name: '前端', port: 5173 })]
    }))
    expect('error' in r).toBe(true)
    if ('error' in r) expect(r.error).toContain('「后端」')
  })

  it('含 {{port}} 但项目没有命令 → error', () => {
    const r = resolveUrl('http://localhost:{{port}}', view({ commands: [] }))
    expect('error' in r).toBe(true)
    if ('error' in r) expect(r.error).toContain('没有命令')
  })

  it('占位符在路径中与多个占位符同串：全部替换', () => {
    const r = resolveUrl('http://host/base:{{port}}/p?ref={{port:后端}}', view({
      commands: [
        mkCmd({ id: 'c1', name: '前端', port: 5173, portMode: 'dynamic' }),
        mkCmd({ id: 'c2', name: '后端', port: 8080 })
      ],
      discoveredPorts: { c1: 5174 }
    }))
    expect(r).toEqual({ url: 'http://host/base:5174/p?ref=8080' })
  })

  it('动态命令混固定命令：各自取生效端口；动态未发现时报错', () => {
    const ok = resolveUrl('{{port:后端}}:{{port:前端}}', view({
      commands: [
        mkCmd({ id: 'c1', name: '前端', port: 0, portMode: 'dynamic' }),
        mkCmd({ id: 'c2', name: '后端', port: 8080 })
      ],
      discoveredPorts: { c1: 4000 }
    }))
    expect(ok).toEqual({ url: '8080:4000' })

    const bad = resolveUrl('{{port:后端}}:{{port:前端}}', view({
      commands: [
        mkCmd({ id: 'c1', name: '前端', port: 0, portMode: 'dynamic' }),
        mkCmd({ id: 'c2', name: '后端', port: 8080 })
      ],
      discoveredPorts: {}
    }))
    expect('error' in bad).toBe(true)
  })

  it('形似但非法的占位符（如 {{portX}}）→ 原样保留不处理', () => {
    const r = resolveUrl('http://localhost:{{portX}}/{{port}}', view({ commands: [mkCmd({ id: 'c1', name: '前端', port: 5173 })] }))
    expect(r).toEqual({ url: 'http://localhost:{{portX}}/5173' })
  })
})

describe('portPlaceholderNames（编辑对话框校验用）', () => {
  it('提取 {{port:命令名}} 引用的名称，去重保序；无名占位符与普通地址不产出', () => {
    expect(portPlaceholderNames('http://h:{{port}}/{{port:后端}}/x?{{port:后端}}&{{port:前端}}')).toEqual(['后端', '前端'])
    expect(portPlaceholderNames('http://localhost:8080')).toEqual([])
  })
})

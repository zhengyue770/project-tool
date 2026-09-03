import type { ProjectView } from './types'

// ---- v1.2：页面地址端口占位符 ----
// {{port}} → 第一条（或唯一一条）命令的生效端口；{{port:命令名}} → 按名称匹配（重名取第一条）
// 生效端口：动态模式取 discoveredPorts（实时发现值），固定模式取配置 port。
// 纯函数、渲染侧专用，点击按钮时实时解析，不改变 UrlConfig 的存储结构。

export interface ResolvedUrl { url: string }
export interface ResolveError { error: string }
export type UrlResolveResult = ResolvedUrl | ResolveError

/** 全局匹配 {{port}} 与 {{port:命令名}}；命令名不允许含 '}' */
const PORT_PLACEHOLDER_RE = /\{\{port(?::([^}]+))?\}\}/g

/** 命令的生效端口：动态模式取实时发现值（未发现为 null），固定模式取配置 port */
function portOf(c: ProjectView['commands'][number], project: ProjectView): number | null {
  if ((c.portMode ?? 'fixed') === 'dynamic') return project.discoveredPorts?.[c.id] ?? null
  return c.port
}

/**
 * 把地址模板中的端口占位符替换为实际端口。
 * 无占位符 → 原样返回（完全兼容既有地址）；
 * 占位符存在但无法解析（动态端口未发现 / 名称不存在 / 项目无命令）→ 返回中文 error（面向用户）。
 */
export function resolveUrl(template: string, project: ProjectView): UrlResolveResult {
  if (!template.includes('{{port')) return { url: template }
  let failure: string | null = null
  const url = template.replace(PORT_PLACEHOLDER_RE, (_match: string, name?: string): string => {
    const c = name !== undefined
      ? project.commands.find(x => x.name === name.trim()) // 重名取第一条（find 语义）
      : project.commands[0]
    if (!c) {
      failure = name !== undefined
        ? `找不到名为「${name.trim()}」的命令`
        : '页面地址引用了端口但项目没有命令'
      return ''
    }
    const port = portOf(c, project)
    if (!port) {
      failure = `动态端口尚未确定（项目可能未运行）：${template}`
      return ''
    }
    return String(port)
  })
  return failure ? { error: failure } : { url }
}

/**
 * 提取地址中 {{port:命令名}} 引用的命令名（trim 后去重、保持出现顺序）。
 * 供编辑对话框在保存时校验名称是否存在于命令列表；无名占位符 {{port}} 不产出。
 */
export function portPlaceholderNames(template: string): string[] {
  const names: string[] = []
  for (const m of template.matchAll(PORT_PLACEHOLDER_RE)) {
    if (m[1] === undefined) continue
    const n = m[1].trim()
    if (n && !names.includes(n)) names.push(n)
  }
  return names
}

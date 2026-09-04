import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { QuickCommand, QuickSyncSource } from '../../shared/types'

// 快捷命令扫描引擎（spec 2026-09-04-quick-commands §2/§4）：
// 四种来源纯文件解析、零依赖；文件缺失/解析失败 → 该来源静默缺席。
// 同步合并逻辑在 shared/quickSync.ts（主进程与编辑弹窗共用）。

type Scanned = { source: QuickSyncSource; name: string; cmd: string }

const withId = (s: Scanned): QuickCommand =>
  ({ id: `sync:${s.source}:${s.name}`, name: s.name, cmd: s.cmd, source: s.source })

/** 参数名含空白/引号时整体加单引号防拆词；名内单引号按 POSIX 惯用法转义
 *  （单引号内无法转义自身，用 闭引号 + \' + 重开引号 拼接，如 it's → 'it'\''s'） */
const quote = (name: string): string =>
  /[\s'"]/.test(name) ? `'${name.replace(/'/g, `'\\''`)}'` : name

// ---- package.json ----

export type PackageManager = 'npm' | 'yarn' | 'pnpm' | 'bun'

export function pickRunner(files: string[]): PackageManager {
  if (files.includes('pnpm-lock.yaml')) return 'pnpm'
  if (files.includes('yarn.lock')) return 'yarn'
  if (files.includes('bun.lockb') || files.includes('bun.lock')) return 'bun'
  return 'npm'
}

export function parsePackageJsonScripts(pkg: unknown, runner: PackageManager): Scanned[] {
  const scripts = (pkg as { scripts?: unknown })?.scripts
  if (!scripts || typeof scripts !== 'object') return []
  const out: Scanned[] = []
  for (const [name, cmd] of Object.entries(scripts as Record<string, unknown>)) {
    if (typeof cmd !== 'string') continue
    if (/^(pre|post)/.test(name)) continue // 钩子脚本不作为独立快捷命令
    out.push({ source: 'package.json', name, cmd: `${runner} run ${quote(name)}` })
  }
  return out
}

// ---- Makefile ----

/** 变量赋值行（= := ::= += ?= !=）——首段名字会被裸目标正则误捕获，先排除 */
const MAKE_ASSIGN_RE = /^\S+\s*(?:[:+?!]?=|::=)/

export function parseMakefileTargets(text: string): Scanned[] {
  const out: Scanned[] = []
  const seen = new Set<string>()
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\r$/, '')
    // 目标行：行首（列 0）名字 + 可选空白 + 冒号；排除 . 开头特殊目标、含 % 的模式规则、
    // 赋值行与注释；目标行取第一个名字（all: a b → make all）
    const m = /^([a-zA-Z0-9][a-zA-Z0-9._-]*)\s*:(?!=)/.exec(line)
    if (!m || MAKE_ASSIGN_RE.test(line) || m[1].includes('%')) continue
    if (seen.has(m[1])) continue
    seen.add(m[1])
    out.push({ source: 'Makefile', name: m[1], cmd: `make ${quote(m[1])}` })
  }
  return out
}

// ---- Justfile ----

const JUST_ASSIGN_RE = /^@\S+\s*:=|^\S+\s*:=/

export function parseJustfileRecipes(text: string): Scanned[] {
  const out: Scanned[] = []
  const seen = new Set<string>()
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\r$/, '')
    // recipe 行：列 0 起名字，其后可有参数（可含 = 与空格）再接冒号；
    // 排除 := 赋值、@/- 前缀行（内部命令）、注释
    if (line.startsWith('@') || line.startsWith('-') || line.startsWith('#')) continue
    if (JUST_ASSIGN_RE.test(line)) continue
    const m = /^([a-zA-Z0-9_][a-zA-Z0-9_+-]*)[^:#]*:/.exec(line)
    if (!m) continue
    if (seen.has(m[1])) continue
    seen.add(m[1])
    out.push({ source: 'Justfile', name: m[1], cmd: `just ${quote(m[1])}` })
  }
  return out
}

// ---- composer.json ----

export function parseComposerScripts(pkg: unknown): Scanned[] {
  const scripts = (pkg as { scripts?: unknown })?.scripts
  if (!scripts || typeof scripts !== 'object') return []
  const out: Scanned[] = []
  for (const name of Object.keys(scripts as Record<string, unknown>)) {
    // 数组型脚本（多命令串联）也算一条，执行交给 composer
    out.push({ source: 'composer.json', name, cmd: `composer run ${quote(name)}` })
  }
  return out
}

// ---- 目录级组合扫描 ----

const readJson = (p: string): unknown | null => {
  try {
    return JSON.parse(readFileSync(p, 'utf8'))
  } catch {
    return null // 缺失或损坏 → 该来源缺席
  }
}
const readText = (p: string): string | null => {
  try {
    return readFileSync(p, 'utf8')
  } catch {
    return null
  }
}

export function scanQuickCommands(projectPath: string): QuickCommand[] {
  const out: QuickCommand[] = []

  const pkgPath = join(projectPath, 'package.json')
  if (existsSync(pkgPath)) {
    const pkg = readJson(pkgPath)
    if (pkg) {
      const files = readdirSync(projectPath)
      for (const s of parsePackageJsonScripts(pkg, pickRunner(files))) out.push(withId(s))
    }
  }
  const mk = readText(join(projectPath, 'Makefile'))
  if (mk !== null) for (const s of parseMakefileTargets(mk)) out.push(withId(s))
  const just = readText(join(projectPath, 'Justfile')) ?? readText(join(projectPath, 'justfile'))
  if (just !== null) for (const s of parseJustfileRecipes(just)) out.push(withId(s))
  const composer = readJson(join(projectPath, 'composer.json'))
  if (composer) for (const s of parseComposerScripts(composer)) out.push(withId(s))

  return out
}

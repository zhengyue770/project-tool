import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  pickRunner, parsePackageJsonScripts, parseMakefileTargets,
  parseJustfileRecipes, parseComposerScripts, scanQuickCommands
} from './scan'

// 快捷命令扫描引擎（spec 2026-09-04-quick-commands §2/§4）：
// 四种来源纯文件解析 + 同步合并。解析失败/文件缺失 → 该来源静默缺席。

function tmpProject(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'pt-quick-'))
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content)
  return dir
}

describe('pickRunner（按 lockfile 判定包管理器）', () => {
  it('pnpm-lock.yaml → pnpm；yarn.lock → yarn；bun.lockb/bun.lock → bun；无/其他 → npm', () => {
    expect(pickRunner(['pnpm-lock.yaml'])).toBe('pnpm')
    expect(pickRunner(['yarn.lock'])).toBe('yarn')
    expect(pickRunner(['bun.lockb'])).toBe('bun')
    expect(pickRunner(['bun.lock'])).toBe('bun')
    expect(pickRunner(['package-lock.json'])).toBe('npm')
    expect(pickRunner(['README.md'])).toBe('npm')
    expect(pickRunner([])).toBe('npm')
  })
})

describe('parsePackageJsonScripts', () => {
  it('scripts → <runner> run <name>，保持定义顺序', () => {
    const out = parsePackageJsonScripts({ scripts: { dev: 'vite', build: 'vite build' } }, 'pnpm')
    expect(out).toEqual([
      { source: 'package.json', name: 'dev', cmd: 'pnpm run dev' },
      { source: 'package.json', name: 'build', cmd: 'pnpm run build' }
    ])
  })

  it('过滤 pre*/post* 钩子脚本', () => {
    const out = parsePackageJsonScripts(
      { scripts: { dev: 'x', predev: 'y', postdev: 'z', build: 'b' } }, 'npm')
    expect(out.map(o => o.name)).toEqual(['dev', 'build'])
  })

  it('脚本名含空格 → 参数加单引号；含单引号 → POSIX 转义，拼出的命令仍正确', () => {
    const out = parsePackageJsonScripts({ scripts: { 'my script': 'x', "it's a test": 'y' } }, 'npm')
    expect(out[0]?.cmd).toBe(`npm run 'my script'`)
    // 'it's a test' 裸包会拆词；应为 闭引号 + 反斜杠引号 + 重开引号 的惯用拼接
    expect(out[1]?.cmd).toBe(`npm run 'it'\\''s a test'`)
  })

  it('无 scripts / scripts 非对象 → 空', () => {
    expect(parsePackageJsonScripts({}, 'npm')).toEqual([])
    expect(parsePackageJsonScripts({ scripts: 'bad' }, 'npm')).toEqual([])
  })
})

describe('parseMakefileTargets', () => {
  it('解析目标（含带依赖/命令行的），排除变量赋值与 . 开头目标', () => {
    const mk = [
      'CC := gcc',                    // := 赋值 → 排除
      'FLAGS = -Wall',                // = 赋值 → 排除
      'EXTRA += -g',                  // += → 排除
      '.PHONY: build',                // . 开头 → 排除
      '.DEFAULT_GOAL := build',       // 排除
      'build: $(OBJS)',               // 目标（带依赖）✔
      '\t$(CC) main.c -o app',
      'test: build',                  // ✔
      '\t./app',
      'all: build test',              // ✔（多依赖只取名）
      '# 注释 build',                 // 注释行 → 排除
      'lint:',                        // 无依赖目标 ✔
      'gen-%.md:',                    // 模式规则（%开头段）→ 排除？名以字母开头含 %……按简单规则含 % 排除
      'echo-not-target',              // 普通行（无冒号）→ 排除
      ''
    ].join('\n')
    expect(parseMakefileTargets(mk).map(t => t.name)).toEqual(['build', 'test', 'all', 'lint'])
  })

  it('目标名只取第一个（all: build test → make all）', () => {
    const out = parseMakefileTargets('all: build test\n\t@echo hi\n')
    expect(out).toEqual([{ source: 'Makefile', name: 'all', cmd: 'make all' }])
  })
})

describe('parseJustfileRecipes', () => {
  it('解析 recipe（含参数行/依赖行），排除 := 赋值与 @ 注释行', () => {
    const jf = [
      'version := "1.0"',        // 变量 → 排除
      '@foo := 1',               // @ 前缀赋值 → 排除
      'build:',                  // ✔
      '  cargo build',
      'test *args:',             // 带参数 ✔
      '  cargo test {{args}}',
      'deploy deps: build',      // 名 + 参数名 + 依赖（首段是 recipe 名）✔
      '  ./deploy.sh',
      '# 注释',                  // 注释 → 排除
      '  indented: not-recipe',  // 缩进行是 recipe 体 → 排除
      ''
    ].join('\n')
    expect(parseJustfileRecipes(jf).map(r => r.name)).toEqual(['build', 'test', 'deploy'])
  })
})

describe('parseComposerScripts', () => {
  it('scripts → composer run <name>', () => {
    const out = parseComposerScripts({ scripts: { test: 'phpunit', 'post-install-cmd': 'x' } })
    expect(out).toEqual([
      { source: 'composer.json', name: 'test', cmd: 'composer run test' },
      { source: 'composer.json', name: 'post-install-cmd', cmd: 'composer run post-install-cmd' }
    ])
  })

  it('数组型脚本也算一条（cmd 仍是 composer run）', () => {
    const out = parseComposerScripts({ scripts: { build: ['a', 'b'] } })
    expect(out.map(o => o.name)).toEqual(['build'])
  })

  it('无 scripts → 空', () => {
    expect(parseComposerScripts({})).toEqual([])
  })
})

describe('scanQuickCommands（目录级组合扫描）', () => {
  it('四来源共存时按序合并，稳定 id 为 sync:<source>:<name>', () => {
    const dir = tmpProject({
      'package.json': JSON.stringify({ scripts: { dev: 'vite' } }),
      'package-lock.json': '',
      'Makefile': 'build:\n\t@echo b\n',
      'Justfile': 'check:\n  cargo check\n',
      'composer.json': JSON.stringify({ scripts: { test: 'phpunit' } })
    })
    const out = scanQuickCommands(dir)
    expect(out.map(q => [q.id, q.cmd])).toEqual([
      ['sync:package.json:dev', 'npm run dev'],
      ['sync:Makefile:build', 'make build'],
      ['sync:Justfile:check', 'just check'],
      ['sync:composer.json:test', 'composer run test']
    ])
  })

  it('package.json 损坏（非法 JSON）→ 该来源缺席，其余正常', () => {
    const dir = tmpProject({
      'package.json': '{ not json',
      'Makefile': 'build:\n\t@echo\n'
    })
    expect(scanQuickCommands(dir).map(q => q.source)).toEqual(['Makefile'])
  })

  it('空目录 → 空数组', () => {
    expect(scanQuickCommands(tmpProject({}))).toEqual([])
  })

  it('Justfile 大小写两种文件名都识别', () => {
    expect(scanQuickCommands(tmpProject({ justfile: 'a:\n  echo\n' })).map(q => q.source)).toEqual(['Justfile'])
  })
})

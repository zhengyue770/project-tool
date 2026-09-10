import { describe, it, expect } from 'vitest'
import type { CommandConfig, QuickCommand } from './types'
import { applySync, dropStartupDuplicates, filterExcluded, cleanExcluded } from './quickSync'

// 快捷命令同步合并（spec 2026-09-04-quick-commands §4）：
// 就地替换同步子集、保留用户排序——手动命令原位保留；同步命令仍在源头的原位更新
// （cmd 变更生效、id/位置不变），已删的移除；新增同步命令追加到末尾。
// 主进程（持久化）与编辑弹窗（刷新暂存列表）共用本函数。

const mk = (id: string, name: string, cmd: string, source: QuickCommand['source']): QuickCommand =>
  ({ id, name, cmd, source })

describe('applySync', () => {
  it('新增/删除/变更：未变与手动条目原位保留（对象引用不变），变更的原位更新', () => {
    const existing: QuickCommand[] = [
      mk('sync:package.json:dev', 'dev', 'npm run dev', 'package.json'),       // 未变
      mk('sync:package.json:old', 'old', 'npm run old', 'package.json'),       // 源头已删 → 移除
      mk('sync:package.json:build', 'build', 'npm run build', 'package.json'), // 命令变更 → 原位更新
      mk('u1', '部署', './deploy.sh', 'manual')                                 // 手动 → 原位不动
    ]
    const scanned: QuickCommand[] = [
      mk('sync:package.json:dev', 'dev', 'npm run dev', 'package.json'),
      mk('sync:package.json:build', 'build', 'pnpm run build', 'package.json'),
      mk('sync:package.json:test', 'test', 'npm run test', 'package.json')     // 新增
    ]
    const out = applySync(existing, scanned)
    expect(out).toEqual([
      existing[0],                                                              // 引用相同
      { ...existing[2], cmd: 'pnpm run build' },                                // 位置不变（第 3 位）
      existing[3],                                                              // 手动保持原位
      { id: 'sync:package.json:test', name: 'test', cmd: 'npm run test', source: 'package.json' } // 追加末尾
    ])
    expect(out[0]).toBe(existing[0])
    expect(out[2]).toBe(existing[3])
  })

  it('用户排序保留：同步命令排在手动命令前也不被冲掉', () => {
    const existing: QuickCommand[] = [
      mk('sync:Makefile:x', 'x', 'make x', 'Makefile'),
      mk('u1', 'a', 'b', 'manual'),
      mk('sync:package.json:dev', 'dev', 'npm run dev', 'package.json')
    ]
    const out = applySync(existing, [
      mk('sync:package.json:dev', 'dev', 'npm run dev', 'package.json'),
      mk('sync:Makefile:x', 'x', 'make x', 'Makefile')
    ])
    expect(out.map(q => q.id)).toEqual(['sync:Makefile:x', 'u1', 'sync:package.json:dev'])
  })

  it('脚本改名 = 删旧+新增（id 含名字，自然落到末尾）', () => {
    const out = applySync(
      [mk('sync:package.json:old', 'old', 'npm run old', 'package.json')],
      [mk('sync:package.json:new', 'new', 'npm run new', 'package.json')]
    )
    expect(out.map(q => q.id)).toEqual(['sync:package.json:new'])
  })

  it('existing 为空 → scanned 原样；scanned 为空 → 仅剩手动', () => {
    expect(applySync(undefined, [mk('sync:Makefile:x', 'x', 'make x', 'Makefile')]))
      .toEqual([mk('sync:Makefile:x', 'x', 'make x', 'Makefile')])
    const manual = mk('u1', 'a', 'b', 'manual')
    expect(applySync([manual, mk('sync:package.json:dev', 'dev', 'npm run dev', 'package.json')], []))
      .toEqual([manual])
  })
})

describe('dropStartupDuplicates（与启动命令重复的同步命令不导入）', () => {
  const cmd = (cmdline: string, workdir = '.'): CommandConfig =>
    ({ id: 'c1', name: 'srv', cmd: cmdline, workdir, port: 3000 })
  const scanned = (name: string, cmdline: string): QuickCommand =>
    ({ id: `sync:package.json:${name}`, name, cmd: cmdline, source: 'package.json' })

  it('命令一致且启动命令也在项目根 → 跳过该同步命令', () => {
    const out = dropStartupDuplicates(
      [cmd('npm run dev')],
      [scanned('dev', 'npm run dev'), scanned('build', 'npm run build')]
    )
    expect(out.map(q => q.name)).toEqual(['build'])
  })

  it('启动命令在子目录执行（workdir 非 .）→ 不算重复，保留同步命令', () => {
    const out = dropStartupDuplicates(
      [cmd('npm run dev', 'web')],
      [scanned('dev', 'npm run dev')]
    )
    expect(out.map(q => q.name)).toEqual(['dev'])
  })

  it('命令不同 / 无启动命令 → 全保留', () => {
    expect(dropStartupDuplicates([cmd('npm start')], [scanned('dev', 'npm run dev')])).toHaveLength(1)
    expect(dropStartupDuplicates([], [scanned('dev', 'npm run dev')])).toHaveLength(1)
  })

  it('hardening 1a：同步命令带引号与启动命令裸名视为同一（同 runner）', () => {
    const out = dropStartupDuplicates(
      [cmd('npm run dev')],
      [scanned('dev', `npm run 'dev'`), scanned('build', `npm run 'build'`)]
    )
    expect(out.map(q => q.name)).toEqual(['build'])
  })

  it('hardening 1a：不同 runner 不判重', () => {
    const out = dropStartupDuplicates([cmd('npm run dev')], [scanned('dev', `pnpm run 'dev'`)])
    expect(out).toHaveLength(1)
  })

  it('hardening 1a：非生成形式不判重（npm 裸名 / yarn add / 含操作符 / 多段）', () => {
    // npm 裸名不是 run 语法（npm 只有 start/test 等内置别名）
    expect(dropStartupDuplicates([cmd('npm dev')], [scanned('dev', `npm run 'dev'`)])).toHaveLength(1)
    // 内置命令不是脚本
    expect(dropStartupDuplicates([cmd('yarn add x')], [scanned('add', `yarn run 'add'`)])).toHaveLength(1)
    // 含操作符/附加参数：无法确认等价，宁可不去重
    expect(dropStartupDuplicates([cmd('npm run dev;echo hi')], [scanned('dev', `npm run 'dev'`)])).toHaveLength(1)
    expect(dropStartupDuplicates([cmd('npm run dev -- --inspect')], [scanned('dev', `npm run 'dev'`)])).toHaveLength(1)
    expect(dropStartupDuplicates([cmd('NODE_ENV=prod npm run dev')], [scanned('dev', `npm run 'dev'`)])).toHaveLength(1)
  })

  it('review 修正：裸名含括号（foo(bar)，sh 语法错误）→ 不判重；带引号的同名仍判重', () => {
    // 裸 foo(bar) 在 /bin/sh 中是语法错误，不能与合法的带引号形式判等
    expect(dropStartupDuplicates([cmd('npm run foo(bar)')], [scanned('x', `npm run 'foo(bar)'`)])).toHaveLength(1)
    // 双方都是带引号的合法形式 → 正常判重
    expect(dropStartupDuplicates([cmd(`npm run 'foo(bar)'`)], [scanned('x', `npm run 'foo(bar)'`)])).toHaveLength(0)
  })
})

describe('排除列表（同步命令可删除，同步时不再加回）', () => {
  const q = (id: string): QuickCommand =>
    ({ id, name: id.split(':').pop()!, cmd: 'x', source: 'package.json' })

  it('filterExcluded：命中排除 id 的扫描命令被滤掉', () => {
    const scanned = [q('sync:package.json:dev'), q('sync:package.json:build')]
    expect(filterExcluded(scanned, ['sync:package.json:dev']).map(x => x.id))
      .toEqual(['sync:package.json:build'])
    expect(filterExcluded(scanned, [])).toHaveLength(2)
  })

  it('cleanExcluded：源文件已不存在的排除项被清理（脚本删掉又加回时重新出现是预期行为）', () => {
    const scanned = [q('sync:package.json:dev')]
    expect(cleanExcluded(['sync:package.json:dev', 'sync:package.json:gone', 'sync:Makefile:x'], scanned))
      .toEqual(['sync:package.json:dev'])
    expect(cleanExcluded(['sync:package.json:gone'], scanned)).toEqual([])
  })
})

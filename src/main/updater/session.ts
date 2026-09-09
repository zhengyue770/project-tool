import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

// hardening 2c：更新备份的「记录式清理」。会话目录 / 备份容器 / 暂存容器都与
// 同一 token 绑定并独占创建；删除只在四条件全满足且无符号链接时发生——
// 无法确认时保留数据并报告，不为自动清理而猜测。

export interface UpdateRecord {
  token: string
  oldVersion: string
  newVersion: string
  /** 应用 bundle 绝对路径 */
  appPath: string
  /** 备份容器路径（<appPath>.old.<token>） */
  backup: string
}

export const TOKEN_RE = /^[a-z0-9]{16,}$/
export function newToken(): string { return randomUUID().replace(/-/g, '').slice(0, 16) }

export function sessionsRoot(userDataDir: string): string {
  return join(userDataDir, 'update-sessions')
}
export function sessionDirOf(userDataDir: string, token: string): string {
  return join(sessionsRoot(userDataDir), token)
}
export function backupOf(appPath: string, token: string): string {
  return `${appPath}.old.${token}`
}
export function stagingOf(appPath: string, token: string): string {
  return `${appPath}.new.${token}`
}

function isSymlink(p: string): boolean {
  try { return lstatSync(p).isSymbolicLink() } catch { return false }
}

/** 独占创建一次更新会话：会话目录、备份容器、暂存容器三者都新建成功才返回；
 *  任何位置已存在（token 撞上残留 / 应用旁有异物）→ 返回 null，本次更新中止 */
export function openUpdateSession(
  userDataDir: string, appPath: string, oldVersion: string, newVersion: string,
  token = newToken()
): { record: UpdateRecord; sessionDir: string } | null {
  const sessionDir = sessionDirOf(userDataDir, token)
  const backup = backupOf(appPath, token)
  const staging = stagingOf(appPath, token)
  const created: string[] = []
  try {
    mkdirSync(sessionsRoot(userDataDir), { recursive: true })
    mkdirSync(sessionDir) // 非递归：已存在即失败
    created.push(sessionDir)
    mkdirSync(backup)
    created.push(backup)
    mkdirSync(staging)
    created.push(staging)
    const record: UpdateRecord = { token, oldVersion, newVersion, appPath, backup }
    writeFileSync(join(sessionDir, 'record.json'), JSON.stringify(record, null, 2))
    return { record, sessionDir }
  } catch {
    // 只清理本次独占创建成功的目录（顺序无关，rmSync 容忍缺失）
    for (const d of created) {
      try { rmSync(d, { recursive: true, force: true }) } catch { /* 残留待报告 */ }
    }
    return null
  }
}

export interface CleanupReport {
  removed: string[]
  kept: Array<{ dir: string; reason: string }>
}

/** 新版启动、基本初始化成功后调用：逐会话按四条件判定（应用路径、版本、
 *  phase=applied、备份路径推导一致）+ 边界符号链接拒绝；全过才删备份容器与会话
 *  目录。任何不确定 → 保留并给出原因，绝不为了清理而猜测 */
export function cleanupUpdateSessions(
  userDataDir: string, currentAppPath: string, currentVersion: string
): CleanupReport {
  const removed: string[] = []
  const kept: Array<{ dir: string; reason: string }> = []
  let names: string[]
  try {
    names = readdirSync(sessionsRoot(userDataDir))
  } catch {
    return { removed, kept } // 无会话目录（从未更新过）
  }
  for (const name of names) {
    const dir = join(sessionsRoot(userDataDir), name)
    const keep = (reason: string): void => { kept.push({ dir, reason }) }
    try {
      if (!TOKEN_RE.test(name)) { keep('会话目录名不符合 token 格式'); continue }
      if (isSymlink(dir)) { keep('会话目录是符号链接'); continue }
      const rec = JSON.parse(readFileSync(join(dir, 'record.json'), 'utf8')) as UpdateRecord
      if (!rec || rec.token !== name) { keep('记录缺失或 token 与目录不符'); continue }
      if (rec.appPath !== currentAppPath) { keep('应用路径与当前不一致'); continue }
      if (rec.newVersion !== currentVersion) { keep('版本与当前不一致（更新未完成或另有版本）'); continue }
      const phasePath = join(dir, 'phase')
      if (!existsSync(phasePath)) { keep('无 phase 标记（更新可能未完成）'); continue }
      const phase = readFileSync(phasePath, 'utf8').trim()
      if (phase !== 'applied') { keep(`更新阶段为 ${phase || '空'}`); continue }
      if (rec.backup !== backupOf(currentAppPath, name)) { keep('备份路径与推导不一致'); continue }
      const prev = join(rec.backup, 'prev.app')
      if (isSymlink(rec.backup) || isSymlink(prev)) { keep('备份边界路径是符号链接'); continue }
      if (!existsSync(prev)) { keep('备份内无 prev.app'); continue }
      // 四条件全满足：删除备份容器与会话目录（失败不阻断启动）
      rmSync(rec.backup, { recursive: true, force: true })
      rmSync(dir, { recursive: true, force: true })
      removed.push(rec.backup)
    } catch (err) {
      keep(`无法确认：${(err as Error).message}`)
    }
  }
  return { removed, kept }
}

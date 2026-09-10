import { execFile, spawn } from 'node:child_process'
import { accessSync, constants, existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'

// 自动更新（spec 2026-09-04 §5）：解压用 macOS 原生 ditto（保留签名与 bundle 元数据）；
// 替换由 detached 脚本完成：等旧进程退出 → 备份旧 .app → 新 .app 就位（失败回滚）→ 重启。
// macOS 允许移动运行中的 .app（内核持有旧 inode），等待只是保险。

const execFileAsync = promisify(execFile)

/** app.getAppPath()（打包后指向 <bundle>/Contents/Resources/app.asar）→ .app 根；dev 返回 null */
export function resolveAppBundle(appPath: string, isPackaged: boolean): string | null {
  if (!isPackaged) return null
  const bundle = dirname(dirname(dirname(appPath)))
  return bundle.endsWith('.app') ? bundle : null
}

/** 目录不可写时抛错（提前暴露权限问题，避免下载完才失败） */
export function ensureDirWritable(dir: string): void {
  accessSync(dir, constants.W_OK)
}

/** 解压 zip 到 destDir 并返回其中的 .app 路径；结构异常时抛错。
 *  实测发现的两种布局都认：electron-builder 的 zip 会多套一层 mac/ 目录
 *  （beta.2 实测暴露），自建 zip 则位于根目录——先找根，再找恰好一层深 */
export async function extractAndLocateApp(zipPath: string, destDir: string, appName: string): Promise<string> {
  mkdirSync(destDir, { recursive: true }) // update-cache 启动即清空，解压前自建
  await execFileAsync('ditto', ['-x', '-k', zipPath, destDir])
  const want = `${appName}.app`
  if (existsSync(join(destDir, want))) return join(destDir, want)
  for (const name of readdirSync(destDir)) {
    const nested = join(destDir, name, want)
    if (existsSync(nested)) return nested
  }
  throw new Error(`安装包内容异常：未找到 ${want}`)
}

/** 一次更新替换的完整计划（hardening 2c）：路径均由主进程在 spawn 前确定 */
export interface InstallPlan {
  appPid: number
  bundlePath: string
  /** 缓存里解压出的新 .app */
  extractedApp: string
  /** 应用同盘暂存容器内的目标位置 <bundle>.new.<token>/app */
  stagingApp: string
  /** 备份容器内固定子路径 <bundle>.old.<token>/prev.app */
  backupPrev: string
  sessionDir: string
}

/** detached 启动替换脚本（立即返回）；调用方随后经退出网关退出应用 */
export function installAndRelaunch(plan: InstallPlan): void {
  const scriptPath = join(plan.sessionDir, 'apply.sh')
  writeFileSync(scriptPath, buildInstallScript(), { mode: 0o755 })
  const child = spawn('/bin/bash', [
    scriptPath,
    String(plan.appPid), plan.bundlePath, plan.extractedApp,
    plan.stagingApp, plan.backupPrev, plan.sessionDir
  ], {
    detached: true,
    stdio: 'ignore'
  })
  child.unref()
}

// 参数：$1=旧应用 pid，$2=当前 .app，$3=缓存中的新 .app，$4=暂存目标，$5=备份目标，$6=会话目录
// hardening 2c 流程：等退出(超时中止不动 BUNDLE) → 同盘暂存+结构检查 → 旧版入备份容器
// → 新版就位(同盘 rename) → 失败时回滚(前置检查目标不存在) → 成功写 phase=applied → 重启
function buildInstallScript(): string {
  return `#!/bin/bash
PID="$1"; BUNDLE="$2"; NEW_APP="$3"; STAGE_APP="$4"; BACKUP_PREV="$5"; SESSION="$6"

# 等待旧应用退出（上限 30 秒；超时中止更新，不碰 BUNDLE——退出网关未完成确认时不替换）
for i in $(seq 1 150); do
  kill -0 "$PID" 2>/dev/null || break
  sleep 0.2
done
if kill -0 "$PID" 2>/dev/null; then
  osascript -e 'display notification "更新中止：应用未能及时退出，未做任何更改" with title "项目启动器"'
  exit 1
fi
sleep 0.3

# 暂存先行：新版移入应用所在磁盘的独占容器（跨盘复制失败只污染暂存容器，不碰 BUNDLE）
if ! mv "$NEW_APP" "$STAGE_APP"; then
  osascript -e 'display notification "更新中止：新版暂存失败，未改动应用（缓存解压产物已保留）" with title "项目启动器"'
  exit 1
fi
if [ ! -f "$STAGE_APP/Contents/Info.plist" ]; then
  osascript -e 'display notification "更新中止：暂存的新版结构异常，未改动应用" with title "项目启动器"'
  exit 1
fi

# 旧版移入备份容器固定子路径（容器由主进程独占创建且为空，mv 无"移入已有目录"歧义）
if ! mv "$BUNDLE" "$BACKUP_PREV"; then
  osascript -e 'display notification "更新失败：无法备份当前应用（可能权限不足），未做改动，请手动处理" with title "项目启动器"'
  exit 1
fi

# 新版就位：同盘 rename，无"复制一半"窗口
if mv "$STAGE_APP" "$BUNDLE"; then
  echo applied > "$SESSION/phase"
  open "$BUNDLE"
else
  # 回滚前置检查：目标存在且无法确认归属（跨盘残留等）→ 保留全部文件并报告，不 mv
  if [ ! -e "$BUNDLE" ]; then
    if mv "$BACKUP_PREV" "$BUNDLE"; then
      open "$BUNDLE"
      osascript -e 'display notification "更新失败：新版未能就位，已恢复原版本" with title "项目启动器"'
    else
      osascript -e "display notification \"更新失败且恢复失败，已保留全部文件：\$BACKUP_PREV\" with title \"项目启动器\""
    fi
  else
    osascript -e "display notification \"更新失败且目标位置已有未知内容，已保留全部文件（\$BACKUP_PREV），请手动处理\" with title \"项目启动器\""
  fi
fi
`
}

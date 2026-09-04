import { execFile, spawn } from 'node:child_process'
import { accessSync, constants, existsSync, mkdirSync, writeFileSync } from 'node:fs'
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

/** 解压 zip 到 destDir 并返回其中的 .app 路径；结构异常时抛错 */
export async function extractAndLocateApp(zipPath: string, destDir: string, appName: string): Promise<string> {
  mkdirSync(destDir, { recursive: true }) // update-cache 启动即清空，解压前自建
  await execFileAsync('ditto', ['-x', '-k', zipPath, destDir])
  const appPath = join(destDir, `${appName}.app`)
  if (!existsSync(appPath)) throw new Error(`安装包内容异常：未找到 ${appName}.app`)
  return appPath
}

/** detached 启动替换脚本（立即返回）；调用方随后 app.quit() */
export function installAndRelaunch(bundlePath: string, extractedApp: string, appPid: number): void {
  const scriptPath = join(dirname(extractedApp), 'apply-update.sh')
  writeFileSync(scriptPath, buildInstallScript(), { mode: 0o755 })
  const child = spawn('/bin/bash', [scriptPath, String(appPid), bundlePath, extractedApp], {
    detached: true,
    stdio: 'ignore'
  })
  child.unref()
}

// 参数：$1=旧应用 pid，$2=当前 .app 路径，$3=新 .app 路径（argv 传入，脚本内全引号）
function buildInstallScript(): string {
  return `#!/bin/bash
# 「项目启动器」自动更新替换脚本（由应用生成，随 update-cache 在下次启动时清理）
PID="$1"; BUNDLE="$2"; NEW_APP="$3"
for i in $(seq 1 150); do
  kill -0 "$PID" 2>/dev/null || break
  sleep 0.2
done
sleep 0.3
BACKUP="$BUNDLE.old"
if ! mv "$BUNDLE" "$BACKUP" 2>/dev/null; then
  osascript -e 'display notification "更新失败：无法替换应用（可能权限不足），请到 GitHub Releases 手动下载新版本" with title "项目启动器"'
  exit 1
fi
if mv "$NEW_APP" "$BUNDLE"; then
  rm -rf "$BACKUP" &
  open "$BUNDLE"
else
  mv "$BACKUP" "$BUNDLE"
  osascript -e 'display notification "更新失败：新版本未能就位，已恢复原版本" with title "项目启动器"'
  open "$BUNDLE"
fi
`
}

import type { CommandConfig } from '../../shared/types'

export function healthUrlOf(c: CommandConfig): string {
  return c.healthCheckUrl?.trim() || `http://127.0.0.1:${c.port}`
}

/** 任何 HTTP 响应（不限状态码）都视为端口有服务；连接失败/超时为 false */
export async function probe(url: string, timeoutMs = 2000): Promise<boolean> {
  try {
    await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
    return true
  } catch {
    return false
  }
}

/** v1.1g: 从 URL 尾部提取端口（只取尾部数字，避免 URL 解析对边缘地址报错）；无端口为 null */
export function portFromUrl(url: string): number | null {
  const m = /(\d+)$/.exec(url)
  return m ? Number(m[1]) : null
}

/** 端口探测：依次尝试 IPv4 与 IPv6 回环，任一有 HTTP 响应即通（vite 等默认绑 localhost，部分机器只落 ::1） */
export async function probePort(port: number, timeoutMs = 2000): Promise<boolean> {
  if (await probe(`http://127.0.0.1:${port}`, timeoutMs)) return true
  return probe(`http://[::1]:${port}`, timeoutMs)
}

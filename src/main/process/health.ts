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

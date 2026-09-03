import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import http from 'node:http'
import { healthUrlOf, probe, probePort, portFromUrl } from './health'

let server: http.Server
let port = 0

beforeAll(async () => {
  server = http.createServer((_req, res) => res.end('ok'))
  await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()))
  port = (server.address() as { port: number }).port
})
afterAll(() => server.close())

describe('healthUrlOf', () => {
  it('默认用 127.0.0.1:{port}', () =>
    expect(healthUrlOf({ id: 'c', name: 'n', cmd: 'x', workdir: '.', port: 8080 })).toBe('http://127.0.0.1:8080'))
  it('healthCheckUrl 优先', () =>
    expect(healthUrlOf({ id: 'c', name: 'n', cmd: 'x', workdir: '.', port: 8080, healthCheckUrl: 'http://x/health' })).toBe('http://x/health'))
})

describe('probe', () => {
  it('端口有服务响应 → true', async () =>
    expect(await probe(`http://127.0.0.1:${port}`)).toBe(true))
  it('端口无服务 → false', async () =>
    expect(await probe('http://127.0.0.1:59999')).toBe(false))
  it('服务不响应时按超时返回 false', async () => {
    const silent = http.createServer(() => undefined) // 收到请求也永不响应
    await new Promise<void>(r => silent.listen(0, '127.0.0.1', () => r()))
    const p = (silent.address() as { port: number }).port
    expect(await probe(`http://127.0.0.1:${p}`, 300)).toBe(false)
    silent.close()
  })
})

describe('probePort（双栈）', () => {
  it('服务仅绑 ::1 时仍探测成功（复现 bug 场景）', async () => {
    const s6 = http.createServer((_q, res) => res.end('ok'))
    await new Promise<void>(r => s6.listen(0, '::1', () => r()))
    const p = (s6.address() as { port: number }).port
    expect(await probe(`http://127.0.0.1:${p}`, 500)).toBe(false) // 记录 IPv4 侧确实不通（bug 证据）
    expect(await probePort(p)).toBe(true)                          // 双栈探测成功
    s6.close()
  })
  it('服务绑 127.0.0.1 时成功', async () => {
    const s4 = http.createServer((_q, res) => res.end('ok'))
    await new Promise<void>(r => s4.listen(0, '127.0.0.1', () => r()))
    const p = (s4.address() as { port: number }).port
    expect(await probePort(p)).toBe(true)
    s4.close()
  })
  it('无服务端口为 false', async () => expect(await probePort(59998, 300)).toBe(false))
})

describe('portFromUrl', () => {
  it('从 URL 尾部解析端口', () =>
    expect(portFromUrl('http://127.0.0.1:3000')).toBe(3000))
  it('无端口返回 null', () =>
    expect(portFromUrl('http://example.com/')).toBeNull())
  it('空串返回 null', () =>
    expect(portFromUrl('')).toBeNull())
})

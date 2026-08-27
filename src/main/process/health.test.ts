import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import http from 'node:http'
import { healthUrlOf, probe } from './health'

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

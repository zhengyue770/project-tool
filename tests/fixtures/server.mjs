import http from 'node:http'
import { spawn } from 'node:child_process'

// argv[2] === 'auto' 时由 OS 分配随机端口（动态端口模式测试用），其余行为与固定端口完全一致
const auto = process.argv[2] === 'auto'
const port = auto ? 0 : Number(process.argv[2])
const delay = Number(process.argv[3] || 0)
const stubborn = process.argv[4] === 'ignore-term'

const baby = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
console.log(`GRANDCHILD_PID:${baby.pid}`)

if (stubborn) process.on('SIGTERM', () => console.log('ignored SIGTERM'))

setTimeout(() => {
  const server = http.createServer((req, res) => res.end('ok'))
  server.listen(port, '127.0.0.1', () => {
    const realPort = auto ? server.address().port : port
    if (auto) console.log(`Local:   http://localhost:${realPort}/`)
    else console.log(`LISTENING:${port}`)
    setInterval(() => console.log(`heartbeat ${realPort}`), 400)
  })
}, delay)

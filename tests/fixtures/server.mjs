import http from 'node:http'
import { spawn } from 'node:child_process'

const port = Number(process.argv[2])
const delay = Number(process.argv[3] || 0)
const stubborn = process.argv[4] === 'ignore-term'

const baby = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
console.log(`GRANDCHILD_PID:${baby.pid}`)

if (stubborn) process.on('SIGTERM', () => console.log('ignored SIGTERM'))

setTimeout(() => {
  const server = http.createServer((req, res) => res.end('ok'))
  server.listen(port, '127.0.0.1', () => {
    console.log(`LISTENING:${port}`)
    setInterval(() => console.log(`heartbeat ${port}`), 400)
  })
}, delay)

import { execFile } from 'node:child_process'

export const command = (file, args, { input, timeout = 10_000 } = {}) => new Promise(resolve => {
  const child = execFile(file, args, {
    encoding: 'buffer', timeout, maxBuffer: 2 * 1024 * 1024,
    env: { ...process.env, TERM: process.env.TERM || 'xterm-256color', SHLVL: '1' },
  }, (error, stdout, stderr) => resolve({ code: error ? error.code ?? 1 : 0, stdout, stderr }))
  child.stdin?.on('error', () => {})
  child.stdin?.end(input)
})

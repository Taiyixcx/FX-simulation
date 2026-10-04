import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { spawn } from 'node:child_process'

// Vite's temporary SSR modules must be readable by every test worker. Keep the
// cache in the project instead of an isolated Windows sandbox temp directory.
const temporaryDirectory = resolve('.vite/test-tmp')
await mkdir(temporaryDirectory, { recursive: true })
const child = spawn(process.execPath, [resolve('node_modules/vitest/vitest.mjs'), 'run', ...process.argv.slice(2)], {
  cwd: process.cwd(),
  env: { ...process.env, TEMP: temporaryDirectory, TMP: temporaryDirectory, TMPDIR: temporaryDirectory },
  stdio: 'inherit',
  shell: false,
  windowsHide: true,
})
child.once('error', error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1 })
child.once('exit', code => { process.exitCode = code ?? 1 })
process.once('SIGINT', () => child.kill('SIGINT'))
process.once('SIGTERM', () => child.kill('SIGTERM'))

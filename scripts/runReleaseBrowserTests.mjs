import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { spawn } from 'node:child_process'

const project = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
const releaseDirectory = process.env.FX_E2E_RELEASE_DIR ?? resolve(`release/FX-practice-room-${project.version}-win-x64`)
const child = spawn(process.execPath, [resolve('node_modules/@playwright/test/cli.js'), 'test', 'tests/e2e/releaseDistribution.spec.ts', ...process.argv.slice(2)], {
  cwd: process.cwd(),
  env: { ...process.env, FX_E2E_RELEASE_DIR: releaseDirectory },
  stdio: 'inherit',
  shell: false,
  windowsHide: true,
})
child.once('error', error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1 })
child.once('exit', code => { process.exitCode = code ?? 1 })
process.once('SIGINT', () => child.kill('SIGINT'))
process.once('SIGTERM', () => child.kill('SIGTERM'))

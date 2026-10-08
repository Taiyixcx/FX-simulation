import { basename, resolve } from 'node:path'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { createServer, preview } from 'vite'

/** Validate the distributed files independently of the checkout and its Node/npm. */
async function startReleaseServer(releaseZipPath: string): Promise<() => Promise<void>> {
  const validationRoot = resolve('.vite/release-validation')
  await mkdir(validationRoot, { recursive: true })
  const extractedDirectory = await mkdtemp(resolve(validationRoot, '发行验收 中文与空格-'))
  await new Promise<void>((resolveExtracted, reject) => {
    const child = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
      '$ErrorActionPreference = "Stop"; Add-Type -AssemblyName System.IO.Compression.FileSystem; [System.IO.Compression.ZipFile]::ExtractToDirectory($env:FX_RELEASE_ZIP, $env:FX_RELEASE_EXTRACT)'], {
      windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, FX_RELEASE_ZIP: resolve(releaseZipPath), FX_RELEASE_EXTRACT: extractedDirectory },
    })
    let output = ''
    child.stdout.on('data', chunk => { output += String(chunk) })
    child.stderr.on('data', chunk => { output += String(chunk) })
    child.once('error', reject)
    child.once('exit', code => code === 0 ? resolveExtracted() : reject(new Error(`发行 ZIP 解压失败（${code}）：${output}`)))
  })
  const isolatedDirectory = resolve(extractedDirectory, basename(releaseZipPath, '.zip'))
  await mkdir(resolve(isolatedDirectory, 'imports'))
  await writeFile(resolve(isolatedDirectory, 'imports/private-release-check.csv'), 'private test input,not a public runtime resource\n', 'utf8')
  const child = spawn(resolve(isolatedDirectory, 'runtime/node.exe'), ['scripts/startLocal.mjs', '--no-open'], {
    cwd: isolatedDirectory,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PATH: resolve(isolatedDirectory, 'runtime') },
  })
  let output = ''
  const closed = new Promise<void>((resolveClosed) => child.once('close', () => resolveClosed()))
  try {
    await new Promise<void>((resolveStarted, reject) => {
      const timeout = setTimeout(() => { reject(new Error(`发行包启动超时：${output}`)) }, 10_000)
      const finish = (error?: Error) => { clearTimeout(timeout); if (error) reject(error); else resolveStarted() }
      child.once('error', finish)
      child.once('exit', code => finish(new Error(`发行包启动提前结束（${code}）：${output}`)))
      const collect = (chunk: Buffer) => {
        output += String(chunk)
        if (output.includes('http://127.0.0.1:4173')) finish()
      }
      child.stdout.on('data', collect)
      child.stderr.on('data', collect)
    })
  } catch (error) {
    child.kill()
    await closed
    throw error
  }
  return async () => {
    child.kill()
    await closed
  }
}

/** Own the test server in this process, avoiding npm/cmd descendants on Windows. */
export default async function startTestServer(): Promise<() => Promise<void>> {
  const releaseZipPath = process.env.FX_E2E_RELEASE_ZIP ?? (process.env.FX_E2E_RELEASE_DIR ? `${resolve(process.env.FX_E2E_RELEASE_DIR)}.zip` : undefined)
  if (releaseZipPath) return startReleaseServer(releaseZipPath)
  const configFile = resolve('vite.config.ts')
  if (process.env.FX_E2E_PREVIEW === '1') {
    const server = await preview({ configFile })
    return async () => {
      if ('closeAllConnections' in server.httpServer && typeof server.httpServer.closeAllConnections === 'function') server.httpServer.closeAllConnections()
      await new Promise<void>((resolveClose, reject) => {
        server.httpServer.close(error => error ? reject(error) : resolveClose())
      })
    }
  }
  const server = await createServer({ configFile })
  try { await server.listen() } catch (error) { await server.close(); throw error }
  return async () => {
    if (server.httpServer && 'closeAllConnections' in server.httpServer && typeof server.httpServer.closeAllConnections === 'function') server.httpServer.closeAllConnections()
    await server.close()
  }
}

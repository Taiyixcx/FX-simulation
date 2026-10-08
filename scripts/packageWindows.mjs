import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { access, copyFile, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { pipeline } from 'node:stream/promises'
import { spawn } from 'node:child_process'

const PROJECT_DIRECTORY = fileURLToPath(new URL('../', import.meta.url))
export const WINDOWS_RUNTIME = Object.freeze({
  version: '24.21.0',
  archive: 'node-v24.21.0-win-x64.zip',
  archiveSha256: '158f7685b44de51f6c0df1d153526cbcd3e1bc739a8dfc607721cef75de9e541',
  executableSha256: 'ba4e6d110e8c1592a1ecd390f6b05f3da124b13871a5be62b341a07a853c6c32',
  sourceUrl: 'https://nodejs.org/dist/v24.21.0/',
})

export function portableLauncher() {
  return '@echo off\nchcp 65001 >nul\ncd /d "%~dp0"\n"%~dp0runtime\\node.exe" "%~dp0scripts\\startLocal.mjs" %*\nif errorlevel 1 (\n  echo.\n  pause\n  exit /b 1\n)\n'
}

const LICENSE_FILES = new Set([
  'decimal-LICENSE.txt', 'echarts-d3-LICENSE.txt', 'echarts-LICENSE.txt', 'echarts-NOTICE.txt',
  'inter-LICENSE.txt', 'pinia-LICENSE.txt', 'tslib-LICENSE.txt', 'tslib-NOTICE.txt',
  'vue-LICENSE.txt', 'zrender-LICENSE.txt',
])
const EXCLUDED_LOCAL_FILES = new Set([
  'data/README.md', 'data/manifest.json', 'data/simulation-calibration.json',
  'data/eurusd-20240304-08.csv', 'data/eurusd-20240304-08.csv.metadata.json',
  'data/gbpusd-20240304-08.csv', 'data/gbpusd-20240304-08.csv.metadata.json',
])

export async function hashFile(filePath) {
  const hash = createHash('sha256')
  for await (const bytes of createReadStream(filePath)) hash.update(bytes)
  return hash.digest('hex')
}

export async function listRegularFiles(directory) {
  const files = []
  async function visit(currentDirectory) {
    for (const entry of await readdir(currentDirectory, { withFileTypes: true })) {
      const entryPath = join(currentDirectory, entry.name)
      if (entry.isSymbolicLink()) throw new Error(`不能打包符号链接：${entryPath}`)
      if (entry.isDirectory()) await visit(entryPath)
      else if (entry.isFile()) files.push(relative(directory, entryPath).split(sep).join('/'))
      else throw new Error(`不能打包特殊文件：${entryPath}`)
    }
  }
  if (!(await lstat(directory)).isDirectory() || (await lstat(directory)).isSymbolicLink()) throw new Error('打包目录必须是普通目录。')
  await visit(directory)
  return files.sort()
}

/** Explicit build allowlist: unknown files stop packaging; known personal samples stay on this machine. */
export async function collectPublicFiles(distDirectory) {
  const files = await listRegularFiles(distDirectory)
  const selected = []
  for (const file of files) {
    if (EXCLUDED_LOCAL_FILES.has(file)) continue
    const asset = /^assets\/(?:index-[A-Za-z0-9_-]{6,32}\.(?:js|css)|inter-latin-(?:400|500|600|700)-normal-[A-Za-z0-9_-]{6,32}\.woff2?)$/.test(file)
    if (asset || ['index.html', 'favicon.svg', 'data/csv-template.csv'].includes(file) || file.startsWith('licenses/') && LICENSE_FILES.has(file.slice(9))) selected.push(file)
    else throw new Error(`发行白名单外的构建文件：${file}。请检查构建输入，不会自动复制或删除。`)
  }
  for (const required of ['index.html', 'favicon.svg', 'data/csv-template.csv', ...Array.from(LICENSE_FILES, file => `licenses/${file}`)]) {
    if (!selected.includes(required)) throw new Error(`构建缺少发行必需文件：${required}`)
  }
  if (!selected.some(file => /^assets\/index-.*\.js$/.test(file)) || !selected.some(file => /^assets\/index-.*\.css$/.test(file))) throw new Error('构建缺少 JavaScript 或 CSS。')
  const indexHtml = await readFile(join(distDirectory, 'index.html'), 'utf8')
  for (const match of indexHtml.matchAll(/(?:src|href)="\/([^"]+)"/g)) {
    if (!selected.includes(match[1])) throw new Error(`入口引用未纳入发行包：${match[1]}`)
  }
  if (/(?:src|href)=["']https?:\/\//i.test(indexHtml)) throw new Error('发行入口不能依赖外部运行资源。')
  return selected
}

function powershell(script, environment) {
  return new Promise((resolveProcess, reject) => {
    const child = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
      windowsHide: true, stdio: 'inherit', env: { ...process.env, ...environment },
    })
    child.once('error', reject)
    child.once('exit', code => code === 0 ? resolveProcess() : reject(new Error(`Windows 归档命令失败：${code}`)))
  })
}

async function download(url, destination) {
  const response = await fetch(url, { signal: AbortSignal.timeout(180_000), redirect: 'error' })
  if (!response.ok || !response.body) throw new Error(`官方下载失败：${response.status} ${url}`)
  await pipeline(response.body, createWriteStream(destination, { flags: 'wx' }))
}

async function prepareRuntime(cacheDirectory, runtimeDirectory) {
  await mkdir(cacheDirectory, { recursive: true })
  const archivePath = join(cacheDirectory, WINDOWS_RUNTIME.archive)
  try { await access(archivePath) }
  catch {
    const temporaryPath = `${archivePath}.download-${process.pid}`
    try {
      await download(`${WINDOWS_RUNTIME.sourceUrl}${WINDOWS_RUNTIME.archive}`, temporaryPath)
      if (await hashFile(temporaryPath) !== WINDOWS_RUNTIME.archiveSha256) throw new Error('官方运行时 ZIP 的 SHA-256 不一致。')
      await rename(temporaryPath, archivePath)
    } finally { await rm(temporaryPath, { force: true }) }
  }
  if (await hashFile(archivePath) !== WINDOWS_RUNTIME.archiveSha256) throw new Error(`缓存运行时 ZIP 的 SHA-256 不一致：${archivePath}。请另行核对；不会自动删除。`)
  if (runtimeDirectory) {
    const nodePath = join(runtimeDirectory, 'node.exe')
    const licensePath = join(runtimeDirectory, 'LICENSE')
    if (await hashFile(nodePath) !== WINDOWS_RUNTIME.executableSha256) throw new Error('指定运行时不是固定版本的官方 Windows x64 node.exe。')
    const officialDirectory = await extractRuntime(archivePath, cacheDirectory)
    if (await hashFile(licensePath) !== await hashFile(join(officialDirectory, 'LICENSE'))) throw new Error('指定运行时 LICENSE 与官方发行包不一致。')
    return runtimeDirectory
  }
  return extractRuntime(archivePath, cacheDirectory)
}

async function extractRuntime(archivePath, cacheDirectory) {
  const extractionDirectory = join(cacheDirectory, `official-${WINDOWS_RUNTIME.version}`)
  const runtimeDirectory = join(extractionDirectory, `node-v${WINDOWS_RUNTIME.version}-win-x64`)
  try {
    if (await hashFile(join(runtimeDirectory, 'node.exe')) === WINDOWS_RUNTIME.executableSha256) {
      const marker = JSON.parse(await readFile(join(extractionDirectory, 'verified-runtime.json'), 'utf8'))
      if (marker.archiveSha256 === WINDOWS_RUNTIME.archiveSha256 && marker.licenseSha256 === await hashFile(join(runtimeDirectory, 'LICENSE'))) return runtimeDirectory
    }
    throw new Error('已有运行时缓存不能核验，请更换 --cache 目录；原缓存保留。')
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  const temporaryDirectory = await mkdtemp(join(cacheDirectory, 'extract-'))
  try {
    await extractZip(archivePath, temporaryDirectory)
    const extractedRuntime = join(temporaryDirectory, `node-v${WINDOWS_RUNTIME.version}-win-x64`)
    if (await hashFile(join(extractedRuntime, 'node.exe')) !== WINDOWS_RUNTIME.executableSha256) throw new Error('解压后的运行时 SHA-256 不一致。')
    await writeFile(join(temporaryDirectory, 'verified-runtime.json'), JSON.stringify({
      archiveSha256: WINDOWS_RUNTIME.archiveSha256, licenseSha256: await hashFile(join(extractedRuntime, 'LICENSE')),
    }, null, 2) + '\n')
    await rename(temporaryDirectory, extractionDirectory)
    return runtimeDirectory
  } finally {
    if (dirname(temporaryDirectory) !== cacheDirectory) throw new Error('运行时临时目录越过缓存目录边界。')
    await rm(temporaryDirectory, { recursive: true, force: true })
  }
}

async function extractZip(zipPath, destination) {
  await powershell('$ErrorActionPreference = "Stop"; Add-Type -AssemblyName System.IO.Compression.FileSystem; $archive = [System.IO.Compression.ZipFile]::OpenRead($env:FX_ARCHIVE_ZIP); try { foreach ($entry in $archive.Entries) { if ($entry.FullName -match "(^[\\\\/]|^[A-Za-z]:|(^|[\\\\/])\\.\\.([\\\\/]|$))") { throw "ZIP 包含越界路径" } } } finally { $archive.Dispose() }; [System.IO.Compression.ZipFile]::ExtractToDirectory($env:FX_ARCHIVE_ZIP, $env:FX_ARCHIVE_EXTRACT)', {
    FX_ARCHIVE_ZIP: zipPath, FX_ARCHIVE_EXTRACT: destination,
  })
}

export async function verifyRelease(directory) {
  const manifest = JSON.parse(await readFile(join(directory, 'release-manifest.json'), 'utf8'))
  if (manifest.formatVersion !== 1 || manifest.appName !== 'FX 练习室' || !Array.isArray(manifest.files)) throw new Error('发行清单格式无效。')
  const actualFiles = await listRegularFiles(directory)
  const expectedFiles = [...manifest.files.map(file => file.path), 'release-manifest.json'].sort()
  if (JSON.stringify(actualFiles) !== JSON.stringify(expectedFiles)) throw new Error('发行目录文件范围与清单不一致。')
  const publicFiles = await collectPublicFiles(join(directory, 'app'))
  const allowedFiles = new Set([
    ...publicFiles.map(file => `app/${file}`), 'app/data/manifest.json', 'release-manifest.json',
    'runtime/node.exe', 'runtime/LICENSE.txt', 'scripts/startLocal.mjs', 'scripts/localServer.mjs', '启动.cmd', '使用说明.txt',
  ])
  if (actualFiles.some(file => !allowedFiles.has(file))) throw new Error('发行目录包含允许范围之外的文件。')
  for (const file of manifest.files) {
    if (typeof file.path !== 'string' || !/^[a-f0-9]{64}$/.test(file.sha256) || file.path.startsWith('/') || file.path.split('/').some(segment => segment === '.' || segment === '..') || file.path.includes('\\')) throw new Error('发行清单包含无效文件路径或指纹。')
    if (await hashFile(join(directory, file.path)) !== file.sha256) throw new Error(`发行文件 SHA-256 不一致：${file.path}`)
  }
  if (await hashFile(join(directory, 'runtime/node.exe')) !== WINDOWS_RUNTIME.executableSha256) throw new Error('发行运行时不匹配官方固定版本。')
  for (const [field, expected] of Object.entries(WINDOWS_RUNTIME)) {
    if (manifest.runtime?.[field] !== expected) throw new Error('发行运行时官方来源或固定版本记录不一致。')
  }
  if (await hashFile(join(directory, 'runtime/LICENSE.txt')) !== manifest.runtime.licenseSha256) throw new Error('Node.js 完整许可与运行时记录不一致。')
  const samples = JSON.parse(await readFile(join(directory, 'app/data/manifest.json'), 'utf8'))
  if (samples.version !== 1 || !Array.isArray(samples.samples) || samples.samples.length !== 0) throw new Error('公开发行包不能携带本机行情样本清单。')
  return manifest
}

export async function verifyReleaseZip(directory, zipPath = `${directory}.zip`, expectedSha256) {
  const manifest = await verifyRelease(directory)
  const zipSha256 = await hashFile(zipPath)
  if (expectedSha256 ? zipSha256 !== expectedSha256 : (await readFile(`${zipPath}.sha256`, 'utf8')).trim() !== `${zipSha256}  ${basename(zipPath)}`) throw new Error('发行 ZIP 的 SHA-256 不一致。')
  const verificationRoot = resolve(PROJECT_DIRECTORY, '.vite/release-zip-verification')
  await mkdir(verificationRoot, { recursive: true })
  const temporaryDirectory = await mkdtemp(join(verificationRoot, 'zip-'))
  try {
    await extractZip(zipPath, temporaryDirectory)
    const entries = await readdir(temporaryDirectory)
    if (entries.length !== 1 || entries[0] !== basename(directory)) throw new Error('发行 ZIP 顶层范围与发行目录不一致。')
    const extractedDirectory = join(temporaryDirectory, basename(directory))
    const extractedManifest = await verifyRelease(extractedDirectory)
    if (JSON.stringify(extractedManifest) !== JSON.stringify(manifest)) throw new Error('发行 ZIP 与发行目录不是相同版本内容。')
    return { manifest, zipSha256 }
  } finally {
    if (dirname(temporaryDirectory) !== verificationRoot) throw new Error('ZIP 校验临时目录越过边界。')
    await rm(temporaryDirectory, { recursive: true, force: true })
  }
}

function usageInstructions(version) {
  return `FX 练习室 ${version} · Windows x64 便携版\n\n1. 将整个 ZIP 解压到普通文件夹；不要在压缩包内直接启动。\n2. 双击“启动.cmd”。无需另装 Node.js、npm 或项目依赖。\n3. 浏览器打开 http://127.0.0.1:4173；保持启动窗口打开。Ctrl+C 结束服务。\n4. 首次练习可跳过三步引导。模拟行情由本机生成，不是真实历史价格。\n5. 历史练习请导入自己的规范 CSV；页面可下载生成的格式模板。发行包不含私用真实价格样本。\n\n系统与数据\n- 本版面向 Windows 10/11 x64、Chromium 内核浏览器（Chrome/Edge）；本机服务只绑定 127.0.0.1，不供其他设备访问。\n- 首次启动后核心资源无需外网，运行时已包含在 runtime/。历史 CSV 的来源和使用许可由本人核实。\n- 4173 被占用时启动失败，不自动换端口。请关闭旧启动窗口；不要改用 localhost 或其他端口。\n- 练习保存于所用浏览器的 IndexedDB，不写入发行目录。换浏览器、隐私窗口、清理浏览器或更换地址会影响数据。\n- 请在“练习与备份”导出完整备份，并保存在浏览器之外。保存失败时优先导出可恢复故障备份；容量不足时先清理不需要的练习或数据集，再重试保存。原始快照只用于诊断。\n\n升级\n- 先在旧版导出完整备份，再关闭旧启动窗口并解压新版到新文件夹。\n- 使用相同浏览器与 http://127.0.0.1:4173，应用会校验并暂停恢复旧练习。\n- 恢复备份先预览，再确认；已有库只追加独立副本，不覆盖原练习。失败时保留旧版、原库与备份。\n\n核验与许可\n- 本发行版可用于正常个人离线练习。\n- release-manifest.json 记录版本、运行时官方来源与逐文件 SHA-256。请完整保留所有文件。\n- runtime/LICENSE.txt 是 Node.js 官方完整许可；app/licenses/ 包含应用运行依赖的许可与 NOTICE。\n- 本版用于练习，不连接真实下单、账户或云服务；练习结果不代表实盘表现。\n`
}

export async function packageWindows({ cacheDirectory = resolve(PROJECT_DIRECTORY, '.vite/release-runtime'), runtimeDirectory } = {}) {
  if (process.platform !== 'win32') throw new Error('此发行脚本需要 Windows PowerShell，产物面向 Windows x64。')
  const packageInfo = JSON.parse(await readFile(join(PROJECT_DIRECTORY, 'package.json'), 'utf8'))
  if (!/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(packageInfo.version)) throw new Error('package.json 版本无效。')
  const distDirectory = join(PROJECT_DIRECTORY, 'dist')
  const publicFiles = await collectPublicFiles(distDirectory)
  const runtime = await prepareRuntime(resolve(cacheDirectory), runtimeDirectory && resolve(runtimeDirectory))
  const releaseRoot = join(PROJECT_DIRECTORY, 'release')
  await mkdir(releaseRoot, { recursive: true })
  if ((await lstat(releaseRoot)).isSymbolicLink()) throw new Error('发行输出目录不能是符号链接。')
  const releaseName = `FX-practice-room-${packageInfo.version}-win-x64`
  const destination = join(releaseRoot, releaseName)
  const zipPath = `${destination}.zip`
  let hasPreviousDirectory = false
  try { await access(destination); hasPreviousDirectory = true }
  catch (error) { if (error.code !== 'ENOENT') throw error }
  if (hasPreviousDirectory) await verifyRelease(destination)
  let hasPreviousZip = false
  try { await access(zipPath); hasPreviousZip = true }
  catch (error) { if (error.code !== 'ENOENT') throw error }
  if (hasPreviousZip) {
    if (!hasPreviousDirectory || (await readFile(`${zipPath}.sha256`, 'utf8')).trim() !== `${await hashFile(zipPath)}  ${basename(zipPath)}`) throw new Error('已有 ZIP 不能确认是上次完整产物；保留现有文件。')
  }
  const temporaryDirectory = await mkdtemp(join(releaseRoot, '.package-'))
  const stagingDirectory = join(temporaryDirectory, releaseName)
  try {
    for (const file of publicFiles) {
      const output = join(stagingDirectory, 'app', file)
      await mkdir(dirname(output), { recursive: true })
      await copyFile(join(distDirectory, file), output)
    }
    await writeFile(join(stagingDirectory, 'app/data/manifest.json'), '{"version":1,"samples":[]}\n')
    await mkdir(join(stagingDirectory, 'runtime'), { recursive: true })
    await copyFile(join(runtime, 'node.exe'), join(stagingDirectory, 'runtime/node.exe'))
    await copyFile(join(runtime, 'LICENSE'), join(stagingDirectory, 'runtime/LICENSE.txt'))
    await mkdir(join(stagingDirectory, 'scripts'), { recursive: true })
    for (const file of ['startLocal.mjs', 'localServer.mjs']) await copyFile(join(PROJECT_DIRECTORY, 'scripts', file), join(stagingDirectory, 'scripts', file))
    await writeFile(join(stagingDirectory, '启动.cmd'), portableLauncher())
    await writeFile(join(stagingDirectory, '使用说明.txt'), usageInstructions(packageInfo.version))
    const files = []
    for (const file of await listRegularFiles(stagingDirectory)) files.push({ path: file, sha256: await hashFile(join(stagingDirectory, file)) })
    const manifest = {
      formatVersion: 1, appName: 'FX 练习室', version: packageInfo.version, platform: 'win-x64',
      runtime: { ...WINDOWS_RUNTIME, licenseSha256: await hashFile(join(runtime, 'LICENSE')) },
      origin: 'http://127.0.0.1:4173', files,
    }
    await writeFile(join(stagingDirectory, 'release-manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
    await verifyRelease(stagingDirectory)
    const temporaryZip = join(temporaryDirectory, `${releaseName}.zip`)
    await powershell('$ErrorActionPreference = "Stop"; Add-Type -AssemblyName System.IO.Compression.FileSystem; [System.IO.Compression.ZipFile]::CreateFromDirectory($env:FX_PACKAGE_DIRECTORY, $env:FX_PACKAGE_ZIP, [System.IO.Compression.CompressionLevel]::Optimal, $true)', {
      FX_PACKAGE_DIRECTORY: stagingDirectory, FX_PACKAGE_ZIP: temporaryZip,
    })
    await verifyReleaseZip(stagingDirectory, temporaryZip, await hashFile(temporaryZip))
    // Only the exact verified previous generated directory is replaced; extra or changed files stop above.
    if (dirname(destination) !== releaseRoot || basename(destination) !== releaseName) throw new Error('发行输出越过固定目录边界。')
    if (hasPreviousDirectory) await verifyRelease(destination)
    await rm(destination, { recursive: true, force: true })
    await rename(stagingDirectory, destination)
    await rm(zipPath, { force: true })
    await rename(temporaryZip, zipPath)
    await writeFile(`${zipPath}.sha256`, `${await hashFile(zipPath)}  ${basename(zipPath)}\n`)
    process.stdout.write(`发行目录：${destination}\n发行 ZIP：${zipPath}\n文件核验通过；不含私用价格文件，运行无需 npm 或外部下载。\n`)
    return { directory: destination, zipPath }
  } finally {
    if (dirname(temporaryDirectory) !== releaseRoot) throw new Error('临时目录越过发行目录边界。')
    await rm(temporaryDirectory, { recursive: true, force: true })
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const argumentsList = process.argv.slice(2)
  const options = {}
  for (let index = 0; index < argumentsList.length; index++) {
    const option = argumentsList[index]
    if (option === '--verify' && (!argumentsList[index + 1] || argumentsList[index + 1].startsWith('--'))) { options[option] = true; continue }
    if (!['--cache', '--runtime', '--verify'].includes(option) || !argumentsList[index + 1]) throw new Error('用法：node scripts/packageWindows.mjs [--cache 目录] [--runtime 官方运行时目录]，或 --verify [发行目录]。')
    options[option] = argumentsList[++index]
  }
  const operation = options['--verify'] ? (async () => {
    const packageInfo = JSON.parse(await readFile(join(PROJECT_DIRECTORY, 'package.json'), 'utf8'))
    const directory = options['--verify'] === true ? join(PROJECT_DIRECTORY, 'release', `FX-practice-room-${packageInfo.version}-win-x64`) : resolve(options['--verify'])
    await verifyReleaseZip(directory)
    process.stdout.write('发行目录、实际 ZIP 解压内容及固定运行时 SHA-256 核验通过。\n')
  })()
    : packageWindows({ cacheDirectory: options['--cache'], runtimeDirectory: options['--runtime'] })
  operation.catch(error => { process.stderr.write(`发行失败：${error.message}\n`); process.exitCode = 1 })
}

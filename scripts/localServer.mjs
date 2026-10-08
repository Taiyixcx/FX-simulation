import { createServer } from 'node:http'
import { createReadStream } from 'node:fs'
import { realpath, stat } from 'node:fs/promises'
import { extname, resolve, sep } from 'node:path'
import { pipeline } from 'node:stream/promises'

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
}

function respond(response, statusCode, message) {
  response.writeHead(statusCode, { 'Content-Type': 'text/plain; charset=utf-8' })
  response.end(message)
}

/** Serve files from one local directory. The application uses anchors, so no SPA fallback is needed. */
export async function startLocalServer(directory, { port = 4173 } = {}) {
  const rootDirectory = await realpath(resolve(directory))
  const server = createServer(async (request, response) => {
    response.setHeader('Cache-Control', 'no-store')
    response.setHeader('X-Content-Type-Options', 'nosniff')
    response.setHeader('Cross-Origin-Resource-Policy', 'same-origin')
    response.setHeader('Referrer-Policy', 'no-referrer')
    const address = server.address()
    if (!address || typeof address === 'string' || request.headers.host !== `127.0.0.1:${address.port}`) {
      respond(response, 403, '请使用启动窗口中的 127.0.0.1 地址。')
      return
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.setHeader('Allow', 'GET, HEAD')
      respond(response, 405, '此服务只读取应用文件。')
      return
    }
    let pathname
    try {
      const requestPath = request.url?.split(/[?#]/, 1)[0] ?? ''
      if (!requestPath.startsWith('/') || requestPath.startsWith('//')) throw new Error('invalid-path')
      pathname = decodeURIComponent(requestPath)
      if (/[\u0000-\u001f\u007f\\]/.test(pathname) || pathname.split('/').some(segment => segment === '.' || segment === '..')) throw new Error('invalid-path')
    } catch {
      respond(response, 400, '无效的文件路径。')
      return
    }
    const candidatePath = resolve(rootDirectory, pathname === '/' ? 'index.html' : `.${pathname}`)
    if (!candidatePath.startsWith(`${rootDirectory}${sep}`)) {
      respond(response, 404, '未找到应用文件。')
      return
    }
    try {
      const filePath = await realpath(candidatePath)
      const contentType = CONTENT_TYPES[extname(filePath).toLowerCase()]
      const fileStat = await stat(filePath)
      if (!filePath.startsWith(`${rootDirectory}${sep}`) || !fileStat.isFile() || !contentType) {
        respond(response, 404, '未找到应用文件。')
        return
      }
      response.writeHead(200, { 'Content-Type': contentType, 'Content-Length': fileStat.size })
      if (request.method === 'HEAD') response.end()
      else await pipeline(createReadStream(filePath), response)
    } catch (error) {
      if (!response.headersSent) respond(response, ['ENOENT', 'ENOTDIR'].includes(error?.code) ? 404 : 500, '无法读取应用文件。')
      else response.destroy()
    }
  })
  server.requestTimeout = 10_000
  server.headersTimeout = 10_000
  await new Promise((resolveListen, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => { server.removeListener('error', reject); resolveListen() })
  })
  return {
    server,
    async close() {
      if (!server.listening) return
      server.closeAllConnections()
      await new Promise((resolveClose, reject) => server.close(error => error ? reject(error) : resolveClose()))
    },
  }
}

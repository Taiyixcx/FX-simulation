import { resolve } from 'node:path'
import { createServer, preview } from 'vite'

/** Own the test server in this process, avoiding npm/cmd descendants on Windows. */
export default async function startTestServer(): Promise<() => Promise<void>> {
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

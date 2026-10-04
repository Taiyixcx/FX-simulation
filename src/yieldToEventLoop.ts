/** Yield a complete browser task without accumulating nested timer delays. */
export function yieldToEventLoop(): Promise<void> {
  if (typeof MessageChannel !== 'function') return new Promise(resolve => setTimeout(resolve, 0))
  return new Promise(resolve => {
    const channel = new MessageChannel()
    channel.port1.onmessage = () => {
      channel.port1.onmessage = null
      channel.port1.close()
      channel.port2.close()
      resolve()
    }
    channel.port2.postMessage(null)
  })
}

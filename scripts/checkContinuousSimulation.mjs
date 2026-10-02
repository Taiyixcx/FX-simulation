import 'fake-indexeddb/auto'
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { createServer } from 'vite'

// Long-run lifecycle check in Node/fake-indexeddb, not a browser quota or market calibration.
const FRAME_COUNT = 50_000
const BATCH_SIZE = 100
const server = await createServer({ configFile: false, server: { middlewareMode: true }, appType: 'custom', logLevel: 'error' })
let repository
try {
  const { createSimulation, advanceSimulation } = await server.ssrLoadModule('/src/engine/simulationSource.ts')
  const { createSimulationConfig, SESSION_FRAME_WINDOW_SIZE } = await server.ssrLoadModule('/src/storage/sessionSnapshot.ts')
  const { createSessionRepository } = await server.ssrLoadModule('/src/storage/sessionRepository.ts')
  const { openPosition, closePosition } = await server.ssrLoadModule('/src/engine/execution.ts')
  const databaseName = 'fx-continuous-validation'
  repository = createSessionRepository(databaseName)
  assert.equal(await repository.loadCurrent(), null)
  const simulation = createSimulation('EUR/USD', 86028121, { maxFrames: null, scenario: 'eventful' })
  let snapshot = {
    schemaVersion: 3, retainedPrefixKind: null, id: 'long-practice', revision: 0, pair: 'EUR/USD',
    simulationConfig: createSimulationConfig(simulation.state), sourceState: simulation.state,
    frameStartIndex: 0, frames: [simulation.frame],
    account: { balanceUsd: '10000', position: null }, trades: [],
  }
  snapshot.account = openPosition(snapshot.account, simulation.frame.quote, snapshot.pair, 'long', '1000', 'archived-entry')
  await repository.save(snapshot)
  const firstFrame = structuredClone(snapshot.frames[0])
  const saveDurations = []
  const started = performance.now()
  while (snapshot.sourceState.frameIndex + 1 < FRAME_COUNT) {
    const nextFrames = [...snapshot.frames]
    let state = snapshot.sourceState
    for (let index = 0; index < Math.min(BATCH_SIZE, FRAME_COUNT - snapshot.sourceState.frameIndex - 1); index += 1) {
      const next = advanceSimulation(state)
      assert.ok(next)
      state = next.state
      nextFrames.push(next.frame)
    }
    const frames = nextFrames.slice(-SESSION_FRAME_WINDOW_SIZE)
    snapshot = { ...snapshot, revision: snapshot.revision + 1, sourceState: state, frames, frameStartIndex: state.frameIndex + 1 - frames.length }
    const saveStarted = performance.now()
    await repository.save(snapshot)
    saveDurations.push(performance.now() - saveStarted)
  }
  const closed = closePosition(snapshot.account, snapshot.frames.at(-1).quote)
  snapshot = { ...snapshot, revision: snapshot.revision + 1, account: closed.account, trades: [closed.trade] }
  await repository.save(snapshot)
  const loadedStarted = performance.now()
  const restored = await repository.loadCurrent()
  const coldLoadMs = performance.now() - loadedStarted
  assert.deepEqual(restored, snapshot)
  assert.deepEqual(advanceSimulation(restored.sourceState), advanceSimulation(snapshot.sourceState))
  assert.equal(restored.frames.length, SESSION_FRAME_WINDOW_SIZE)
  assert.equal(restored.frameStartIndex, FRAME_COUNT - SESSION_FRAME_WINDOW_SIZE)
  const database = await new Promise((resolveDatabase, reject) => {
    const request = indexedDB.open(databaseName)
    request.onsuccess = () => resolveDatabase(request.result)
    request.onerror = () => reject(request.error)
  })
  let archivedFrames = 0
  let chunks = 0
  await new Promise((resolveCursor, reject) => {
    const transaction = database.transaction('historyChunks', 'readonly')
    const request = transaction.objectStore('historyChunks').openCursor()
    let failure
    request.onsuccess = () => {
      try {
        const cursor = request.result
        if (!cursor) return
        assert.ok(cursor.value.frames.length <= SESSION_FRAME_WINDOW_SIZE)
        if (chunks === 0) assert.deepEqual(cursor.value.frames[0], firstFrame)
        chunks += 1
        archivedFrames += cursor.value.frames.length
        cursor.continue()
      } catch (error) { failure = error; transaction.abort() }
    }
    transaction.oncomplete = resolveCursor
    transaction.onabort = () => reject(failure ?? transaction.error)
  })
  database.close()
  assert.equal(archivedFrames, FRAME_COUNT)
  assert.equal(chunks, Math.ceil(FRAME_COUNT / SESSION_FRAME_WINDOW_SIZE))
  const average = samples => samples.reduce((sum, sample) => sum + sample, 0) / samples.length
  const result = {
    checkedFrames: FRAME_COUNT, chartWindowFrames: restored.frames.length,
    archivedFrames, archiveChunks: chunks, closedTrades: restored.trades.length,
    exactContinuation: true, coldLoadMs: Math.round(coldLoadMs),
    first20SavesMeanMs: Number(average(saveDurations.slice(0, 20)).toFixed(2)),
    last20SavesMeanMs: Number(average(saveDurations.slice(-20)).toFixed(2)),
    elapsedMs: Math.round(performance.now() - started),
    scope: 'Node/Vite SSR with fake-indexeddb; browser quota and empirical market fit are not checked',
  }
  await mkdir(resolve('.vite'), { recursive: true })
  await writeFile(resolve('.vite/continuous-validation.json'), JSON.stringify(result, null, 2) + '\n')
  console.log(JSON.stringify(result, null, 2))
} finally {
  repository?.close()
  await server.close()
}

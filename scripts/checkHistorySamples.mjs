import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { resolve, sep } from 'node:path'
import { indexedDB, IDBKeyRange } from 'fake-indexeddb'
import { createServer } from 'vite'

// Offline integration check. Use an isolated in-memory IndexedDB, never the user's
// browser database. Missing or mismatched local price files fail explicitly.
globalThis.indexedDB = indexedDB
globalThis.IDBKeyRange = IDBKeyRange
const dataDirectory = resolve('public/data')
const results = []
const server = await createServer({ configFile: false, server: { middlewareMode: true, watch: null, ws: false }, appType: 'custom', logLevel: 'error' })

function localPath(filename) {
  if (typeof filename !== 'string' || !/^[A-Za-z0-9_-]+\.csv$/.test(filename)) throw new Error('样本 manifest 只接受本机数据目录下的 CSV 文件名。')
  const path = resolve(dataDirectory, filename)
  if (!path.startsWith(`${dataDirectory}${sep}`)) throw new Error('样本路径不能离开 public/data。')
  return path
}

try {
  const manifest = JSON.parse(await readFile(resolve(dataDirectory, 'manifest.json'), 'utf8'))
  assert.equal(manifest.version, 1, '不支持的本机样本 manifest 版本')
  assert.ok(Array.isArray(manifest.samples) && manifest.samples.length === 2, '验收需要 EUR/USD、GBP/USD 两份本机样本')
  assert.deepEqual(manifest.samples.map((sample) => sample.pair).sort(), ['EUR/USD', 'GBP/USD'])
  const { parseHistoryCsv } = await server.ssrLoadModule('/src/engine/historyCsv.ts')
  const { createHistory, advanceHistory } = await server.ssrLoadModule('/src/engine/historySource.ts')
  const { createSessionRepository } = await server.ssrLoadModule('/src/storage/sessionRepository.ts')
  const { createHistoricalSnapshot, validateHistoricalSnapshot } = await server.ssrLoadModule('/src/storage/historicalSessionSnapshot.ts')
  const { SESSION_FRAME_WINDOW_SIZE } = await server.ssrLoadModule('/src/storage/sessionSnapshot.ts')
  const { openPosition, closePosition, settleDepletedAccount } = await server.ssrLoadModule('/src/engine/execution.ts')

  for (const sample of manifest.samples) {
    const path = localPath(sample.path)
    let bytes
    let metadata
    try {
      bytes = await readFile(path)
      metadata = JSON.parse(await readFile(`${path}.metadata.json`, 'utf8'))
    } catch (cause) {
      throw new Error(`缺少本机样本或元信息：${sample.path}。请按 public/data/README.md 准备文件；没有执行该样本验收。`, { cause })
    }
    const fileSha256 = createHash('sha256').update(bytes).digest('hex')
    assert.equal(fileSha256, sample.sha256, 'manifest 文件 SHA-256 不一致')
    assert.equal(fileSha256, metadata.fileSha256, '元信息文件 SHA-256 不一致')
    assert.equal(metadata.verified, true, '本机样本的来源核验尚未完成；格式转换不能证明真实性')
    assert.ok(metadata.provenance?.acquisition?.archiveSha256, '缺少本轮官方下载及压缩包校验记录')
    const dataset = await parseHistoryCsv(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes), sample.pair, metadata)
    assert.equal(dataset.metadata.recordCount, metadata.recordCount)
    assert.equal(dataset.metadata.startTimestampMs, metadata.startTimestampMs)
    assert.equal(dataset.metadata.endTimestampMs, metadata.endTimestampMs)
    assert.equal(dataset.fingerprint, metadata.provenance.fingerprint, '规范化数据集校验信息不一致')
    assert.equal(dataset.metadata.quoteType, 'source')
    assert.ok(dataset.frames.length > SESSION_FRAME_WINDOW_SIZE * 2, '样本过短，不能验证跨窗口恢复')

    const databaseName = `history-sample-check-${sample.pair.replace('/', '')}-${crypto.randomUUID()}`
    let repository = createSessionRepository(databaseName)
    let staleRepository = null
    try {
      assert.equal(await repository.loadCurrent(), null)
      await repository.importDataset(dataset)
      await assert.rejects(repository.importDataset(dataset), /已经导入/)
      const summaries = await repository.listDatasets()
      assert.equal(summaries.length, 1)
      assert.equal(summaries[0].metadata.recordCount, dataset.frames.length)
      assert.ok(!Object.hasOwn(summaries[0], 'frames'), '数据集摘要不能暴露未来行情')
      const loadedDataset = await repository.loadDataset(dataset.id)
      assert.equal(loadedDataset.fingerprint, dataset.fingerprint)

      let snapshot = createHistoricalSnapshot(loadedDataset, `history-check-${sample.pair.replace('/', '')}`)
      let step = createHistory(loadedDataset)
      assert.equal(snapshot.frames.length, 1, '首帧以外的行情不能提前给会话')
      await repository.save(snapshot)
      snapshot.account = openPosition(snapshot.account, step.frame.quote, sample.pair, 'long', '1000', 'early-long')
      snapshot.revision += 1
      await repository.save(snapshot)
      staleRepository = createSessionRepository(databaseName)
      const staleSnapshot = await staleRepository.loadCurrent()
      let restoredMidway = false
      let gapCount = 0
      let currentSource = loadedDataset

      for (let frameIndex = 1; frameIndex < currentSource.frames.length; frameIndex += 1) {
        const previousTimestampMs = step.frame.quote.timestampMs
        step = advanceHistory(step.state, currentSource)
        assert.ok(step)
        assert.equal(step.state.frameIndex, frameIndex)
        assert.deepEqual(step.frame, currentSource.frames[frameIndex])
        if (step.frame.quote.timestampMs - previousTimestampMs > 60_000) gapCount += 1
        snapshot.sourceState = step.state
        snapshot.frames.push(step.frame)
        if (snapshot.frames.length > SESSION_FRAME_WINDOW_SIZE) {
          snapshot.frames.shift()
          snapshot.frameStartIndex += 1
        }
        assert.equal(snapshot.frames.at(-1).quote.timestampMs, snapshot.sourceState.currentTimestampMs)
        assert.ok(snapshot.frames.every((frame) => frame.quote.timestampMs <= snapshot.sourceState.currentTimestampMs))
        assert.equal(settleDepletedAccount(snapshot.account, step.frame.quote), null, '该验收练习意外耗尽资金')
        if (frameIndex === 1) {
          const closed = closePosition(snapshot.account, step.frame.quote)
          snapshot.account = closed.account
          snapshot.trades.push(closed.trade)
        }
        if (frameIndex === SESSION_FRAME_WINDOW_SIZE + 1) snapshot.account = openPosition(snapshot.account, step.frame.quote, sample.pair, 'short', '1000', 'late-short')
        if (frameIndex === currentSource.frames.length - 1) {
          const closed = closePosition(snapshot.account, step.frame.quote)
          snapshot.account = closed.account
          snapshot.trades.push(closed.trade)
        }
        if (frameIndex % SESSION_FRAME_WINDOW_SIZE === 0 || frameIndex === currentSource.frames.length - 1) {
          snapshot.revision += 1
          await repository.save(snapshot)
          if (frameIndex === SESSION_FRAME_WINDOW_SIZE * 2) {
            repository.close()
            repository = createSessionRepository(databaseName)
            const restored = await repository.loadCurrent()
            assert.deepEqual(restored, snapshot, '跨窗口恢复未保留行情进度与完整账本')
            assert.equal(restored.trades.length, 1, '窗口外早期成交不能丢失')
            assert.ok(restored.account.position, '跨窗口恢复须保留当前持仓')
            snapshot = restored
            currentSource = await repository.loadDataset(dataset.id)
            step = { state: snapshot.sourceState, frame: snapshot.frames.at(-1) }
            restoredMidway = true
          }
        }
      }
      assert.equal(advanceHistory(step.state, currentSource), null, '末尾必须停止')
      assert.ok(restoredMidway)
      assert.equal(snapshot.trades.length, 2)
      assert.ok(snapshot.frameStartIndex > 0)
      assert.deepEqual(validateHistoricalSnapshot(snapshot, currentSource), snapshot, '最后快照全历史账本验证失败')
      await assert.rejects(staleRepository.save({ ...staleSnapshot, revision: staleSnapshot.revision + 1 }), /另一窗口/)
      repository.close()
      repository = createSessionRepository(databaseName)
      const final = await repository.loadCurrent()
      assert.deepEqual(final, snapshot, '末尾重新打开必须保留最后报价、结算与进度')
      results.push({ pair: sample.pair, recordCount: dataset.frames.length, startUtc: new Date(dataset.metadata.startTimestampMs).toISOString(), endUtc: new Date(dataset.metadata.endTimestampMs).toISOString(), gapCount, fileSha256, fingerprint: dataset.fingerprint, checks: ['全量 CSV 与文件校验', '仅推进当前前缀', '缺口与末尾', '数据集事务保存/加载/重复保护', '跨窗口持仓与完整账本恢复', '末尾结算与恢复', '多窗口冲突保护'], balanceUsd: final.account.balanceUsd })
    } finally {
      staleRepository?.close()
      repository.close()
    }
  }
  process.stdout.write(`${JSON.stringify({ verified: true, scope: '本机真实样本与隔离的 fake-indexeddb 集成验证；浏览器视觉与离线流程由 E2E 单独核验', results }, null, 2)}\n`)
} catch (cause) {
  process.stderr.write(`${cause instanceof Error ? cause.message : String(cause)}\n`)
  process.exitCode = 1
} finally {
  await server.close()
}

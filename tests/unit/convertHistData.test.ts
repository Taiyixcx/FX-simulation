import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

let directory: string
let inputPath: string
let outputPath: string

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'fx-histdata-'))
  inputPath = join(directory, 'ticks.csv')
  outputPath = join(directory, 'minutes.csv')
})

afterEach(() => {
  // This path was created by this test; never recurse outside its temp prefix.
  if (!resolve(directory).startsWith(resolve(join(tmpdir(), 'fx-histdata-')))) throw new Error('Unexpected temporary directory')
  rmSync(directory, { recursive: true, force: true })
})

function runConverter(extraArguments: string[] = []): string {
  const result = spawnSync(process.execPath, [
    resolve('scripts/convertHistData.mjs'), '--input', inputPath, '--output', outputPath, '--pair', 'EUR/USD', ...extraArguments,
  ], { encoding: 'utf8', timeout: 30_000, stdio: ['ignore', 'pipe', 'pipe'] })
  if (result.status !== 0) throw Object.assign(new Error(result.stderr || result.error?.message || 'Conversion failed'), { stderr: result.stderr })
  expect(result.stderr).toBe('')
  return result.stdout
}

describe('local HistData double-sided tick conversion', () => {
  it('uses fixed EST, half-open minutes, last synchronized quotes, original precision and gaps', () => {
    const ticks = [
      '20240310 020000000,1.100000,1.100100,0',
      '20240310 020030000,1.101234,1.101399,0',
      '20240310 020059999,1.099876,1.100050,0',
      '20240310 020100000,1.102000,1.102199,0',
      '20240310 020100000,1.102100,1.102299,0',
      '20240310 020300000,1.101100,1.101299,0',
    ].join('\r\n') + '\r\n'
    writeFileSync(inputPath, ticks, 'utf8')
    const output = runConverter()
    expect(output).not.toContain('server restarted')
    expect(JSON.parse(output).recordCount).toBe(3)
    const csv = readFileSync(outputPath, 'utf8')
    expect(csv).toBe([
      'timestamp,open,high,low,close,ask',
      '2024-03-10T07:01:00.000Z,1.100000,1.101234,1.099876,1.099876,1.100050',
      '2024-03-10T07:02:00.000Z,1.102000,1.102100,1.102000,1.102100,1.102299',
      '2024-03-10T07:04:00.000Z,1.101100,1.101100,1.101100,1.101100,1.101299',
      '',
    ].join('\n'))
    const metadata = JSON.parse(readFileSync(`${outputPath}.metadata.json`, 'utf8'))
    expect(metadata.verified).toBe(false)
    expect(metadata.provenance).toMatchObject({ inputRecordCount: 6, fullOutputMinuteCount: 3, outputRecordCount: 3, inputSha256: createHash('sha256').update(ticks).digest('hex') })
    expect(metadata.fileSha256).toBe(createHash('sha256').update(csv).digest('hex'))
  })

  it('clips completed-time boundaries inclusively while validating all raw input', () => {
    const ticks = '20240304 000000000,1.1,1.1001,0\n20240304 000100000,1.2,1.2001,0\n20240304 000200000,1.3,1.3001,0\n'
    writeFileSync(inputPath, ticks, 'utf8')
    expect(JSON.parse(runConverter(['--from', '2024-03-04T05:02:00Z', '--to', '2024-03-04T05:02:00Z'])).recordCount).toBe(1)
    const csv = readFileSync(outputPath, 'utf8')
    expect(csv).toContain('2024-03-04T05:02:00.000Z,1.2,1.2,1.2,1.2,1.2001')
    expect(csv).not.toContain('1.3')
    expect(() => runConverter()).toThrow()
    expect(readFileSync(outputPath, 'utf8')).toBe(csv)
  })

  it.each([
    ['20240304 000000000,1.1,1.1001,0\n20240304 000100000,1.1,1.0,0\n', 'ask'],
    ['20240230 000000000,1.1,1.1001,0\n', 'timestamp'],
    ['20240304 000100000,1.1,1.1001,0\n20240304 000000000,1.1,1.1001,0\n', 'timestamp'],
  ])('rejects original source errors including outside the selected output range', (ticks, field) => {
    writeFileSync(inputPath, ticks, 'utf8')
    try {
      runConverter(['--from', '2024-03-04T05:01:00Z', '--to', '2024-03-04T05:01:00Z'])
      throw new Error('expected source rejection')
    } catch (cause) {
      expect(cause).toHaveProperty('stderr')
      expect(String((cause as { stderr: string }).stderr)).toContain(`/ ${field}：`)
    }
  })
})

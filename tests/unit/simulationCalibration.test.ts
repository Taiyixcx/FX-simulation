import { describe, expect, it } from 'vitest'
import { createSimulation, advanceSimulation } from '../../src/engine/simulationSource'
import { getSimulationPairParameters, SIMULATION_PAIR_PARAMETERS } from '../../src/engine/simulationParameters'
import { createSimulationConfig, validateSessionSnapshot } from '../../src/storage/sessionSnapshot'
import type { CurrencyPair } from '../../src/engine/types'

describe('versioned partial historical calibration', () => {
  it.each(['EUR/USD', 'GBP/USD'] as CurrencyPair[])('keeps %s version 1 replay and advances its restored snapshot without switching parameters', pair => {
    const first = createSimulation(pair, 91, { parameterVersion: 1, maxFrames: 100 })
    const second = advanceSimulation(first.state)!
    const snapshot = {
      schemaVersion: 3 as const, retainedPrefixKind: null, id: 'legacy-parameters', revision: 1, pair,
      simulationConfig: createSimulationConfig(second.state), sourceState: second.state,
      frames: [first.frame, second.frame], frameStartIndex: 0, account: { balanceUsd: '10000.00', position: null }, trades: [],
    }
    const restored = validateSessionSnapshot(JSON.parse(JSON.stringify(snapshot)))
    expect(restored.sourceState.parameterVersion).toBe(1)
    expect(restored.simulationConfig.parameterVersion).toBe(1)
    expect(advanceSimulation(restored.sourceState)).toEqual(advanceSimulation(second.state))
    expect(getSimulationPairParameters(pair, 1)).toEqual(SIMULATION_PAIR_PARAMETERS[pair])
    expect(createSimulation(pair, 91).state.parameterVersion).toBe(2)
    expect(createSimulation(pair, 91).frame).not.toEqual(first.frame)
  })

  it('refuses parameter changes within an already saved configuration', () => {
    const first = createSimulation('EUR/USD', 91, { parameterVersion: 1 })
    const original = {
      schemaVersion: 3 as const, retainedPrefixKind: null, id: 'version-bound', revision: 0, pair: 'EUR/USD' as const,
      simulationConfig: createSimulationConfig(first.state), sourceState: first.state,
      frames: [first.frame], frameStartIndex: 0, account: { balanceUsd: '10000.00', position: null }, trades: [],
    }
    const tampered = structuredClone(original)
    tampered.sourceState.parameterVersion = 2
    expect(() => validateSessionSnapshot(tampered)).toThrow()
  })
})

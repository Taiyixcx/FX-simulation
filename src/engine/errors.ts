export type EngineErrorCode =
  | 'invalid-amount'
  | 'invalid-quote'
  | 'invalid-account'
  | 'invalid-simulation'
  | 'position-exists'
  | 'no-position'
  | 'insufficient-funds'

export class EngineError extends Error {
  constructor(
    readonly code: EngineErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'EngineError'
  }
}

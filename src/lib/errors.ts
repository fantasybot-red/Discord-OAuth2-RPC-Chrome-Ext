/** An error whose message is safe and intended to be shown to the user. */
export class UserError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UserError'
  }
}

/** Retrying cannot succeed; the connection loop must stop. Message is user-safe. */
export class FatalError extends Error {
  /** Stored credentials are no longer valid and must be discarded. */
  readonly clearCredentials: boolean

  constructor(message: string, clearCredentials = false) {
    super(message)
    this.name = 'FatalError'
    this.clearCredentials = clearCredentials
  }
}

/** The operation was invalidated by a disconnect / settings change / newer operation. */
export class SupersededError extends Error {
  constructor() {
    super('Operation superseded.')
    this.name = 'SupersededError'
  }
}

/** Network / 5xx / rate-limit style failure; retrying later may succeed. */
export class TransientError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TransientError'
  }
}

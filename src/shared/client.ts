import { MESSAGE_NAMESPACE } from './messages.ts'
import type { Command, CommandResponse, DiagnosticResponse } from './messages.ts'
import type { Activity, Diagnostics, Settings, Snapshot, TrackingSettings } from './types.ts'

type CommandBody = Command extends infer C
  ? C extends Command
    ? Omit<C, 'ns'>
    : never
  : never

async function send(body: CommandBody): Promise<Snapshot> {
  let response: CommandResponse | undefined
  try {
    response = (await chrome.runtime.sendMessage({
      ns: MESSAGE_NAMESPACE,
      ...body,
    })) as CommandResponse | undefined
  } catch {
    throw new Error('Could not reach the background worker. Try again.')
  }
  if (!response || typeof response !== 'object') {
    throw new Error('Background worker did not respond.')
  }
  if (!response.ok) throw new Error(response.error)
  return response.snapshot
}

async function sendDiagnostics(body: CommandBody): Promise<Diagnostics> {
  let response: DiagnosticResponse | undefined
  try {
    response = (await chrome.runtime.sendMessage({
      ns: MESSAGE_NAMESPACE,
      ...body,
    })) as DiagnosticResponse | undefined
  } catch {
    throw new Error('Could not reach the background worker. Try again.')
  }
  if (!response || typeof response !== 'object') {
    throw new Error('Background worker did not respond.')
  }
  if (!response.ok) throw new Error(response.error)
  return response.diagnostics
}

export function getDiagnostics(): Promise<Diagnostics> {
  return sendDiagnostics({ type: 'getDiagnostics' })
}

export function setDebugLogging(enabled: boolean): Promise<Diagnostics> {
  return sendDiagnostics({ type: 'setDebugLogging', enabled })
}

export function clearDiagnostics(): Promise<Diagnostics> {
  return sendDiagnostics({ type: 'clearDiagnostics' })
}

/**
 * Calls `listener` with fresh diagnostics whenever the session-storage log or
 * the local debug preference changes.
 */
export function subscribeDiagnostics(listener: (diagnostics: Diagnostics) => void): () => void {
  if (typeof chrome === 'undefined' || !chrome.storage?.onChanged) return () => {}
  let active = true
  let counter = 0
  const onChanged = (changes: Record<string, chrome.storage.StorageChange>, areaName: string) => {
    const relevant =
      (areaName === 'session' && 'rpcDiagnostics' in changes) ||
      (areaName === 'local' && 'rpcDebugEnabled' in changes)
    if (!relevant) return
    const ticket = ++counter
    getDiagnostics()
      .then((diagnostics) => {
        if (active && ticket === counter) listener(diagnostics)
      })
      .catch(() => {
        /* worker restarting; the next change will retry */
      })
  }
  chrome.storage.onChanged.addListener(onChanged)
  return () => {
    active = false
    chrome.storage.onChanged.removeListener(onChanged)
  }
}

export function getSnapshot(): Promise<Snapshot> {
  return send({ type: 'getSnapshot' })
}

export function saveSettings(settings: Settings): Promise<Snapshot> {
  return send({ type: 'saveSettings', settings })
}

export function startAuth(): Promise<Snapshot> {
  return send({ type: 'startAuth' })
}

export function disconnect(): Promise<Snapshot> {
  return send({ type: 'disconnect' })
}

export function setActivity(activity: Activity): Promise<Snapshot> {
  return send({ type: 'setActivity', activity })
}

export function clearActivity(): Promise<Snapshot> {
  return send({ type: 'clearActivity' })
}

export function saveTrackingSettings(tracking: TrackingSettings): Promise<Snapshot> {
  return send({ type: 'saveTrackingSettings', tracking })
}

export function toggleTracking(): Promise<Snapshot> {
  return send({ type: 'toggleTracking' })
}

export function completeAuth(callbackUrl: string): Promise<Snapshot> {
  return send({ type: 'completeAuth', callbackUrl })
}

/**
 * Calls `listener` with a fresh snapshot whenever extension storage changes.
 * The worker persists every state transition to storage.local, so no runtime
 * broadcasts (and therefore no token-bearing payloads) are needed.
 */
export function subscribe(listener: (snapshot: Snapshot) => void): () => void {
  // Outside an extension context (e.g. a plain dev-server tab) there is no
  // storage event source; stay inert so getSnapshot() can surface its error.
  if (typeof chrome === 'undefined' || !chrome.storage?.onChanged) return () => {}
  let active = true
  let counter = 0
  const onChanged = (
    _changes: Record<string, chrome.storage.StorageChange>,
    areaName: string,
  ) => {
    if (areaName !== 'local') return
    const ticket = ++counter
    getSnapshot()
      .then((snapshot) => {
        // Drop stale responses and anything after unsubscribe.
        if (active && ticket === counter) listener(snapshot)
      })
      .catch(() => {
        /* worker restarting; the next storage change will retry */
      })
  }
  chrome.storage.onChanged.addListener(onChanged)
  return () => {
    active = false
    chrome.storage.onChanged.removeListener(onChanged)
  }
}

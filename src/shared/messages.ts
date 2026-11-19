import type { Activity, Diagnostics, Settings, Snapshot, TrackingSettings } from './types.ts'

/** Namespace tag so unrelated runtime messages are ignored by the worker. */
export const MESSAGE_NAMESPACE = 'discord-rpc/v1' as const

/** Commands answered with a Snapshot by the controller. */
export type SnapshotCommand =
  | { ns: typeof MESSAGE_NAMESPACE; type: 'getSnapshot' }
  | { ns: typeof MESSAGE_NAMESPACE; type: 'saveSettings'; settings: Settings }
  | { ns: typeof MESSAGE_NAMESPACE; type: 'startAuth' }
  | { ns: typeof MESSAGE_NAMESPACE; type: 'disconnect' }
  | { ns: typeof MESSAGE_NAMESPACE; type: 'setActivity'; activity: Activity }
  | { ns: typeof MESSAGE_NAMESPACE; type: 'clearActivity' }
  | { ns: typeof MESSAGE_NAMESPACE; type: 'completeAuth'; callbackUrl: string }
  | { ns: typeof MESSAGE_NAMESPACE; type: 'saveTrackingSettings'; tracking: TrackingSettings }
  | { ns: typeof MESSAGE_NAMESPACE; type: 'toggleTracking' }

export type DiagnosticCommand =
  | { ns: typeof MESSAGE_NAMESPACE; type: 'getDiagnostics' }
  | { ns: typeof MESSAGE_NAMESPACE; type: 'setDebugLogging'; enabled: boolean }
  | { ns: typeof MESSAGE_NAMESPACE; type: 'clearDiagnostics' }

export type Command = SnapshotCommand | DiagnosticCommand

export function isDiagnosticCommand(command: Command): command is DiagnosticCommand {
  return (
    command.type === 'getDiagnostics' ||
    command.type === 'setDebugLogging' ||
    command.type === 'clearDiagnostics'
  )
}

export type CommandResponse =
  | { ok: true; snapshot: Snapshot }
  | { ok: false; error: string }

export type DiagnosticResponse =
  | { ok: true; diagnostics: Diagnostics }
  | { ok: false; error: string }

export const CALLBACK_PAGE = 'callback.html'

export function isCommand(value: unknown): value is Command {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  if (v.ns !== MESSAGE_NAMESPACE || typeof v.type !== 'string') return false
  switch (v.type) {
    case 'getSnapshot':
    case 'startAuth':
    case 'disconnect':
    case 'clearActivity':
    case 'toggleTracking':
    case 'getDiagnostics':
    case 'clearDiagnostics':
      return true
    case 'setDebugLogging':
      return typeof v.enabled === 'boolean'
    case 'saveTrackingSettings':
      return typeof v.tracking === 'object' && v.tracking !== null
    case 'saveSettings':
      return typeof v.settings === 'object' && v.settings !== null
    case 'setActivity':
      return typeof v.activity === 'object' && v.activity !== null
    case 'completeAuth':
      return typeof v.callbackUrl === 'string'
    default:
      return false
  }
}

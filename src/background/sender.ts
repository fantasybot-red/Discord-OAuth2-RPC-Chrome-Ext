import { CALLBACK_PAGE } from '../shared/messages.ts'
import type { Command } from '../shared/messages.ts'
import { isExtensionPageUrl, isExtensionPath } from '../lib/urls.ts'

export interface SenderLike {
  id?: string
  url?: string
}

/**
 * Commands are accepted only from this extension's own pages. `completeAuth`
 * additionally requires the sender to be the callback page (path only: the
 * page strips the query string from its location before messaging).
 */
export function isSenderAllowed(sender: SenderLike, extensionId: string, type: Command['type']): boolean {
  if (!extensionId || sender.id !== extensionId) return false
  if (!isExtensionPageUrl(sender.url, extensionId)) return false
  if (type === 'completeAuth') return isExtensionPath(sender.url, extensionId, CALLBACK_PAGE)
  return true
}

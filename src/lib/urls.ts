/**
 * URL comparison helpers.
 *
 * `URL.origin` is the opaque string "null" for chrome-extension: URLs in some
 * runtimes (including Node), so two different extension IDs could compare
 * equal. Everything here compares protocol, hostname, port and pathname
 * explicitly and rejects embedded credentials.
 */

export function sameLocation(a: URL, b: URL): boolean {
  if (a.username || a.password || b.username || b.password) return false
  return (
    a.protocol === b.protocol &&
    a.hostname === b.hostname &&
    a.port === b.port &&
    a.pathname === b.pathname
  )
}

export function isSameLocationString(candidate: string | undefined | null, expected: string): boolean {
  if (!candidate) return false
  try {
    return sameLocation(new URL(candidate), new URL(expected))
  } catch {
    return false
  }
}

/** True for a page of this extension (`chrome-extension://<id>/...`). */
export function isExtensionPageUrl(candidate: string | undefined | null, extensionId: string): boolean {
  if (!candidate || !extensionId) return false
  try {
    const url = new URL(candidate)
    return (
      url.protocol === 'chrome-extension:' &&
      url.hostname === extensionId &&
      !url.username &&
      !url.password
    )
  } catch {
    return false
  }
}

/** True for exactly `chrome-extension://<id>/<path>` (query/hash ignored). */
export function isExtensionPath(
  candidate: string | undefined | null,
  extensionId: string,
  path: string,
): boolean {
  if (!isExtensionPageUrl(candidate, extensionId)) return false
  return new URL(candidate as string).pathname === `/${path.replace(/^\//, '')}`
}

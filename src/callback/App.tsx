import { useEffect, useRef, useState } from 'react'
import { Alert, Box, Button, Heading, Spinner, Stack, Text } from '@chakra-ui/react'
import type { Snapshot } from '@/shared/types'
import { completeAuth, getSnapshot, startAuth, subscribe } from '@/shared/client'

type View =
  | { kind: 'loading' }
  | { kind: 'processing' }
  | { kind: 'denied' }
  | { kind: 'failed'; message: string }
  | { kind: 'snapshot'; snapshot: Snapshot }
  | { kind: 'idle' }

// One completeAuth call per page load, even when StrictMode mounts twice.
// The authorization code is single use, so this promise is never retried.
let authPromise: Promise<Snapshot> | null = null

export function completeAuthOnce(url: string): Promise<Snapshot> {
  if (!authPromise) authPromise = completeAuth(url)
  return authPromise
}

// Remove the query string (code, state, error) from the address bar and tab history.
function clearAuthParams() {
  try {
    window.history.replaceState(null, '', window.location.pathname)
  } catch {
    // Some browsers restrict history changes; nothing else to do.
  }
}

function sanitize(raw: string): string {
  return raw
    .replace(
      /(code|state|secret|client_secret|token|access_token|refresh_token)=[^\s&]+/gi,
      '$1=[removed]',
    )
    .replace(/code:[^\s]+/gi, 'code:[removed]')
}

// The worker only produces this exact prefix after it has matched the callback
// to a pending authorization (state and expiry already validated). Any other
// message, including expired or mismatched callbacks, is never treated as a cancel.
const DENIED_PATTERN = /^Discord authorization failed: access_denied(?:\s|$|\()/

function isDeniedByUser(message: string): boolean {
  return DENIED_PATTERN.test(message)
}

// A real provider redirect carries code, state or error. A plain visit has none.
function hasCallbackParams(search: string): boolean {
  const params = new URLSearchParams(search)
  return params.has('code') || params.has('state') || params.has('error')
}

const RESTART = 'Start authorization again from settings.'

function settingsUrl(): string | null {
  try {
    if (typeof chrome !== 'undefined' && chrome.runtime?.getURL) {
      return chrome.runtime.getURL('src/sidepanel/index.html')
    }
  } catch {
    // Not running inside the extension.
  }
  return null
}

export default function CallbackApp() {
  const [view, setView] = useState<View>({ kind: 'loading' })
  const [closeBlocked, setCloseBlocked] = useState(false)
  const [signingIn, setSigningIn] = useState(false)
  const [signInStarted, setSignInStarted] = useState(false)
  const [needsClientId, setNeedsClientId] = useState(false)
  const [signInError, setSignInError] = useState<string | null>(null)
  const mountedRef = useRef(true)
  // Set once the local result is final (failed, denied). Later snapshots from the
  // worker must not replace it with unrelated state.
  const lockedRef = useRef(false)
  // Snapshots are applied only after the initial resolution settles.
  const readyRef = useRef(false)

  useEffect(() => {
    mountedRef.current = true
    const isCallback = hasCallbackParams(window.location.search)
    const url = window.location.href
    clearAuthParams()

    const unsubscribe = subscribe((snapshot) => {
      if (!mountedRef.current || !readyRef.current || lockedRef.current) return
      setView({ kind: 'snapshot', snapshot })
    })

    if (isCallback) {
      setView({ kind: 'processing' })
      completeAuthOnce(url)
        .then((snapshot) => {
          readyRef.current = true
          if (mountedRef.current) setView({ kind: 'snapshot', snapshot })
        })
        .catch((err: unknown) => {
          readyRef.current = true
          lockedRef.current = true
          const message = err instanceof Error ? err.message : String(err)
          if (!mountedRef.current) return
          setView(isDeniedByUser(message) ? { kind: 'denied' } : { kind: 'failed', message: sanitize(message) })
        })
    } else {
      getSnapshot()
        .then((snapshot) => {
          readyRef.current = true
          if (!mountedRef.current) return
          setView(snapshot.connection === 'disconnected' && !snapshot.error ? { kind: 'idle' } : { kind: 'snapshot', snapshot })
        })
        .catch(() => {
          readyRef.current = true
          if (mountedRef.current) setView({ kind: 'idle' })
        })
    }

    return () => {
      mountedRef.current = false
      unsubscribe()
    }
  }, [])

  const handleClose = () => {
    window.close()
    // Browsers refuse window.close() for tabs they did not script-open.
    window.setTimeout(() => setCloseBlocked(true), 300)
  }

  const handleSignIn = async () => {
    setSigningIn(true)
    setSignInError(null)
    setNeedsClientId(false)
    try {
      const current = await getSnapshot()
      if (!current.settings.clientId.trim()) {
        if (mountedRef.current) setNeedsClientId(true)
        return
      }
      const next = await startAuth()
      if (!mountedRef.current) return
      lockedRef.current = false
      readyRef.current = true
      setSignInStarted(true)
      setView({ kind: 'snapshot', snapshot: next })
    } catch (err: unknown) {
      if (!mountedRef.current) return
      const message = err instanceof Error ? err.message : String(err)
      setSignInError(sanitize(message))
    } finally {
      if (mountedRef.current) setSigningIn(false)
    }
  }

  let title = 'Finishing sign-in'
  let body: string | null = 'Sending the authorization to the extension.'
  let errorText: string | null = null
  let busy = true
  let canSignIn = false

  switch (view.kind) {
    case 'loading':
      title = 'Checking sign-in'
      body = null
      break
    case 'processing':
      break
    case 'denied':
      busy = false
      canSignIn = true
      title = 'Sign-in cancelled'
      body = 'Discord authorization was cancelled or declined. You can try again.'
      break
    case 'failed':
      busy = false
      canSignIn = true
      title = 'Authorization failed'
      body = RESTART
      errorText = view.message
      break
    case 'idle':
      busy = false
      canSignIn = true
      title = 'Sign in with Discord'
      body = 'Authorize this extension to show your activity.'
      break
    case 'snapshot': {
      const { snapshot } = view
      const name = snapshot.user ? `@${snapshot.user.username}` : null
      switch (snapshot.connection) {
        case 'connected':
          busy = false
          title = 'Signed in'
          body = `${name ? `Signed in as ${name}. ` : ''}The Discord gateway is connected. Activity visibility is controlled in the side panel.`
          break
        case 'connecting':
          title = 'Authorization saved'
          body = 'Connecting to the Discord gateway. The side panel shows the connection status.'
          break
        case 'error':
          busy = false
          canSignIn = true
          title = 'Authorization failed'
          body = RESTART
          errorText = snapshot.error ? sanitize(snapshot.error) : null
          break
        case 'disconnected':
          busy = false
          canSignIn = true
          title = 'Sign-in not active'
          body = `Sign-in was cancelled or the session was disconnected. ${RESTART}`
          break
        case 'authorizing':
        default:
          if (signInStarted) {
            title = 'Waiting for Discord'
            body = 'Finish sign-in in the authorization tab that opened.'
          } else {
            title = 'Finishing sign-in'
            body = 'Waiting for the extension to finish.'
          }
          break
      }
      break
    }
  }

  const settingsHref = settingsUrl()

  return (
    <Box minH="100vh" display="flex" alignItems="center" justifyContent="center" p={{ base: 4, md: 6 }}>
      <Stack gap={4} w="100%" maxW="420px" minW={0} align="center" textAlign="center">
        <Stack gap={2} align="center">
          {busy && <Spinner size="md" color="blue.solid" />}
          <Heading as="h1" size="md" color="fg">
            {title}
          </Heading>
          {body && (
            <Text fontSize="sm" color="fg.muted" role={busy ? 'status' : undefined}>
              {body}
            </Text>
          )}
        </Stack>

        {errorText && (
          <Alert.Root status="error" alignItems="flex-start" textAlign="left">
            <Alert.Content minW={0}>
              <Alert.Description wordBreak="break-word">{errorText}</Alert.Description>
            </Alert.Content>
          </Alert.Root>
        )}

        {needsClientId && (
          <Alert.Root status="warning" alignItems="flex-start" textAlign="left">
            <Alert.Content minW={0}>
              <Alert.Description>
                Set your Client ID in extension settings first.
                {settingsHref && (
                  <>
                    {' '}
                    <a href={settingsHref} style={{ textDecoration: 'underline' }}>
                      Open settings
                    </a>
                  </>
                )}
              </Alert.Description>
            </Alert.Content>
          </Alert.Root>
        )}

        {signInError && (
          <Alert.Root status="error" alignItems="flex-start" textAlign="left" role="alert">
            <Alert.Content minW={0}>
              <Alert.Description wordBreak="break-word">{signInError}</Alert.Description>
            </Alert.Content>
          </Alert.Root>
        )}

        <Stack gap={2} align="center">
          {canSignIn && (
            <Button size="sm" colorPalette="blue" onClick={handleSignIn} disabled={signingIn}>
              {signingIn && <Spinner size="sm" />}
              <span>Sign in with Discord</span>
            </Button>
          )}
          <Button size="sm" variant={canSignIn ? 'ghost' : 'subtle'} onClick={handleClose}>
            Close tab
          </Button>
          {closeBlocked && (
            <Text fontSize="xs" color="fg.muted">
              You can close this tab.
            </Text>
          )}
        </Stack>
      </Stack>
    </Box>
  )
}

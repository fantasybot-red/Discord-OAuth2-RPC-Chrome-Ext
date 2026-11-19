import { Button, Dialog, Portal, Stack, Text } from '@chakra-ui/react'
import type { ConnectionState } from '@/shared/types'
import { Spinner } from '../icons'

interface ConnectGateProps {
  open: boolean
  connection: ConnectionState
  error: string | null
  isConnecting: boolean
  isDisconnecting: boolean
  onSignIn: () => void
  onCancel: () => void
  onOpenSettings: () => void
}

function clean(raw: string): string {
  return raw
    .replace(/(code|state|secret|client_secret|token|access_token|refresh_token)=[^\s&]+/gi, '$1=[removed]')
    .replace(/code:[^\s]+/gi, 'code:[removed]')
}

export function ConnectGate({
  open,
  connection,
  error,
  isConnecting,
  isDisconnecting,
  onSignIn,
  onCancel,
  onOpenSettings,
}: ConnectGateProps) {
  const pending = connection === 'authorizing' || connection === 'connecting'

  let description = 'Sign in with Discord to edit and save your activity.'
  if (connection === 'authorizing') description = 'Finish sign-in in the Discord authorization tab.'
  else if (connection === 'connecting') description = 'Connecting to the Discord gateway.'
  else if (connection === 'error') description = 'Sign-in did not complete. You can try again.'

  return (
    <Dialog.Root
      open={open}
      closeOnEscape={false}
      closeOnInteractOutside={false}
      placement="center"
      lazyMount
      unmountOnExit
    >
      <Portal>
        <Dialog.Backdrop />
        <Dialog.Positioner p={4}>
          <Dialog.Content w="100%" maxW="sm" mx="auto">
            <Dialog.Header>
              <Dialog.Title fontSize="md">Connect Discord</Dialog.Title>
            </Dialog.Header>
            <Dialog.Body>
              <Stack gap={3}>
                <Dialog.Description fontSize="sm" color="fg.muted">
                  {description}
                </Dialog.Description>
                {connection === 'error' && error && (
                  <Text fontSize="xs" color="fg.error" wordBreak="break-word" role="alert">
                    {clean(error)}
                  </Text>
                )}
              </Stack>
            </Dialog.Body>
            <Dialog.Footer flexWrap="wrap" gap={2}>
              <Button size="sm" variant="ghost" onClick={onOpenSettings}>
                Open settings
              </Button>
              {pending ? (
                <Button size="sm" colorPalette="red" variant="subtle" onClick={onCancel} disabled={isDisconnecting}>
                  {isDisconnecting && <Spinner size={14} />}
                  <span>Cancel sign-in</span>
                </Button>
              ) : (
                <Button size="sm" colorPalette="blue" onClick={onSignIn} disabled={isConnecting}>
                  {isConnecting && <Spinner size={14} />}
                  <span>Sign in with Discord</span>
                </Button>
              )}
            </Dialog.Footer>
          </Dialog.Content>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  )
}

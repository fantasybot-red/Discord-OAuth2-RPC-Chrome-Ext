import { useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import {
  Badge,
  Box,
  Button,
  Flex,
  HStack,
  IconButton,
  Input,
  Separator,
  Stack,
  Text,
} from '@chakra-ui/react'
import type { ConnectionState, Settings } from '@/shared/types'
import { CheckIcon, CopyIcon, EyeIcon, EyeOffIcon, Spinner } from '../icons'

interface CredentialsSectionProps {
  settings: Settings
  connection: ConnectionState
  redirectUri: string
  hasCredentials: boolean
  onSave: (settings: Settings) => Promise<boolean>
  onConnect: () => Promise<void>
  onDisconnect: () => Promise<void>
  isSaving: boolean
  isConnecting: boolean
  isDisconnecting: boolean
}

export function CredentialsSection({
  settings,
  connection,
  redirectUri,
  hasCredentials,
  onSave,
  onConnect,
  onDisconnect,
  isSaving,
  isConnecting,
  isDisconnecting,
}: CredentialsSectionProps) {
  const [clientId, setClientId] = useState(settings.clientId)
  const [clientSecret, setClientSecret] = useState(settings.clientSecret)
  const [isUserEdited, setIsUserEdited] = useState(false)
  const [showSecret, setShowSecret] = useState(false)
  const [copiedUri, setCopiedUri] = useState(false)

  // Sync server settings only when user has not dirty-edited the form
  useEffect(() => {
    if (!isUserEdited) {
      setClientId(settings.clientId)
      setClientSecret(settings.clientSecret)
    }
  }, [settings.clientId, settings.clientSecret, isUserEdited])

  const handleCopyUri = async () => {
    try {
      await navigator.clipboard.writeText(redirectUri)
      setCopiedUri(true)
      setTimeout(() => setCopiedUri(false), 2000)
    } catch {
      // clipboard fallback
    }
  }

  const handleClientIdChange = (val: string) => {
    setClientId(val)
    setIsUserEdited(true)
  }

  const handleClientSecretChange = (val: string) => {
    setClientSecret(val)
    setIsUserEdited(true)
  }

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault()
    const success = await onSave({ clientId: clientId.trim(), clientSecret: clientSecret.trim() })
    if (success) {
      setIsUserEdited(false)
    }
  }

  const isFormDirty =
    clientId.trim() !== settings.clientId || clientSecret.trim() !== settings.clientSecret

  const isAuthPending = connection === 'authorizing' || connection === 'connecting'
  const isBusy = isSaving || isConnecting || isDisconnecting

  return (
    <Box w="100%">
      <Flex align="center" justify="space-between" mb={3}>
        <Text fontSize="md" fontWeight="600" color="fg">
          OAuth credentials
        </Text>
        {hasCredentials && (
          <Badge colorPalette="gray" variant="subtle" size="sm">
            Credentials stored
          </Badge>
        )}
      </Flex>

      <form onSubmit={handleSubmit}>
        <Stack gap={3.5}>
          {/* Client ID */}
          <Box>
            <div className="ui-label-row">
              <label htmlFor="oauth-client-id-input" className="ui-label" style={{ marginBottom: 0 }}>
                Client ID
              </label>
              <span className="ui-label-hint">Required</span>
            </div>
            <Input
              id="oauth-client-id-input"
              size="sm"
              placeholder="e.g. 123456789012345678"
              value={clientId}
              onChange={(e) => handleClientIdChange(e.target.value)}
              autoComplete="off"
              spellCheck={false}
              disabled={isBusy}
            />
          </Box>

          {/* Client Secret */}
          <Box>
            <div className="ui-label-row">
              <label htmlFor="oauth-client-secret-input" className="ui-label" style={{ marginBottom: 0 }}>
                Client secret
              </label>
              <span className="ui-label-hint">Optional in public client mode</span>
            </div>
            <Flex gap={2}>
              <Input
                id="oauth-client-secret-input"
                size="sm"
                type={showSecret ? 'text' : 'password'}
                placeholder="Leave blank if public client is enabled"
                value={clientSecret}
                onChange={(e) => handleClientSecretChange(e.target.value)}
                autoComplete="off"
                spellCheck={false}
                disabled={isBusy}
              />
              <IconButton
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => setShowSecret(!showSecret)}
                aria-label={showSecret ? 'Hide secret' : 'Show secret'}
              >
                {showSecret ? <EyeOffIcon size={14} /> : <EyeIcon size={14} />}
              </IconButton>
            </Flex>
          </Box>

          {/* Callback URL */}
          <Box>
            <label htmlFor="oauth-callback-url-input" className="ui-label">
              Callback URL
            </label>
            <Flex gap={2}>
              <Input
                id="oauth-callback-url-input"
                size="sm"
                readOnly
                color="fg.muted"
                fontFamily="mono"
                fontSize="2xs"
                value={redirectUri}
              />
              <IconButton
                type="button"
                size="sm"
                variant="ghost"
                onClick={handleCopyUri}
                aria-label="Copy callback URL"
              >
                {copiedUri ? <CheckIcon size={14} /> : <CopyIcon size={14} />}
              </IconButton>
            </Flex>
          </Box>

          {/* Storage notice */}
          <Text fontSize="2xs" color="fg.muted" lineHeight="1.4">
            Credentials are saved locally in browser storage unencrypted. OAuth tokens and
            presence requests are sent only to official Discord endpoints and the Discord
            Social SDK gateway (gateway.gaming-sdk.com). Site icon services (Google S2,
            Icon Horse) fetch icons by domain name only.
          </Text>

          {/* Dirty Form Instruction */}
          {isFormDirty && (
            <Text fontSize="xs" color="fg.warning">
              Save credentials first before authorizing with Discord.
            </Text>
          )}

          {/* Action Buttons */}
          <HStack gap={2.5} pt={1}>
            <Button
              type="submit"
              size="sm"
              variant="subtle"
              flex={1}
              disabled={isBusy || !isFormDirty}
            >
              {isSaving && <Spinner size={14} />}
              <span>Save settings</span>
            </Button>

            {isAuthPending ? (
              <Button
                type="button"
                size="sm"
                colorPalette="red"
                flex={1.2}
                onClick={onDisconnect}
                disabled={isDisconnecting}
              >
                {isDisconnecting && <Spinner size={14} />}
                <span>Cancel sign-in</span>
              </Button>
            ) : connection === 'connected' ? (
              <Button
                type="button"
                size="sm"
                colorPalette="red"
                variant="subtle"
                flex={1.2}
                onClick={onDisconnect}
                disabled={isBusy}
              >
                {isDisconnecting && <Spinner size={14} />}
                <span>Disconnect</span>
              </Button>
            ) : (
              <Button
                type="button"
                size="sm"
                colorPalette="blue"
                flex={1.2}
                onClick={onConnect}
                disabled={isBusy || isFormDirty || !clientId.trim() || isAuthPending}
              >
                {isConnecting && <Spinner size={14} />}
                <span>Sign in with Discord</span>
              </Button>
            )}
          </HStack>

          {/* Accessible Disconnect for Stored Credentials */}
          {hasCredentials && !isAuthPending && connection !== 'connected' && (
            <Flex justify="flex-end" pt={1}>
              <Button
                type="button"
                size="xs"
                variant="ghost"
                colorPalette="red"
                onClick={onDisconnect}
                disabled={isBusy}
              >
                <span>Disconnect session</span>
              </Button>
            </Flex>
          )}
        </Stack>
      </form>

      <Separator borderColor="border.subtle" mt={4} />
    </Box>
  )
}

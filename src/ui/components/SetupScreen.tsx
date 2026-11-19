import { Alert, Box, Button, Grid, Heading, Spinner, Stack, Text } from '@chakra-ui/react'
import { useSetupFlow } from '../useSetupFlow'
import { CredentialsSection } from './CredentialsSection'
import { SetupSteps } from './SetupSteps'

interface SetupScreenProps {
  /** 'page' is the full tab opened on install; 'panel' is the side panel before a Client ID exists. */
  mode: 'page' | 'panel'
}

function settingsHref(): string | null {
  try {
    if (typeof chrome !== 'undefined' && chrome.runtime?.getURL) {
      return chrome.runtime.getURL('src/sidepanel/index.html')
    }
  } catch {
    // Not running inside the extension.
  }
  return null
}

export function SetupScreen({ mode }: SetupScreenProps) {
  const flow = useSetupFlow()
  const { snapshot } = flow

  const fallbackRedirect =
    typeof chrome !== 'undefined' && chrome.runtime?.getURL
      ? chrome.runtime.getURL('callback.html')
      : 'chrome-extension://<id>/callback.html'

  const connected = snapshot?.connection === 'connected'
  const href = settingsHref()

  return (
    <Box
      minH="100dvh"
      w="100%"
      minW={0}
      bg="var(--app-bg)"
      color="fg"
      display="flex"
      justifyContent="center"
      px={{ base: 4, md: 8 }}
      py={{ base: 6, md: 12 }}
    >
      <Stack as="main" gap={8} w="100%" maxW="960px" minW={0}>
        <Stack gap={2}>
          <Heading as="h1" size="xl" color="fg">
            Set up Discord presence
          </Heading>
          <Text fontSize="md" color="fg.muted" maxW="60ch">
            Connect your own Discord application so the extension can show your browser activity.
            You only do this once.
          </Text>
        </Stack>

        {snapshot === null && !flow.loadFailed && (
          <Spinner size="md" color="blue.solid" aria-label="Loading setup" />
        )}

        {flow.loadFailed && (
          <Alert.Root status="error" role="alert">
            <Alert.Content>
              <Alert.Description>
                Could not reach the extension. Reload the extension and open this page again.
              </Alert.Description>
            </Alert.Content>
          </Alert.Root>
        )}

        {snapshot !== null && mode === 'page' && connected && (
          <Stack gap={3} role="status">
            <Heading as="h2" size="md" color="fg">
              Discord is connected
            </Heading>
            <Text fontSize="sm" color="fg.muted" maxW="60ch">
              Setup is complete. Open the extension settings to choose what to share.
            </Text>
            {href && (
              <Box>
                <Button asChild size="sm" colorPalette="blue">
                  <a href={href}>Open extension settings</a>
                </Button>
              </Box>
            )}
          </Stack>
        )}

        {snapshot !== null && !(mode === 'page' && connected) && (
          <Grid
            templateColumns={{ base: 'minmax(0, 1fr)', lg: 'minmax(0, 1fr) minmax(0, 1fr)' }}
            gap={{ base: 8, lg: 12 }}
            alignItems="start"
          >
            <Stack gap={3}>
              <Heading as="h2" size="md" color="fg">
                Steps
              </Heading>
              <SetupSteps />
            </Stack>

            <CredentialsSection
              settings={snapshot.settings}
              connection={snapshot.connection}
              redirectUri={snapshot.redirectUri || fallbackRedirect}
              hasCredentials={snapshot.hasCredentials}
              onSave={flow.save}
              onConnect={flow.connect}
              onDisconnect={flow.cancel}
              isSaving={flow.isSaving}
              isConnecting={flow.isConnecting}
              isDisconnecting={flow.isDisconnecting}
            />
          </Grid>
        )}

        {snapshot?.error && !connected && (
          <Alert.Root status="error" role="alert">
            <Alert.Content minW={0}>
              <Alert.Description wordBreak="break-word">{snapshot.error}</Alert.Description>
            </Alert.Content>
          </Alert.Root>
        )}
      </Stack>
    </Box>
  )
}

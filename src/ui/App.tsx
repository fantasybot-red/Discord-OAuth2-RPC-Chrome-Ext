import { useEffect, useState } from 'react'
import { Box, Button, Flex, Grid, Stack, Tabs, Text } from '@chakra-ui/react'
import { DEFAULT_TRACKING } from '@/shared/types'
import type { Activity, Settings, Snapshot, TrackingSettings } from '@/shared/types'
import {
  disconnect,
  getSnapshot,
  saveSettings,
  saveTrackingSettings,
  setActivity,
  startAuth,
  subscribe,
  toggleTracking,
} from '@/shared/client'
import { toaster } from './toaster'
import { Header } from './components/Header'
import { UserProfile } from './components/UserProfile'
import { PortalGuide } from './components/PortalGuide'
import { CredentialsSection } from './components/CredentialsSection'
import { ActivitySection } from './components/ActivitySection'
import { PresencePreview } from './components/PresencePreview'
import { TrackingSection } from './components/TrackingSection'
import { ConnectGate } from './components/ConnectGate'
import { SetupScreen } from './components/SetupScreen'
import { DebugSection } from './components/DebugSection'
import { WorkerInfo } from './components/WorkerInfo'
import './styles.css'

interface AppProps {
  mode: 'popup' | 'sidepanel'
}

type TabKey = 'activity' | 'settings'

export function App({ mode }: AppProps) {
  const [activeTab, setActiveTab] = useState<TabKey>('activity')
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null)

  // Draft state for the activity form and preview
  const [activityDraft, setActivityDraft] = useState<Activity>({
    name: '',
    type: 0,
    details: '',
    state: '',
    largeImage: '',
    largeText: '',
    smallImage: '',
    smallText: '',
    buttons: [],
    timestamps: { start: '', end: '' },
  })
  const [hasActivityDraftModified, setHasActivityDraftModified] = useState(false)

  // Action Pending States
  const [isSaving, setIsSaving] = useState(false)
  const [isConnecting, setIsConnecting] = useState(false)
  const [isDisconnecting, setIsDisconnecting] = useState(false)
  const [isApplying, setIsApplying] = useState(false)
  const [isTogglingTracking, setIsTogglingTracking] = useState(false)

  // Compute fallback redirectUri
  const fallbackRedirectUri =
    typeof chrome !== 'undefined' && chrome.runtime?.getURL
      ? chrome.runtime.getURL('callback.html')
      : 'chrome-extension://<id>/callback.html'

  const redirectUri = snapshot?.redirectUri || fallbackRedirectUri

  // Subscribe to background state & fetch initial snapshot
  useEffect(() => {
    let mounted = true

    getSnapshot()
      .then((data) => {
        if (!mounted) return
        setSnapshot(data)
        if (!hasActivityDraftModified && data.activity) {
          setActivityDraft(data.activity)
        }
      })
      .catch((err) => {
        if (!mounted) return
        toaster.create({
          title: err?.message || 'Could not communicate with service worker.',
          type: 'error',
          duration: 5000,
        })
      })

    const unsubscribe = subscribe((newSnapshot) => {
      if (!mounted) return
      setSnapshot(newSnapshot)
      if (!hasActivityDraftModified && newSnapshot.activity) {
        setActivityDraft(newSnapshot.activity)
      }
    })

    return () => {
      mounted = false
      unsubscribe()
    }
  }, [hasActivityDraftModified])

  // Handlers
  const handleSaveSettings = async (settings: Settings): Promise<boolean> => {
    try {
      setIsSaving(true)
      const next = await saveSettings(settings)
      setSnapshot(next)
      toaster.create({
        title: 'Credentials saved.',
        type: 'success',
        duration: 3000,
      })
      return true
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      toaster.create({
        title: `Failed to save credentials: ${msg}`,
        type: 'error',
        duration: 5000,
      })
      return false
    } finally {
      setIsSaving(false)
    }
  }

  const handleConnect = async () => {
    try {
      setIsConnecting(true)
      const next = await startAuth()
      setSnapshot(next)
      toaster.create({
        title: 'Opened Discord authorization tab.',
        type: 'info',
        duration: 4000,
      })
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      toaster.create({
        title: `Connection failed: ${msg}`,
        type: 'error',
        duration: 5000,
      })
    } finally {
      setIsConnecting(false)
    }
  }

  const handleDisconnect = async () => {
    try {
      setIsDisconnecting(true)
      const next = await disconnect()
      setSnapshot(next)
      toaster.create({
        title: 'Presence disconnected.',
        type: 'info',
        duration: 3000,
      })
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      toaster.create({
        title: `Failed to disconnect: ${msg}`,
        type: 'error',
        duration: 5000,
      })
    } finally {
      setIsDisconnecting(false)
    }
  }

  const handleActivityChange = (updated: Activity) => {
    setActivityDraft(updated)
    setHasActivityDraftModified(true)
  }

  const handleApplyActivity = async (activity: Activity) => {
    try {
      setIsApplying(true)
      const next = await setActivity(activity)
      setSnapshot(next)
      setHasActivityDraftModified(false)
      if (next.activity) {
        setActivityDraft(next.activity)
      }
      toaster.create({
        title: 'Activity saved.',
        type: 'success',
        duration: 3000,
      })
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      toaster.create({
        title: `Failed to save activity: ${msg}`,
        type: 'error',
        duration: 5000,
      })
    } finally {
      setIsApplying(false)
    }
  }

  // Flips the saved tracking preference. Never touches OAuth or opens auth.
  const handleToggleTracking = async () => {
    if (isTogglingTracking) return
    setIsTogglingTracking(true)
    try {
      const next = await toggleTracking()
      setSnapshot(next)
      toaster.create({
        title: next.tracking.enabled ? 'Tracking enabled.' : 'Tracking disabled.',
        type: 'info',
        duration: 3000,
      })
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      toaster.create({
        title: `Failed to change tracking: ${msg}`,
        type: 'error',
        duration: 5000,
      })
    } finally {
      setIsTogglingTracking(false)
    }
  }

  const handleSaveTracking = async (trackingSettings: TrackingSettings): Promise<boolean> => {
    try {
      const next = await saveTrackingSettings(trackingSettings)
      setSnapshot(next)
      toaster.create({
        title: 'Tracking settings saved.',
        type: 'success',
        duration: 3000,
      })
      return true
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      toaster.create({
        title: `Failed to save tracking: ${msg}`,
        type: 'error',
        duration: 5000,
      })
      return false
    }
  }

  // Snapshot-derived values
  const connection = snapshot?.connection || 'disconnected'
  const hasCredentials = Boolean(snapshot?.hasCredentials)
  const user = snapshot?.user || null
  const currentSettings: Settings = snapshot?.settings || {
    clientId: '',
    clientSecret: '',
  }
  const activityEnabled = Boolean(snapshot?.activityEnabled)
  const trackingSettings: TrackingSettings = snapshot?.tracking || DEFAULT_TRACKING
  const browserContext = snapshot?.browser || null
  const trackingError = snapshot?.trackingError || null

  // The client secret is optional (public client + PKCE), so only a saved
  // Client ID counts as configured. Without one, the whole panel is the setup
  // screen (no header, tabs or editor), shown only once the snapshot has loaded.
  const hasClientId = Boolean(currentSettings.clientId.trim())
  const needsSetup = snapshot !== null && !hasClientId
  // Gate only the Activity tab, once the snapshot has loaded (no flash of
  // "disconnected" while loading). Settings stays usable.
  const gateOpen = snapshot !== null && connection !== 'connected' && activeTab === 'activity'

  const bannerProps = {
    align: 'center',
    justify: 'space-between',
    gap: 3,
    p: 3,
    borderRadius: 'md',
    borderWidth: '1px',
  } as const

  if (needsSetup) return <SetupScreen mode="panel" />

  return (
    <Box
      minH="100vh"
      w="100%"
      minW={0}
      bg="var(--app-bg)"
      color="fg"
      fontSize="sm"
      data-surface={mode}
    >
      <Header connection={connection} trackingEnabled={trackingSettings.enabled} />

      <Tabs.Root
        value={activeTab}
        onValueChange={(e) => setActiveTab(e.value as TabKey)}
        variant="line"
        w="100%"
      >
        <Tabs.List
          bg="var(--app-bg)"
          px={{ base: 3, md: 6 }}
          borderBottomWidth="1px"
          borderColor="border.subtle"
          gap={4}
        >
          <Tabs.Trigger value="activity" fontSize="sm" py={3} px={2}>
            Activity
          </Tabs.Trigger>
          <Tabs.Trigger value="settings" fontSize="sm" py={3} px={2}>
            Settings
          </Tabs.Trigger>
        </Tabs.List>

        <Box px={{ base: 3, md: 6 }} py={{ base: 3, md: 5 }} minW={0}>
          <Stack gap={4} minW={0}>
            {user && connection === 'connected' && (
              <UserProfile
                user={user}
                connection={connection}
                trackingEnabled={trackingSettings.enabled}
                onToggleTracking={handleToggleTracking}
                isToggling={isTogglingTracking}
              />
            )}

            {/* Actionable Persistent Status Banners */}
            {snapshot?.error && (
              <Flex {...bannerProps} bg="bg.error" borderColor="border.error">
                <Text fontSize="sm" color="fg.error" wordBreak="break-word" minW={0}>
                  {snapshot.error}
                </Text>
                <Button
                  size="xs"
                  variant="ghost"
                  onClick={handleDisconnect}
                  disabled={isDisconnecting}
                  flexShrink={0}
                >
                  Reset
                </Button>
              </Flex>
            )}

            {connection === 'authorizing' && (
              <Flex {...bannerProps} bg="bg.warning" borderColor="border.warning">
                <Text fontSize="sm" color="fg.warning" minW={0}>
                  Discord login in progress in a new tab
                </Text>
                <Button
                  size="xs"
                  variant="ghost"
                  colorPalette="red"
                  onClick={handleDisconnect}
                  disabled={isDisconnecting}
                  flexShrink={0}
                >
                  Cancel
                </Button>
              </Flex>
            )}

            {connection === 'connecting' && (
              <Flex {...bannerProps} bg="bg.warning" borderColor="border.warning">
                <Text fontSize="sm" color="fg.warning" minW={0}>
                  Connecting to Discord gateway
                </Text>
                <Button
                  size="xs"
                  variant="ghost"
                  colorPalette="red"
                  onClick={handleDisconnect}
                  disabled={isDisconnecting}
                  flexShrink={0}
                >
                  Cancel
                </Button>
              </Flex>
            )}

            {/* TAB 1: ACTIVITY & LIVE PREVIEW (Responsive: 1 col on mobile, 2 cols on wide) */}
            <Tabs.Content value="activity" p={0}>
              <Grid
                templateColumns={{ base: 'minmax(0, 1fr)', lg: 'minmax(0, 1.2fr) minmax(0, 0.8fr)' }}
                gap={5}
                alignItems="start"
              >
                <ActivitySection
                  activity={activityDraft}
                  activityEnabled={activityEnabled}
                  allowUrlSharing={trackingSettings.allowUrlSharing}
                  onChange={handleActivityChange}
                  onApply={handleApplyActivity}
                  isApplying={isApplying}
                />

                <PresencePreview
                  activity={activityDraft}
                  browser={browserContext}
                  tracking={trackingSettings}
                  enabled={activityEnabled && connection === 'connected'}
                />
              </Grid>
            </Tabs.Content>

            {/* TAB 2: SETTINGS (Integrated, flat document layout) */}
            <Tabs.Content value="settings" p={0}>
              <Grid
                templateColumns={{ base: 'minmax(0, 1fr)', lg: 'minmax(0, 1fr) minmax(0, 1fr)' }}
                gap={6}
                alignItems="start"
              >
                <Stack gap={5}>
                  <TrackingSection
                    tracking={trackingSettings}
                    browser={browserContext}
                    trackingError={trackingError}
                    onSaveTracking={handleSaveTracking}
                  />

                  <DebugSection />

                  <WorkerInfo connection={connection} activityEnabled={activityEnabled} />
                </Stack>

                <Stack gap={5}>
                  <CredentialsSection
                    settings={currentSettings}
                    connection={connection}
                    redirectUri={redirectUri}
                    hasCredentials={hasCredentials}
                    onSave={handleSaveSettings}
                    onConnect={handleConnect}
                    onDisconnect={handleDisconnect}
                    isSaving={isSaving}
                    isConnecting={isConnecting}
                    isDisconnecting={isDisconnecting}
                  />

                  <PortalGuide />
                </Stack>
              </Grid>
            </Tabs.Content>
          </Stack>
        </Box>
      </Tabs.Root>

      <ConnectGate
        open={gateOpen}
        connection={connection}
        error={snapshot?.error ?? null}
        isConnecting={isConnecting}
        isDisconnecting={isDisconnecting}
        onSignIn={handleConnect}
        onCancel={handleDisconnect}
        onOpenSettings={() => setActiveTab('settings')}
      />
    </Box>
  )
}

export default App

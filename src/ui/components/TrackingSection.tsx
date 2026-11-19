import { useState, useEffect, useRef } from 'react'
import {
  Badge,
  Box,
  Flex,
  HStack,
  Separator,
  Stack,
  Switch,
  Text,
} from '@chakra-ui/react'
import type { BrowserContext, TrackingSettings } from '@/shared/types'
import { Spinner } from '../icons'

interface TrackingSectionProps {
  tracking: TrackingSettings
  browser: BrowserContext | null
  trackingError: string | null
  onSaveTracking: (settings: TrackingSettings) => Promise<boolean>
}

export function TrackingSection({
  tracking,
  browser,
  trackingError,
  onSaveTracking,
}: TrackingSectionProps) {
  const [optimisticTracking, setOptimisticTracking] = useState<TrackingSettings>(tracking)
  const [isPending, setIsPending] = useState(false)
  const saveSeq = useRef(0)

  // Keep optimistic state in sync with server snapshot when not saving
  useEffect(() => {
    if (!isPending) {
      setOptimisticTracking(tracking)
    }
  }, [tracking, isPending])

  const handleUpdate = async (patch: Partial<TrackingSettings>) => {
    const next: TrackingSettings = {
      ...optimisticTracking,
      ...patch,
    }
    const currentSeq = ++saveSeq.current
    setOptimisticTracking(next)
    setIsPending(true)

    const success = await onSaveTracking(next)
    if (saveSeq.current === currentSeq) {
      setIsPending(false)
      if (!success) {
        // Rollback to server snapshot on save failure
        setOptimisticTracking(tracking)
      }
    }
  }

  // Live tracking status bound to saved server state
  const getTrackingStatus = () => {
    if (!tracking.enabled) {
      return { label: 'Tracking off', color: 'gray' }
    }
    if (!browser) {
      return { label: 'Awaiting browser context', color: 'yellow' }
    }
    if (!browser.focused && tracking.hideOnUnfocus) {
      return { label: 'Chrome not focused. Activity hidden.', color: 'yellow' }
    }
    if (!browser.trackable) {
      return { label: 'No eligible tab. Activity hidden.', color: 'gray' }
    }
    return { label: 'Active and tracking tab', color: 'green' }
  }

  const status = getTrackingStatus()

  return (
    <Stack gap={4} w="100%">
      <Flex align="center" justify="space-between" w="100%">
        <Text fontSize="md" fontWeight="600" color="fg">
          Browser tracking
        </Text>
        <HStack gap={2}>
          {isPending && <Spinner size={12} />}
          <Badge colorPalette={status.color} variant="subtle" size="sm">
            {status.label}
          </Badge>
        </HStack>
      </Flex>

      {/* Tracking Toggle Switch */}
      <Stack gap={1}>
        <Switch.Root
          checked={optimisticTracking.enabled}
          onCheckedChange={(details) => handleUpdate({ enabled: details.checked })}
          disabled={isPending}
          colorPalette="blue"
        >
          <Switch.HiddenInput />
          <Switch.Control cursor="pointer">
            <Switch.Thumb />
          </Switch.Control>
          <Switch.Label fontSize="sm" color="fg" cursor="pointer">
            Track active tab title and icon
          </Switch.Label>
        </Switch.Root>
        <Text fontSize="xs" color="fg.muted" lineHeight="1.4">
          Tab titles, domains, favicons, and link targets may be visible to other Discord users when tracking is on.
        </Text>
      </Stack>

      {/* Hide on unfocus Switch */}
      <Stack gap={1}>
        <Switch.Root
          checked={optimisticTracking.hideOnUnfocus}
          onCheckedChange={(details) => handleUpdate({ hideOnUnfocus: details.checked })}
          disabled={isPending}
          colorPalette="blue"
        >
          <Switch.HiddenInput />
          <Switch.Control cursor="pointer">
            <Switch.Thumb />
          </Switch.Control>
          <Switch.Label fontSize="sm" color="fg" cursor="pointer">
            Hide activity when Chrome is not focused
          </Switch.Label>
        </Switch.Root>
        <Text fontSize="xs" color="fg.muted" lineHeight="1.4">
          When off, the last eligible tab stays visible while Chrome is in the background. Private windows stay hidden. Internal pages share titles only.
        </Text>
      </Stack>

      {/* URL Sharing Switch */}
      <Stack gap={1}>
        <Switch.Root
          checked={optimisticTracking.allowUrlSharing}
          onCheckedChange={(details) => handleUpdate({ allowUrlSharing: details.checked })}
          disabled={isPending}
          colorPalette="blue"
        >
          <Switch.HiddenInput />
          <Switch.Control cursor="pointer">
            <Switch.Thumb />
          </Switch.Control>
          <Switch.Label fontSize="sm" color="fg" cursor="pointer">
            Allow full URL sharing
          </Switch.Label>
        </Switch.Root>
        <Text fontSize="xs" color="fg.muted" lineHeight="1.4">
          Enables the {'{tab_url}'} placeholder. Full URLs may contain private query parameters or tokens. Off by default.
        </Text>
      </Stack>

      {trackingError && (
        <Box p={2.5} borderRadius="md" bg="bg.error" borderColor="border.error" borderWidth="1px">
          <Text fontSize="xs" color="fg.error">
            {trackingError}
          </Text>
        </Box>
      )}

      {/* Live Context */}
      {browser && (
        <Box pt={1}>
          <Text fontSize="xs" fontWeight="600" color="fg.muted" mb={1}>
            Current tab
          </Text>
          {browser.trackable ? (
            <Stack gap={0.5}>
              <Text fontSize="xs" color="fg" truncate>
                {browser.tabTitle || 'Untitled tab'}
              </Text>
              <Text fontSize="xs" color="fg.muted">
                {browser.tabHostname || browser.tabOrigin || 'Local'}
              </Text>
              <HStack gap={3} pt={0.5}>
                <Text fontSize="xs" color="fg.muted">
                  {browser.tabCount} total tabs
                </Text>
                <Text fontSize="xs" color="fg.muted">
                  {browser.windowCount} windows
                </Text>
              </HStack>
            </Stack>
          ) : (
            <Text fontSize="xs" color="fg.muted">
              No eligible tab. Private windows stay hidden.
            </Text>
          )}
        </Box>
      )}

      <Separator borderColor="border.subtle" />
    </Stack>
  )
}

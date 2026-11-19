import { useEffect, useState } from 'react'
import { Badge, Box, Button, Card, Flex, Stack, Text } from '@chakra-ui/react'
import type { Activity, ActivityType, BrowserContext, TrackingSettings } from '@/shared/types'
import { activityTimestamps, renderActivityTemplate } from '@/lib/templates'

interface PresencePreviewProps {
  activity: Activity
  browser: BrowserContext | null
  tracking: TrackingSettings
  enabled?: boolean
}

export function PresencePreview({ activity, browser, tracking, enabled = true }: PresencePreviewProps) {
  const [now, setNow] = useState(Date.now())

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])

  // Hide condition: when tracking is on and hideOnUnfocus is true, unfocused Chrome hides presence.
  // No eligible tab (trackable: false, e.g. a private window) always hides regardless of hideOnUnfocus.
  const isHiddenByFocus = tracking.enabled && tracking.hideOnUnfocus && browser && !browser.focused
  const isHiddenByTrackable = tracking.enabled && browser && !browser.trackable

  const effectiveContext: BrowserContext = browser || {
    focused: true,
    trackable: true,
    tabTitle: '',
    tabUrl: '',
    tabOrigin: '',
    tabHostname: '',
    tabFavicon: '',
    tabCount: 0,
    windowCount: 0,
    windowTabCount: 0,
    browserStartedAt: 0,
    tabOpenedAt: 0,
    tabActiveAt: 0,
  }

  const expanded = renderActivityTemplate(activity, effectiveContext, tracking, now)

  const getActivityTypeLabel = (type: ActivityType) => {
    switch (type) {
      case 2:
        return 'Listening to'
      case 3:
        return 'Watching'
      case 5:
        return 'Competing in'
      case 0:
      default:
        return 'Playing a game'
    }
  }

  // Calculate real timestamps via activityTimestamps (2 args: effectiveContext, activity)
  let elapsedString: string | null = null
  let timerError: string | null = null
  try {
    const timestamps = activityTimestamps(effectiveContext, activity)
    if (timestamps) {
      const pad2 = (n: number) => (n < 10 ? `0${n}` : `${n}`)
      if (timestamps.end) {
        if (timestamps.end > now) {
          const diffSec = Math.floor((timestamps.end - now) / 1000)
          const hours = Math.floor(diffSec / 3600)
          const mins = Math.floor((diffSec % 3600) / 60)
          const secs = diffSec % 60
          elapsedString =
            hours > 0
              ? `${hours}:${pad2(mins)}:${pad2(secs)} left`
              : `${mins}:${pad2(secs)} left`
        } else {
          elapsedString = 'Ended'
        }
      } else if (timestamps.start && now >= timestamps.start) {
        const diffSec = Math.floor((now - timestamps.start) / 1000)
        const hours = Math.floor(diffSec / 3600)
        const mins = Math.floor((diffSec % 3600) / 60)
        const secs = diffSec % 60
        elapsedString =
          hours > 0
            ? `${hours}:${pad2(mins)}:${pad2(secs)} elapsed`
            : `${mins}:${pad2(secs)} elapsed`
      }
    }
  } catch (err: unknown) {
    timerError = err instanceof Error ? err.message : 'Timer settings are invalid.'
  }

  const displayName = expanded.name?.trim() || 'Sample activity'
  const displayDetails = expanded.details?.trim()
  const displayState = expanded.state?.trim()
  const buttons = expanded.buttons || []
  const hasOmittedButtons = Boolean(
    activity.buttons && activity.buttons.length > 0 && buttons.length === 0,
  )

  const isHttpUrl = (str: string) => /^https?:\/\//i.test(str.trim())

  return (
    <Card.Root size="sm" bg="bg.panel" borderColor="border.subtle" w="100%">
      <Card.Header pb={2}>
        <Flex align="center" justify="space-between">
          <Card.Title fontSize="sm" fontWeight="600" color="fg">
            Preview
          </Card.Title>
          <Badge
            colorPalette={
              isHiddenByFocus || isHiddenByTrackable
                ? 'yellow'
                : enabled && activity.name.trim()
                  ? 'green'
                  : 'gray'
            }
            variant="subtle"
            size="sm"
          >
            {isHiddenByFocus
              ? 'Chrome not focused'
              : isHiddenByTrackable
                ? 'No eligible tab'
                : enabled && activity.name.trim()
                  ? 'Saved preview'
                  : 'Draft preview'}
          </Badge>
        </Flex>
      </Card.Header>

      <Card.Body pt={1}>
        {isHiddenByFocus ? (
          <Box p={4} borderRadius="md" bg="bg.muted" textAlign="center">
            <Text fontSize="xs" color="yellow.300">
              Chrome not focused. Activity hidden.
            </Text>
          </Box>
        ) : isHiddenByTrackable ? (
          <Box p={4} borderRadius="md" bg="bg.muted" textAlign="center">
            <Text fontSize="xs" color="fg.muted">
              No eligible tab. Activity hidden.
            </Text>
          </Box>
        ) : (
          <Box p={3} borderRadius="md" bg="bg.muted" borderWidth="1px" borderColor="border.subtle">
            <Text fontSize="2xs" fontWeight="700" color="fg.muted" mb={2}>
              {getActivityTypeLabel(expanded.type)}
            </Text>

            <Flex gap={3} align="flex-start">
              {/* Image asset artwork */}
              <Box position="relative" w="56px" h="56px" flexShrink={0}>
                {isHttpUrl(expanded.largeImage) ? (
                  <img
                    src={expanded.largeImage}
                    alt=""
                    style={{
                      width: '100%',
                      height: '100%',
                      borderRadius: '8px',
                      objectFit: 'cover',
                      backgroundColor: 'rgba(255, 255, 255, 0.04)',
                    }}
                    onError={(e) => {
                      ;(e.currentTarget as HTMLElement).style.display = 'none'
                    }}
                  />
                ) : (
                  <Box
                    w="100%"
                    h="100%"
                    borderRadius="md"
                    bg="bg.emphasized"
                    display="flex"
                    alignItems="center"
                    justifyContent="center"
                    fontSize="xs"
                    color="fg.muted"
                  >
                    App
                  </Box>
                )}

                {/* Small overlay badge */}
                {expanded.smallImage && (
                  isHttpUrl(expanded.smallImage) ? (
                    <img
                      src={expanded.smallImage}
                      alt=""
                      style={{
                        position: 'absolute',
                        bottom: '-4px',
                        right: '-4px',
                        width: '20px',
                        height: '20px',
                        borderRadius: '50%',
                        border: '2px solid var(--app-bg)',
                        objectFit: 'cover',
                      }}
                      onError={(e) => {
                        ;(e.currentTarget as HTMLElement).style.display = 'none'
                      }}
                    />
                  ) : (
                    <Box
                      position="absolute"
                      bottom="-4px"
                      right="-4px"
                      w="20px"
                      h="20px"
                      borderRadius="full"
                      bg="#5865f2"
                      border="2px solid var(--app-bg)"
                    />
                  )
                )}
              </Box>

              {/* Text metadata */}
              <Stack gap={0.5} flex={1} minW={0}>
                <Text fontSize="xs" fontWeight="700" color="fg" truncate>
                  {displayName}
                </Text>
                {displayDetails && (
                  <Text fontSize="xs" color="fg.muted" truncate>
                    {displayDetails}
                  </Text>
                )}
                {displayState && (
                  <Text fontSize="xs" color="fg.muted" truncate>
                    {displayState}
                  </Text>
                )}
                {elapsedString && (
                  <Text fontSize="2xs" color="fg.muted" pt={0.5}>
                    {elapsedString}
                  </Text>
                )}
                {timerError && (
                  <Text fontSize="xs" color="yellow.300" pt={0.5} wordBreak="break-word">
                    {timerError}
                  </Text>
                )}
              </Stack>
            </Flex>

            {/* Discord Link Buttons */}
            {buttons.length > 0 && (
              <Stack gap={1.5} pt={3}>
                {buttons.map((btn, i) => (
                  <Button
                    key={i}
                    size="xs"
                    variant="surface"
                    w="100%"
                    justifyContent="center"
                    fontSize="xs"
                    asChild
                  >
                    <a
                      href={isHttpUrl(btn.url) ? btn.url : undefined}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {btn.label || 'Link button'}
                    </a>
                  </Button>
                ))}
              </Stack>
            )}

            {/* Omitted Buttons notice when URL sharing is off */}
            {hasOmittedButtons && (
              <Text fontSize="2xs" color="fg.muted" pt={2} lineHeight="1.4">
                Button omitted: full URL sharing is off in Settings or URL template is invalid.
              </Text>
            )}
          </Box>
        )}
      </Card.Body>
    </Card.Root>
  )
}

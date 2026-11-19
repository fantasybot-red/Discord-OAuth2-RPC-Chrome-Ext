import { useEffect, useRef, useState } from 'react'
import {
  Badge,
  Box,
  Button,
  Flex,
  HStack,
  Separator,
  Stack,
  Switch,
  Text,
} from '@chakra-ui/react'
import type { DiagnosticEntry, Diagnostics } from '@/shared/types'
import {
  clearDiagnostics,
  getDiagnostics,
  setDebugLogging,
  subscribeDiagnostics,
} from '@/shared/client'
import { toaster } from '../toaster'
import { Spinner } from '../icons'

export function DebugSection() {
  const [diagnostics, setDiagnostics] = useState<Diagnostics>({
    enabled: false,
    entries: [],
  })
  const [initError, setInitError] = useState<string | null>(null)
  const [isPending, setIsPending] = useState(false)
  const toggleSeq = useRef(0)
  const mountedRef = useRef(true)

  const loadDiagnostics = async () => {
    try {
      const d = await getDiagnostics()
      if (mountedRef.current) {
        setDiagnostics(d)
        setInitError(null)
      }
    } catch (err: unknown) {
      if (mountedRef.current) {
        const msg =
          err instanceof Error
            ? err.message
            : 'Could not load debug logs. Reload the extension.'
        setInitError(msg)
      }
    }
  }

  useEffect(() => {
    mountedRef.current = true
    loadDiagnostics()

    const unsubscribe = subscribeDiagnostics((d) => {
      if (mountedRef.current) {
        setDiagnostics(d)
        setInitError(null)
      }
    })

    return () => {
      mountedRef.current = false
      toggleSeq.current++
      unsubscribe()
    }
  }, [])

  const handleToggleLogging = async (enabled: boolean) => {
    const currentSeq = ++toggleSeq.current
    setIsPending(true)
    try {
      const next = await setDebugLogging(enabled)
      if (mountedRef.current && toggleSeq.current === currentSeq) {
        setDiagnostics(next)
        setInitError(null)
        toaster.create({
          title: enabled ? 'Debug logging enabled.' : 'Debug logging disabled.',
          type: 'info',
          duration: 3000,
        })
      }
    } catch (err: unknown) {
      if (mountedRef.current && toggleSeq.current === currentSeq) {
        const msg = err instanceof Error ? err.message : String(err)
        toaster.create({
          title: `Failed to update debug logging: ${msg}`,
          type: 'error',
          duration: 5000,
        })
      }
    } finally {
      if (mountedRef.current && toggleSeq.current === currentSeq) {
        setIsPending(false)
      }
    }
  }

  const handleClearLogs = async () => {
    const currentSeq = ++toggleSeq.current
    setIsPending(true)
    try {
      const next = await clearDiagnostics()
      if (mountedRef.current && toggleSeq.current === currentSeq) {
        setDiagnostics(next)
        toaster.create({
          title: 'Logs cleared.',
          type: 'info',
          duration: 3000,
        })
      }
    } catch (err: unknown) {
      if (mountedRef.current && toggleSeq.current === currentSeq) {
        const msg = err instanceof Error ? err.message : String(err)
        toaster.create({
          title: `Failed to clear logs: ${msg}`,
          type: 'error',
          duration: 5000,
        })
      }
    } finally {
      if (mountedRef.current && toggleSeq.current === currentSeq) {
        setIsPending(false)
      }
    }
  }

  const handleCopyLogs = async () => {
    try {
      const json = JSON.stringify(diagnostics.entries, null, 2)
      await navigator.clipboard.writeText(json)
      if (mountedRef.current) {
        toaster.create({
          title: 'Logs copied to clipboard.',
          type: 'success',
          duration: 3000,
        })
      }
    } catch {
      if (mountedRef.current) {
        toaster.create({
          title: 'Could not copy logs to clipboard.',
          type: 'error',
          duration: 4000,
        })
      }
    }
  }

  const formatTime = (ts: number) => {
    try {
      return new Date(ts).toLocaleTimeString()
    } catch {
      return ''
    }
  }

  const getLevelColor = (level: DiagnosticEntry['level']) => {
    switch (level) {
      case 'error':
        return 'red'
      case 'warn':
        return 'yellow'
      case 'info':
      default:
        return 'gray'
    }
  }

  return (
    <Box w="100%">
      <Flex align="center" justify="space-between" mb={2}>
        <Text fontSize="md" fontWeight="600" color="fg">
          Debug diagnostics
        </Text>
        <HStack gap={2}>
          {isPending && <Spinner size={12} />}
          <Badge
            colorPalette={diagnostics.enabled ? 'green' : 'gray'}
            variant="subtle"
            size="sm"
          >
            {diagnostics.enabled ? 'Logging on' : 'Logging off'}
          </Badge>
        </HStack>
      </Flex>

      <Stack gap={3}>
        {/* Switch */}
        <Switch.Root
          checked={diagnostics.enabled}
          onCheckedChange={(details) => handleToggleLogging(details.checked)}
          disabled={isPending}
          colorPalette="blue"
        >
          <Switch.HiddenInput />
          <Switch.Control cursor="pointer">
            <Switch.Thumb />
          </Switch.Control>
          <Switch.Label fontSize="sm" color="fg" cursor="pointer">
            Debug logging
          </Switch.Label>
        </Switch.Root>

        <Text fontSize="xs" color="fg.muted" lineHeight="1.4">
          Logs omit credentials and browsing details. Logs reset with the browser session.
        </Text>

        {/* Actionable inline error on load failure */}
        {initError && (
          <Flex
            align="center"
            justify="space-between"
            p={2.5}
            borderRadius="md"
            bg="bg.error"
            borderColor="border.error"
            borderWidth="1px"
            role="alert"
          >
            <Text fontSize="xs" color="fg.error">
              {initError}
            </Text>
            <Button
              size="2xs"
              variant="ghost"
              onClick={loadDiagnostics}
              disabled={isPending}
            >
              Retry
            </Button>
          </Flex>
        )}

        {/* Buttons */}
        <HStack gap={2}>
          <Button
            type="button"
            size="xs"
            variant="subtle"
            onClick={handleCopyLogs}
            disabled={diagnostics.entries.length === 0}
          >
            Copy logs
          </Button>

          <Button
            type="button"
            size="xs"
            variant="ghost"
            onClick={handleClearLogs}
            disabled={diagnostics.entries.length === 0 || isPending}
          >
            Clear logs
          </Button>
        </HStack>

        {/* Entries list */}
        {diagnostics.entries.length === 0 ? (
          <Text fontSize="xs" color="fg.muted" py={2}>
            No events recorded.
          </Text>
        ) : (
          <Box
            maxH="240px"
            overflowY="auto"
            borderRadius="md"
            bg="bg.muted"
            p={2.5}
            borderWidth="1px"
            borderColor="border.subtle"
            role="log"
            aria-label="Diagnostic logs"
          >
            <Stack gap={2}>
              {diagnostics.entries.map((entry) => (
                <Box
                  key={entry.id}
                  fontSize="2xs"
                  fontFamily="mono"
                  lineHeight="1.4"
                  borderBottomWidth="1px"
                  borderColor="border.subtle"
                  pb={1.5}
                >
                  <HStack gap={1.5} mb={0.5} align="baseline" wrap="wrap">
                    <Text color="fg.muted">{formatTime(entry.time)}</Text>
                    <Badge colorPalette={getLevelColor(entry.level)} variant="subtle" size="xs">
                      {entry.level}
                    </Badge>
                    <Text fontWeight="600" color="fg">
                      {entry.event}
                    </Text>
                  </HStack>

                  <Text color="fg" wordBreak="break-word">
                    {entry.message}
                  </Text>

                  {entry.details && Object.keys(entry.details).length > 0 && (
                    <Text
                      as="pre"
                      fontSize="2xs"
                      color="fg.muted"
                      whiteSpace="pre-wrap"
                      wordBreak="break-word"
                      mt={1}
                    >
                      {JSON.stringify(entry.details)}
                    </Text>
                  )}
                </Box>
              ))}
            </Stack>
          </Box>
        )}
      </Stack>

      <Separator borderColor="border.subtle" mt={4} />
    </Box>
  )
}

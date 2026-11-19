import { Box, Button, Card, Flex, HStack, Text } from '@chakra-ui/react'
import type { ConnectionState, SnapshotUser } from '@/shared/types'
import { Spinner } from '../icons'

interface UserProfileProps {
  user: SnapshotUser | null
  connection: ConnectionState
  trackingEnabled: boolean
  onToggleTracking: () => void
  isToggling: boolean
}

export function UserProfile({
  user,
  connection,
  trackingEnabled,
  onToggleTracking,
  isToggling,
}: UserProfileProps) {
  if (connection !== 'connected' || !user) {
    return null
  }

  const avatarUrl = user.avatar
    ? `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png?size=128`
    : null

  const initial = (user.username?.[0] || 'U').toUpperCase()

  return (
    <Card.Root size="sm" bg="bg.panel" borderColor="border.subtle" w="100%">
      <Card.Body p={3}>
        <Flex align="center" justify="space-between" w="100%" gap={3}>
          <HStack gap={3} minW={0}>
            <Box
              w="36px"
              h="36px"
              borderRadius="full"
              overflow="hidden"
              bg="bg.muted"
              display="flex"
              alignItems="center"
              justifyContent="center"
              flexShrink={0}
            >
              {avatarUrl ? (
                <img
                  src={avatarUrl}
                  alt=""
                  style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                  onError={(e) => {
                    ;(e.currentTarget as HTMLElement).style.display = 'none'
                  }}
                />
              ) : (
                <Text fontWeight="700" fontSize="sm" color="fg">
                  {initial}
                </Text>
              )}
            </Box>

            <Box minW={0}>
              <Text fontWeight="600" fontSize="sm" color="fg" lineHeight="1.2" truncate>
                @{user.username}
              </Text>
              <Text fontSize="xs" color="fg.muted" fontFamily="mono" truncate>
                ID: {user.id}
              </Text>
            </Box>
          </HStack>

          <Button
            size="xs"
            colorPalette={trackingEnabled ? 'red' : 'blue'}
            variant="subtle"
            onClick={onToggleTracking}
            disabled={isToggling}
            flexShrink={0}
          >
            {isToggling && <Spinner size={13} />}
            <span>{trackingEnabled ? 'Turn off' : 'Turn on'}</span>
          </Button>
        </Flex>
      </Card.Body>
    </Card.Root>
  )
}

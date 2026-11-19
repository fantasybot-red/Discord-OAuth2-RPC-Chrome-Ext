import { Badge, Box, Flex, HStack, Text } from '@chakra-ui/react'
import type { ConnectionState } from '@/shared/types'

interface HeaderProps {
  connection: ConnectionState
  trackingEnabled: boolean
}

export function Header({ connection, trackingEnabled }: HeaderProps) {
  const getConnectionLabel = () => {
    switch (connection) {
      case 'connected':
        return 'Online'
      case 'authorizing':
        return 'Authorizing'
      case 'connecting':
        return 'Connecting'
      case 'error':
        return 'Error'
      case 'disconnected':
      default:
        return 'Disconnected'
    }
  }

  const getConnectionColor = () => {
    switch (connection) {
      case 'connected':
        return 'green'
      case 'authorizing':
      case 'connecting':
        return 'yellow'
      case 'error':
        return 'red'
      default:
        return 'gray'
    }
  }

  return (
    <Box
      as="header"
      w="100%"
      px={4}
      py={3}
      borderBottomWidth="1px"
      borderColor="border.subtle"
      bg="var(--app-bg)"
      position="sticky"
      top={0}
      zIndex={10}
    >
      <Flex align="center" justify="space-between" w="100%">
        <Text fontWeight="600" fontSize="sm" color="fg">
          Discord rich presence
        </Text>

        <HStack gap={2}>
          <Badge
            colorPalette={trackingEnabled ? 'green' : 'gray'}
            variant="subtle"
            size="sm"
          >
            {trackingEnabled ? 'Tracking on' : 'Tracking off'}
          </Badge>
          <Badge
            colorPalette={getConnectionColor()}
            variant="subtle"
            size="sm"
          >
            {getConnectionLabel()}
          </Badge>
        </HStack>
      </Flex>
    </Box>
  )
}

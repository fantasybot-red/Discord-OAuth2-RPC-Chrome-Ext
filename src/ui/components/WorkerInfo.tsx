import { Box, Flex, Stack, Text } from '@chakra-ui/react'

interface WorkerInfoProps {
  connection: string
  activityEnabled: boolean
}

export function WorkerInfo({ connection, activityEnabled }: WorkerInfoProps) {
  return (
    <Box w="100%">
      <Text fontSize="md" fontWeight="600" color="fg" mb={3}>
        Background service worker
      </Text>

      <Stack gap={2.5}>
        <Text fontSize="xs" color="fg.muted" lineHeight="1.4">
          Closing this side panel does not disconnect your presence. The Chrome service worker
          maintains the gateway session while Google Chrome is running.
        </Text>
        <Text fontSize="2xs" color="fg.muted" lineHeight="1.4">
          Browser suspension, OS sleep, or network interruptions can temporarily pause the
          connection. The extension retries automatically when connectivity resumes.
        </Text>

        <Stack gap={1} fontSize="xs" pt={1}>
          <Flex justify="space-between" py={1} borderBottomWidth="1px" borderColor="border.subtle">
            <Text color="fg.muted">Gateway connection</Text>
            <Text fontWeight="600" color="fg" textTransform="capitalize">
              {connection}
            </Text>
          </Flex>

          <Flex justify="space-between" py={1} borderBottomWidth="1px" borderColor="border.subtle">
            <Text color="fg.muted">Activity template</Text>
            <Text fontWeight="600" color={activityEnabled ? 'green.500' : 'fg.muted'}>
              {activityEnabled ? 'Saved' : 'Not saved'}
            </Text>
          </Flex>

          <Flex justify="space-between" py={1}>
            <Text color="fg.muted">Storage</Text>
            <Text color="fg">Local extension storage</Text>
          </Flex>
        </Stack>
      </Stack>
    </Box>
  )
}

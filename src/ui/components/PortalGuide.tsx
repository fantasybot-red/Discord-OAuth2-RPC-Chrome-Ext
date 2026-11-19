import { useState } from 'react'
import { Box, Flex, Separator, Text } from '@chakra-ui/react'
import { ChevronDownIcon, ChevronUpIcon } from '../icons'
import { SetupSteps } from './SetupSteps'

export function PortalGuide() {
  const [isOpen, setIsOpen] = useState(false)

  return (
    <Box w="100%">
      <Flex
        as="button"
        align="center"
        justify="space-between"
        w="100%"
        textAlign="left"
        cursor="pointer"
        onClick={() => setIsOpen(!isOpen)}
        aria-expanded={isOpen}
        py={1}
      >
        <Text fontSize="sm" fontWeight="600" color="fg">
          Developer portal setup
        </Text>
        {isOpen ? <ChevronUpIcon size={14} /> : <ChevronDownIcon size={14} />}
      </Flex>

      {isOpen && (
        <Box pt={2}>
          <SetupSteps />
        </Box>
      )}

      <Separator borderColor="border.subtle" mt={4} />
    </Box>
  )
}

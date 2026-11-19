import {
  createToaster,
  Portal,
  Spinner,
  Stack,
  Toast,
  Toaster as ChakraToaster,
} from '@chakra-ui/react'

export const toaster = createToaster({
  placement: 'top',
  pauseOnPageIdle: true,
})

export function Toaster() {
  return (
    <Portal>
      <ChakraToaster toaster={toaster} insetInline={{ md: '1rem' }}>
        {(toast) => (
          <Toast.Root width={{ base: 'full', sm: 'sm' }} p={3.5}>
            {toast.type === 'loading' ? (
              <Spinner size="sm" color="blue.solid" />
            ) : (
              <Toast.Indicator />
            )}
            <Stack gap="0.5" flex="1" maxWidth="100%">
              {toast.title && <Toast.Title fontSize="sm">{toast.title}</Toast.Title>}
              {toast.description && (
                <Toast.Description fontSize="xs" color="fg.muted">
                  {toast.description}
                </Toast.Description>
              )}
            </Stack>
            {toast.action && (
              <Toast.ActionTrigger>{toast.action.label}</Toast.ActionTrigger>
            )}
            <Toast.CloseTrigger />
          </Toast.Root>
        )}
      </ChakraToaster>
    </Portal>
  )
}

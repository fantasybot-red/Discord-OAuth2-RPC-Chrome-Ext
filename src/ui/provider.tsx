import { ChakraProvider, defaultSystem } from '@chakra-ui/react'
import { useLayoutEffect, useState } from 'react'
import type { PropsWithChildren } from 'react'
import { Toaster } from './toaster'

function useSystemColorMode(): 'dark' | 'light' {
  const [colorMode, setColorMode] = useState<'dark' | 'light'>(() => {
    if (typeof window !== 'undefined' && window.matchMedia) {
      return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
    }
    return 'dark'
  })

  useLayoutEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return
    const mq = window.matchMedia('(prefers-color-scheme: dark)')

    const syncTheme = (matches: boolean) => {
      const mode = matches ? 'dark' : 'light'
      setColorMode(mode)
      document.documentElement.classList.remove('dark', 'light')
      document.documentElement.classList.add(mode)
      document.documentElement.setAttribute('data-theme', mode)
      document.documentElement.style.colorScheme = mode
    }

    syncTheme(mq.matches)

    const onChange = (e: MediaQueryListEvent) => syncTheme(e.matches)
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])

  return colorMode
}

export function Provider({ children }: PropsWithChildren) {
  const colorMode = useSystemColorMode()

  return (
    <ChakraProvider value={defaultSystem}>
      <div
        className={colorMode}
        data-theme={colorMode}
        style={{
          colorScheme: colorMode,
          minHeight: '100vh',
          width: '100%',
          backgroundColor: 'var(--app-bg)',
          color: 'var(--app-text)',
        }}
      >
        {children}
        <Toaster />
      </div>
    </ChakraProvider>
  )
}

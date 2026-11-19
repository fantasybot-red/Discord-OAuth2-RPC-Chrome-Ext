import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { Provider } from '@/ui/provider'
import '@/ui/styles.css'
import CallbackApp from './App'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Provider>
      <CallbackApp />
    </Provider>
  </StrictMode>,
)

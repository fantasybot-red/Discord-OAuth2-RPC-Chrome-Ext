import App from '@/ui/App'
import { Provider } from '@/ui/provider'

export default function SidepanelApp() {
  return (
    <Provider>
      <App mode="sidepanel" />
    </Provider>
  )
}

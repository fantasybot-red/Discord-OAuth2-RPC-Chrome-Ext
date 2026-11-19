import { useEffect, useState } from 'react'
import type { Settings, Snapshot } from '@/shared/types'
import { disconnect, getSnapshot, saveSettings, startAuth, subscribe } from '@/shared/client'
import { toaster } from './toaster'

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** Snapshot plus the three actions the setup flow needs. Uses the shared client only. */
export function useSetupFlow() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null)
  const [loadFailed, setLoadFailed] = useState(false)
  const [isSaving, setIsSaving] = useState(false)
  const [isConnecting, setIsConnecting] = useState(false)
  const [isDisconnecting, setIsDisconnecting] = useState(false)

  useEffect(() => {
    let mounted = true
    getSnapshot()
      .then((data) => {
        if (mounted) setSnapshot(data)
      })
      .catch((err: unknown) => {
        if (!mounted) return
        setLoadFailed(true)
        toaster.create({ title: message(err), type: 'error', duration: 5000 })
      })
    const unsubscribe = subscribe((next) => {
      if (mounted) setSnapshot(next)
    })
    return () => {
      mounted = false
      unsubscribe()
    }
  }, [])

  const save = async (settings: Settings): Promise<boolean> => {
    setIsSaving(true)
    try {
      setSnapshot(await saveSettings(settings))
      toaster.create({ title: 'Credentials saved.', type: 'success', duration: 3000 })
      return true
    } catch (err: unknown) {
      toaster.create({ title: `Failed to save credentials: ${message(err)}`, type: 'error', duration: 5000 })
      return false
    } finally {
      setIsSaving(false)
    }
  }

  const connect = async () => {
    setIsConnecting(true)
    try {
      setSnapshot(await startAuth())
      toaster.create({ title: 'Opened Discord authorization tab.', type: 'info', duration: 4000 })
    } catch (err: unknown) {
      toaster.create({ title: `Connection failed: ${message(err)}`, type: 'error', duration: 5000 })
    } finally {
      setIsConnecting(false)
    }
  }

  const cancel = async () => {
    setIsDisconnecting(true)
    try {
      setSnapshot(await disconnect())
    } catch (err: unknown) {
      toaster.create({ title: `Failed to disconnect: ${message(err)}`, type: 'error', duration: 5000 })
    } finally {
      setIsDisconnecting(false)
    }
  }

  return { snapshot, loadFailed, isSaving, isConnecting, isDisconnecting, save, connect, cancel }
}

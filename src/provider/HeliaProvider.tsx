import { unixfs } from "@helia/unixfs"
import type { Helia } from "helia"
import { createContext, useEffect, useState } from "react"
import type { ReactNode } from "react"
import { createHeliaNode } from "@/lib/helia"

interface HeliaContextValue {
  helia: Helia | null
  fs: ReturnType<typeof unixfs> | null
  error: boolean
  starting: boolean
}

export const HeliaContext = createContext<HeliaContextValue>({
  helia: null,
  fs: null,
  error: false,
  starting: true,
})

export const HeliaProvider = ({ children }: { children: ReactNode }) => {
  const [helia, setHelia] = useState<Helia | null>(null)
  const [fs, setFs] = useState<ReturnType<typeof unixfs> | null>(null)
  const [error, setError] = useState(false)
  const [starting, setStarting] = useState(true)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const node = await createHeliaNode()
        if (cancelled) return
        setHelia(node)
        setFs(unixfs(node))
      } catch (err) {
        console.error(err)
        if (!cancelled) setError(true)
      } finally {
        if (!cancelled) setStarting(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  return (
    <HeliaContext.Provider value={{ helia, fs, error, starting }}>
      {children}
    </HeliaContext.Provider>
  )
}

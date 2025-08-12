import { useEffect, useState } from "react"
import type { Room, BaseRoomConfig } from "trystero"

type StrategyModule = {
  joinRoom: (
    config: BaseRoomConfig & Record<string, unknown>,
    roomId: string,
    onJoinError?: (details: unknown) => void
  ) => Room
  getRelaySockets?: () => Record<string, WebSocket>
}

type Strategy = {
  name: string
  load: () => Promise<StrategyModule>
}

const strategies: Strategy[] = [
  { name: "nostr", load: () => import("trystero") as Promise<StrategyModule> },
  { name: "torrent", load: () => import("trystero/torrent") as Promise<StrategyModule> },
  { name: "mqtt", load: () => import("trystero/mqtt") as Promise<StrategyModule> },
  { name: "ipfs", load: () => import("trystero/ipfs") as Promise<StrategyModule> },
]

async function waitForRelayOpen(
  sockets: Record<string, WebSocket> | undefined,
  timeout = 5000
): Promise<boolean> {
  const list = sockets ? Object.values(sockets) : []
  if (list.length === 0) return true
  return new Promise((resolve) => {
    let resolved = false
    const cleanup = () => {
      list.forEach((ws) => {
        ws.removeEventListener("open", onOpen)
      })
    }
    const onOpen = () => {
      if (!resolved && list.some((ws) => ws.readyState === WebSocket.OPEN)) {
        resolved = true
        clearTimeout(timer)
        cleanup()
        resolve(true)
      }
    }
    const timer = setTimeout(() => {
      if (!resolved) {
        resolved = true
        cleanup()
        resolve(list.some((ws) => ws.readyState === WebSocket.OPEN))
      }
    }, timeout)
    list.forEach((ws) => {
      if (ws.readyState === WebSocket.OPEN) {
        onOpen()
      } else {
        ws.addEventListener("open", onOpen, { once: true })
      }
    })
  })
}

export interface FallbackRoom {
  room: Room
  strategy: string
  onReconnect(handler: (room: Room, strategy: string) => void): void
  leave(): void
}

export async function joinRoomWithFallback(
  config: BaseRoomConfig & Record<string, unknown>,
  roomId: string,
  onJoinError?: (details: unknown) => void
): Promise<FallbackRoom> {
  let active = true
  let reconnectHandlers: ((room: Room, strategy: string) => void)[] = []
  let currentRoom: Room
  let currentModule: StrategyModule | undefined

  const connect = async (
    startIndex = 0
  ): Promise<{ room: Room; strategy: string }> => {
    for (let i = startIndex; i < strategies.length; i++) {
      const strat = strategies[i]
      try {
        const mod = await strat.load()
          const room = mod.joinRoom(config, roomId, onJoinError)
          const ok = await waitForRelayOpen(mod.getRelaySockets?.())
          if (ok) {
            currentRoom = room
            currentModule = mod
            watchSockets(mod.getRelaySockets?.())
            return { room, strategy: strat.name }
          }
          await room.leave()
      } catch {
        // ignore and try next
      }
    }
    throw new Error("All connection strategies failed")
  }

  const watchSockets = (sockets?: Record<string, WebSocket>) => {
    const list = sockets ? Object.values(sockets) : []
    list.forEach((ws) => {
      ws.addEventListener("close", handleDisconnect)
      ws.addEventListener("error", handleDisconnect)
    })
  }

  const handleDisconnect = async () => {
    if (!active) return
    try {
      const { room, strategy } = await connect(0)
      reconnectHandlers.forEach((fn) => fn(room, strategy))
    } catch (err) {
      console.error("Failed to reconnect", err)
    }
  }

  const { room, strategy } = await connect()

  return {
    room,
    strategy,
    onReconnect(handler) {
      reconnectHandlers.push(handler)
    },
    leave() {
      active = false
      reconnectHandlers = []
      if (currentModule?.getRelaySockets) {
        Object.values(currentModule.getRelaySockets()).forEach((ws) => {
          ws.removeEventListener("close", handleDisconnect)
          ws.removeEventListener("error", handleDisconnect)
        })
      }
      currentRoom.leave()
    },
  }
}

export function useTrysteroRoom(
  config: BaseRoomConfig & Record<string, unknown>,
  roomId: string
) {
  const [room, setRoom] = useState<Room | null>(null)

  useEffect(() => {
    let manager: FallbackRoom
    let cancelled = false

    ;(async () => {
      try {
        manager = await joinRoomWithFallback(config, roomId)
        if (cancelled) {
          manager.leave()
          return
        }
        setRoom(manager.room)
        manager.onReconnect((r) => setRoom(r))
      } catch (err) {
        console.error("joinRoomWithFallback failed", err)
      }
    })()

    return () => {
      cancelled = true
      manager?.leave()
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config.appId, roomId])

  return room
}


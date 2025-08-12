"use client"

import type React from "react"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { Send, Paperclip, Users, Copy, Check, LinkIcon, LogIn, LogOut, Loader2 } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "@/components/ui/card"
import { useToast } from "@/hooks/use-toast"
import { cn } from "@/lib/utils"

// GunDB (local-first DB for persistence)
import Gun from "gun"

// Helia (IPFS) for file sharing
import { createHelia, type Helia } from "helia"
import { unixfs } from "@helia/unixfs"

type MessageType = "text" | "file"

type ChatMessage = {
  id: string
  roomId: string
  senderId: string
  nickname: string
  createdAt: number
  type: MessageType
  content?: string // for text
  // for files
  cid?: string
  fileName?: string
  mimeType?: string
  fileSize?: number
}

type Peer = {
  id: string
}

const APP_ID = "p2p-im-demo-v1" // used by Trystero to namespace your app

export default function P2PMessenger() {
  const { toast } = useToast()

  // identity
  const [nickname, setNickname] = useState(() => localStorage.getItem("p2p-nickname") || "")
  const [senderId] = useState(() => {
    let id = localStorage.getItem("p2p-sender-id")
    if (!id) {
      id = crypto.randomUUID()
      localStorage.setItem("p2p-sender-id", id)
    }
    return id
  })

  // room
  const [roomIdInput, setRoomIdInput] = useState(() => {
    const url = new URL(window.location.href)
    return url.searchParams.get("room") || ""
  })
  const [roomId, setRoomId] = useState<string>("")
  const [isJoining, setIsJoining] = useState(false)

  // peers and connection
  const [peers, setPeers] = useState<Peer[]>([])
  const roomRef = useRef<any | null>(null)
  const sendActionRef = useRef<((payload: any) => void) | null>(null)

  // messages
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const messagesRef = useRef<Map<string, ChatMessage>>(new Map())
  const [input, setInput] = useState("")

  // scrolling
  const endRef = useRef<HTMLDivElement>(null)
  const scrollToBottom = useCallback(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" })
  }, [])

  // GunDB
  const gunRef = useRef<Gun | null>(null)
  const gunRoomUnsubRef = useRef<(() => void) | null>(null)

  // Helia
  const [helia, setHelia] = useState<Helia | null>(null)
  const [isHeliaReady, setIsHeliaReady] = useState(false)

  // Init Gun only once
  useEffect(() => {
    if (!gunRef.current) {
      // local-only; you can add peers by passing a list of relay URLs
      gunRef.current = Gun({ peers: [], localStorage: true })
    }
  }, [])

  // Init Helia lazily when the page mounts
  useEffect(() => {
    let mounted = true
    ;(async () => {
      try {
        const node = await createHelia()
        if (!mounted) return
        setHelia(node)
        setIsHeliaReady(true)
      } catch (e) {
        console.error("Helia init error:", e)
        toast({
          title: "IPFS disabled",
          description: "Could not initialize IPFS node (Helia). File sharing may be limited.",
          variant: "destructive",
        })
        setIsHeliaReady(false)
      }
    })()
    return () => {
      mounted = false
    }
  }, [toast])

  // Save nickname
  useEffect(() => {
    if (nickname.trim()) {
      localStorage.setItem("p2p-nickname", nickname.trim())
    }
  }, [nickname])

  // Keep URL in sync with room
  useEffect(() => {
    const url = new URL(window.location.href)
    if (roomId) {
      url.searchParams.set("room", roomId)
    } else {
      url.searchParams.delete("room")
    }
    window.history.replaceState({}, "", url.toString())
  }, [roomId])

  // Subscribe to GunDB messages for the current room
  const subscribeRoomMessages = useCallback(
    (rid: string) => {
      if (!gunRef.current) return
      // Unsub previous
      if (gunRoomUnsubRef.current) {
        gunRoomUnsubRef.current()
        gunRoomUnsubRef.current = null
      }
      // messages path: messages/{roomId}/{messageId}
      const roomNode = gunRef.current.get("messages").get(rid)

      const handler = roomNode.map().on((data: ChatMessage | null, key: string) => {
        if (!data || !data.id) return
        if (!messagesRef.current.has(data.id)) {
          messagesRef.current.set(data.id, data)
          setMessages((prev) => {
            const next = [...prev, data].sort((a, b) => a.createdAt - b.createdAt).slice(-500)
            return next
          })
          // scroll on new
          setTimeout(scrollToBottom, 50)
        }
      })

      // Provide an unsubscribe
      gunRoomUnsubRef.current = () => {
        // Gun doesn't provide a direct off API for map.on; using undefined to detach
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ;(roomNode as any).off()
      }
    },
    [scrollToBottom],
  )

  // Join a Trystero room
  const joinRoom = useCallback(
    async (rid: string) => {
      if (!rid) return
      if (roomRef.current) {
        try {
          roomRef.current.leave && roomRef.current.leave()
        } catch {}
        roomRef.current = null
        sendActionRef.current = null
      }

      setIsJoining(true)
      try {
        const room = await joinRoom({ appId: APP_ID }, rid)
        roomRef.current = room

        const [sendMsg, onMsg] = room.makeAction("message")
        sendActionRef.current = (payload: any) => {
          try {
            sendMsg(payload)
          } catch (e) {
            console.error("Send error:", e)
          }
        }

        // Peer presence
        room.onPeerJoin((peerId: string) => {
          setPeers((prev) => {
            if (prev.find((p) => p.id === peerId)) return prev
            return [...prev, { id: peerId }]
          })
        })
        room.onPeerLeave((peerId: string) => {
          setPeers((prev) => prev.filter((p) => p.id !== peerId))
        })

        // Initial peers (if available)
        if (room.getPeers) {
          try {
            const ids: string[] = room.getPeers()
            setPeers(ids.map((id) => ({ id })))
          } catch {}
        }

        // Incoming messages
        onMsg((data: ChatMessage, fromPeerId: string) => {
          if (!data?.id) return
          if (!messagesRef.current.has(data.id)) {
            messagesRef.current.set(data.id, data)
            setMessages((prev) => {
              const next = [...prev, data].sort((a, b) => a.createdAt - b.createdAt).slice(-500)
              return next
            })
            // Persist in Gun for local offline
            if (gunRef.current) {
              gunRef.current.get("messages").get(rid).get(data.id).put(data)
            }
            setTimeout(scrollToBottom, 50)
          }
        })

        subscribeRoomMessages(rid)
        setRoomId(rid)
        toast({ title: "Connected", description: `Joined room "${rid}"` })
      } catch (e) {
        console.error("joinRoom error", e)
        toast({
          title: "Failed to join room",
          description: "Check your network or try a simpler room name.",
          variant: "destructive",
        })
      } finally {
        setIsJoining(false)
      }
    },
    [subscribeRoomMessages, toast, scrollToBottom],
  )

  // Send a text message
  const sendText = useCallback(() => {
    const trimmed = input.trim()
    if (!trimmed || !roomId) return
    const now = Date.now()
    const msg: ChatMessage = {
      id: `${senderId}-${now}-${Math.random().toString(36).slice(2)}`,
      roomId,
      senderId,
      nickname: nickname || "Anonymous",
      createdAt: now,
      type: "text",
      content: trimmed,
    }

    // optimistic add
    messagesRef.current.set(msg.id, msg)
    setMessages((prev) => [...prev, msg].sort((a, b) => a.createdAt - b.createdAt).slice(-500))
    setInput("")
    setTimeout(scrollToBottom, 50)

    // persist
    if (gunRef.current) {
      gunRef.current.get("messages").get(roomId).get(msg.id).put(msg)
    }
    // broadcast
    sendActionRef.current?.(msg)
  }, [input, nickname, roomId, scrollToBottom, senderId])

  // Send a file message via Helia
  const onPickFile = useCallback(
    async (file: File) => {
      if (!file || !roomId) return
      if (!helia) {
        toast({ title: "IPFS not ready", description: "Try again in a moment.", variant: "destructive" })
        return
      }
      const fs = unixfs(helia)
      try {
        const ab = await file.arrayBuffer()
        const cid = await fs.addBytes(new Uint8Array(ab))

        const now = Date.now()
        const msg: ChatMessage = {
          id: `${senderId}-${now}-${Math.random().toString(36).slice(2)}`,
          roomId,
          senderId,
          nickname: nickname || "Anonymous",
          createdAt: now,
          type: "file",
          cid: cid.toString(),
          fileName: file.name,
          mimeType: file.type || "application/octet-stream",
          fileSize: file.size,
        }

        messagesRef.current.set(msg.id, msg)
        setMessages((prev) => [...prev, msg].sort((a, b) => a.createdAt - b.createdAt).slice(-500))
        setTimeout(scrollToBottom, 50)

        if (gunRef.current) {
          gunRef.current.get("messages").get(roomId).get(msg.id).put(msg)
        }
        sendActionRef.current?.(msg)
      } catch (e) {
        console.error("IPFS add error", e)
        toast({ title: "File upload failed", description: "IPFS add failed.", variant: "destructive" })
      }
    },
    [helia, nickname, roomId, scrollToBottom, senderId, toast],
  )

  const isMe = useCallback((m: ChatMessage) => m.senderId === senderId, [senderId])

  useEffect(() => {
    // auto-join if URL had a room
    const urlRoom = new URL(window.location.href).searchParams.get("room")
    if (urlRoom && !roomId) {
      setRoomIdInput(urlRoom)
      joinRoom(urlRoom)
    }
  }, [joinRoom, roomId])

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (roomRef.current?.leave) {
        try {
          roomRef.current.leave()
        } catch {}
      }
      if (gunRoomUnsubRef.current) {
        gunRoomUnsubRef.current()
      }
    }
  }, [])

  const copyInvite = useCallback(async () => {
    if (!roomId) return
    const url = new URL(window.location.href)
    url.searchParams.set("room", roomId)
    await navigator.clipboard.writeText(url.toString())
    toast({ title: "Invite link copied", description: "Share it with your friends." })
  }, [roomId, toast])

  const handleJoin = useCallback(() => {
    const rid = roomIdInput.trim()
    if (!nickname.trim()) {
      toast({ title: "Add a nickname", description: "Set your nickname before joining.", variant: "destructive" })
      return
    }
    if (!rid) {
      toast({ title: "Room required", description: "Enter a room name to join.", variant: "destructive" })
      return
    }
    joinRoom(rid)
  }, [joinRoom, nickname, roomIdInput, toast])

  const handleLeave = useCallback(() => {
    if (roomRef.current?.leave) {
      try {
        roomRef.current.leave()
      } catch {}
    }
    if (gunRoomUnsubRef.current) {
      gunRoomUnsubRef.current()
      gunRoomUnsubRef.current = null
    }
    roomRef.current = null
    sendActionRef.current = null
    setRoomId("")
    setPeers([])
    messagesRef.current.clear()
    setMessages([])
  }, [])

  const onKeyDownSend = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault()
        sendText()
      }
    },
    [sendText],
  )

  return (
    <div className="w-full min-h-[86vh] flex items-center justify-center bg-muted/20">
      <Card className="w-full max-w-4xl border">
        <CardHeader className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <Avatar className="h-9 w-9">
              <AvatarFallback>{(nickname?.[0] || "U").toUpperCase()}</AvatarFallback>
            </Avatar>
            <Input
              placeholder="Your nickname"
              value={nickname}
              onChange={(e) => setNickname(e.target.value)}
              className="max-w-xs"
            />
            <div className="flex items-center gap-2 ml-auto">
              <Users className="h-4 w-4 text-muted-foreground" />
              <span className="text-sm text-muted-foreground">{peers.length} online</span>
            </div>
          </div>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <div className="flex w-full gap-2">
              <Input
                placeholder="Room name (e.g. team-chat)"
                value={roomIdInput}
                onChange={(e) => setRoomIdInput(e.target.value)}
              />
              {roomId ? (
                <Button variant="secondary" onClick={handleLeave}>
                  <LogOut className="h-4 w-4 mr-2" />
                  Leave
                </Button>
              ) : (
                <Button onClick={handleJoin} disabled={isJoining}>
                  {isJoining ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <LogIn className="h-4 w-4 mr-2" />}
                  Join
                </Button>
              )}
            </div>
            <div className="flex gap-2">
              <Button variant="outline" onClick={copyInvite} disabled={!roomId}>
                <LinkIcon className="h-4 w-4 mr-2" />
                Copy Invite
              </Button>
              <Button variant="outline" disabled={!isHeliaReady} title={isHeliaReady ? "" : "IPFS not ready yet"}>
                <Check className={cn("h-4 w-4 mr-2", isHeliaReady ? "text-green-600" : "text-muted-foreground")} />
                IPFS
              </Button>
            </div>
          </div>
          <CardTitle className="text-xl font-semibold">
            {roomId ? `Room: ${roomId}` : "Create or join a room to start chatting"}
          </CardTitle>
        </CardHeader>

        <CardContent className="p-0">
          <div className="grid grid-rows-[1fr] h-[50vh] sm:h-[60vh]">
            <ScrollArea className="h-full px-3">
              <div className="py-4 space-y-3">
                {messages.length === 0 && (
                  <div className="text-center text-sm text-muted-foreground py-8">{"No messages yet. Say hi 👋"}</div>
                )}
                {messages.map((m) => (
                  <div key={m.id} className={cn("flex w-full", isMe(m) ? "justify-end" : "justify-start")}>
                    <div
                      className={cn(
                        "max-w-[80%] rounded-2xl px-3 py-2 text-sm shadow-sm border",
                        isMe(m) ? "bg-primary text-primary-foreground border-transparent" : "bg-background",
                      )}
                    >
                      <div
                        className={cn(
                          "mb-1 text-[11px] opacity-80",
                          isMe(m) ? "text-primary-foreground" : "text-muted-foreground",
                        )}
                      >
                        {isMe(m) ? "You" : m.nickname}
                        <span className="mx-1">·</span>
                        {new Date(m.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                      </div>
                      {m.type === "text" && <div className="whitespace-pre-wrap">{m.content}</div>}
                      {m.type === "file" && (
                        <FileMessageBubble cid={m.cid!} fileName={m.fileName} mimeType={m.mimeType} />
                      )}
                    </div>
                  </div>
                ))}
                <div ref={endRef} />
              </div>
            </ScrollArea>
          </div>
        </CardContent>

        <CardFooter className="flex flex-col gap-2">
          <div className="w-full flex items-end gap-2">
            <label className={cn("relative inline-flex")}>
              <input
                type="file"
                className="hidden"
                onChange={async (e) => {
                  const f = e.target.files?.[0]
                  if (f) await onPickFile(f)
                  e.currentTarget.value = ""
                }}
                disabled={!roomId}
              />
              <Button variant="outline" size="icon" asChild>
                <span>
                  <Paperclip className="h-5 w-5" />
                </span>
              </Button>
            </label>
            <Textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={onKeyDownSend}
              placeholder={roomId ? "Type a message. Shift+Enter for newline" : "Join a room to start chatting"}
              disabled={!roomId}
              className="min-h-[44px] max-h-40"
            />
            <Button onClick={sendText} disabled={!roomId || !input.trim()} className="h-[44px]">
              <Send className="h-4 w-4 mr-2" />
              Send
            </Button>
          </div>
        </CardFooter>
      </Card>
    </div>
  )
}

function FileMessageBubble({
  cid,
  fileName,
  mimeType,
}: {
  cid: string
  fileName?: string
  mimeType?: string
}) {
  const isImage = useMemo(() => (mimeType || "").startsWith("image/"), [mimeType])
  const gatewayUrl = `https://ipfs.io/ipfs/${cid}`

  return (
    <div className="space-y-2">
      {isImage ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={`${gatewayUrl}`}
          alt={fileName || "image"}
          className="rounded-lg max-h-[280px] object-contain"
          crossOrigin="anonymous"
        />
      ) : (
        <div className="text-xs text-muted-foreground">
          {"Shared file:"} {fileName || "(unknown)"} {"·"} {mimeType || "application/octet-stream"}
        </div>
      )}
      <div className="flex items-center gap-2">
        <a href={gatewayUrl} target="_blank" rel="noreferrer" className="underline underline-offset-2">
          View via Gateway
        </a>
        <code className="text-[11px] px-1 py-0.5 rounded bg-muted">{cid.slice(0, 10)}…</code>
        <CopyCidButton text={cid} />
      </div>
    </div>
  )
}

function CopyCidButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <Button
      size="icon"
      variant="ghost"
      className="h-7 w-7"
      onClick={async () => {
        await navigator.clipboard.writeText(text)
        setCopied(true)
        setTimeout(() => setCopied(false), 1000)
      }}
    >
      {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
    </Button>
  )
}

/* eslint-disable @typescript-eslint/no-explicit-any, no-constant-binary-expression, no-empty */
import { useEffect, useMemo, useRef, useState } from "react"
import { selfId, type JsonValue } from "trystero"
import { useTrysteroRoom } from "@/lib/trystero-client"
import Gun from "gun"
import {
  Send,
  Users,
  Circle,
  Hash,
  Paperclip,
  Loader2,
  Check,
  Wifi,
  Shield,
  Download,
  FileText,
  Music,
  Film,
  ImageIcon,
  Copy,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"

// Helia (IPFS) for file sharing
import { createHelia, type Helia } from "helia"
import { unixfs } from "@helia/unixfs"

// Optional persistent blockstore (browser IndexedDB)
let hasIDB = true
try {
  hasIDB = typeof indexedDB !== "undefined"
} catch {
  hasIDB = false
}

type IDBBlockstore = any

async function createHeliaNode(): Promise<Helia> {
  if (hasIDB) {
    try {
      // Dynamically import to avoid breaking environments without IDB
      const { IDBBlockstore } = await import("blockstore-idb")
      const blockstore: IDBBlockstore = new IDBBlockstore("p2p-im-blocks")
      await blockstore.open()
      // Persist blocks so your node "pins" while online and across reloads
      return await createHelia({ blockstore })
    } catch (e) {
      console.warn("IDB blockstore unavailable, falling back to in-memory:", e)
    }
  }
  // Fallback: in-memory (pins last until tab closes)
  return await createHelia()
}

// Markdown + syntax highlighting
import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter"
import { coldarkDark } from "react-syntax-highlighter/dist/esm/styles/prism"

// Initialize a local Gun instance (local-first persistence)
const gun = Gun()

// Short action labels (Trystero prefers <= 12 bytes)
const ACT = {
  CHAT: "chat",
  NAME: "name",
  HIST: "hist",
  HREQ: "hreq",
} as const

type BaseMessage = {
  id: string
  authorId: string
  authorName: string
  timestamp: number
}

type ChatMessage =
  | (BaseMessage & {
      kind: "text"
      content: string
      [key: string]: JsonValue
    })
  | (BaseMessage & {
      kind: "file"
      content: string // short description or fileName
      cid: string
      mimeType?: string
      fileName?: string
      fileSize?: number
      [key: string]: JsonValue
    })

type ChatPayload = {
  id: string
  timestamp: number
  name: string
  content: string
  kind?: "text" | "file"
  cid?: string
  mimeType?: string
  fileName?: string
  fileSize?: number
  [key: string]: JsonValue
}

const gatewayFor = (cid: string) => `https://ipfs.io/ipfs/${cid}`

// Safe timestamp normalization (prevents split on undefined id)
function normalizeTimestamp(raw: unknown, id?: string) {
  if (typeof raw === "number" && Number.isFinite(raw)) return raw
  if (typeof id === "string" && id.length) {
    const pre = id.split("-")[0]
    const maybe = Number(pre)
    if (Number.isFinite(maybe)) return maybe
  }
  return Date.now()
}

export function LiveChat({ isGeneral = false }: { isGeneral?: boolean }) {
  // identity
  const [myName, setMyName] = useState(() => {
    const saved = typeof window !== "undefined" ? localStorage.getItem("p2p-nickname") : null
    return saved || "defaultNickname" || selfId
  })

  // state
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [newMessage, setNewMessage] = useState("")
  const [peers, setPeers] = useState<string[]>([])
  const [peerNames, setPeerNames] = useState<Record<string, string>>({})
  const [isJoining, setIsJoining] = useState(true)
  const [helia, setHelia] = useState<Helia | null>(null)
  const [isHeliaReady, setIsHeliaReady] = useState(false)
  const [isUploading, setIsUploading] = useState(false)

  // refs
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const sendChatRef = useRef<((msg: ChatPayload, peerId?: string) => Promise<void[]>) | null>(null)
  const gunNodeRef = useRef<ReturnType<typeof gun.get> | null>(null)
  const loadedIds = useRef<Set<string>>(new Set())
  const messagesRef = useRef<ChatMessage[]>([])
  const fileInputRef = useRef<HTMLInputElement>(null)

  const sortMessages = (msgs: ChatMessage[]) => msgs.sort((a, b) => a.timestamp - b.timestamp)

  // resolve room id and establish room with strategy fallbacks
  const url = typeof window !== "undefined" ? new URL(window.location.href) : null
  const paramRoom = url?.searchParams.get("room")
  const roomId = isGeneral
    ? "/chat/general"
    : paramRoom || (typeof window !== "undefined" ? window.location.pathname : "/")
  const room = useTrysteroRoom({ appId: "p2p-im" }, roomId)

  // Create/join room and wire Trystero + Gun subscriptions
  useEffect(() => {
    if (!room) return

    // Gun path for this room
    const messagesNode = gun.get("chats").get(roomId)
    gunNodeRef.current = messagesNode

    // Reset in-memory state for a fresh mount
    loadedIds.current = new Set()

    // Backfill updates from Gun (local-first)
    const gunMap = messagesNode.map()
    gunMap.on((data: unknown) => {
      const msg = data as Partial<ChatMessage> | null
      if (!msg || !msg.id) return // skip invalid
      const ts = normalizeTimestamp((msg as any).timestamp, msg.id)
      const complete = { ...msg, timestamp: ts } as ChatMessage
      if (loadedIds.current.has(complete.id)) return
      loadedIds.current.add(complete.id)
      setMessages((prev) => sortMessages([...prev, complete]))
      // Normalize timestamp back to Gun
      messagesNode.get(complete.id).put(complete)
    })

    // Trystero actions
    const [sendChat, getChat] = room.makeAction<ChatPayload>(ACT.CHAT)
    const [sendName, getName] = room.makeAction<string>(ACT.NAME)
    const [sendHistory, getHistory] = room.makeAction<ChatMessage[]>(ACT.HIST)
    const [sendHReq, getHReq] = room.makeAction<string>(ACT.HREQ)
    sendChatRef.current = sendChat

    // Receive chat messages
    getChat((data, peerId) => {
      if (!data?.id) return
      const ts = normalizeTimestamp(data.timestamp, data.id)
      const base = {
        id: data.id,
        authorId: peerId,
        authorName: data.name,
        timestamp: ts,
      }
      const msg: ChatMessage =
        data.kind === "file" && data.cid
          ? {
              ...base,
              kind: "file",
              content: data.fileName || data.content || "Shared file",
              cid: data.cid,
              mimeType: data.mimeType,
              fileName: data.fileName,
              fileSize: data.fileSize,
            }
          : {
              ...base,
              kind: "text",
              content: data.content || "",
            }

      if (!loadedIds.current.has(msg.id)) {
        loadedIds.current.add(msg.id)
        setMessages((prev) => sortMessages([...prev, msg]))
      }
      messagesNode.get(msg.id).put(msg)
      if (peerId) {
        setPeerNames((prev) => ({ ...prev, [peerId]: data.name }))
      }
    })

    // Receive peer's name
    getName((name, peerId) => {
      if (!peerId) return
      setPeerNames((prev) => ({ ...prev, [peerId]: name }))
    })

    // Receive history
    getHistory((history) => {
      if (!Array.isArray(history)) return
      history.forEach((m) => {
        if (!m?.id) return
        const ts = normalizeTimestamp(m.timestamp, m.id)
        const msg = { ...m, timestamp: ts }
        if (loadedIds.current.has(msg.id)) return
        loadedIds.current.add(msg.id)
        messagesNode.get(msg.id).put(msg)
        setMessages((prev) => sortMessages([...prev, msg]))
      })
    })

    // History request trigger
    getHReq((_, peerId) => {
      sendHistory(messagesRef.current, peerId)
    })

    // Initial peers and presence
    const peersRaw = room.getPeers?.()
    const initialPeerIds = Array.isArray(peersRaw) ? peersRaw : Object.keys(peersRaw || {})
    setPeers(initialPeerIds)

    room.onPeerJoin((peerId) => {
      setPeers((prev) => (prev.includes(peerId) ? prev : [...prev, peerId]))
      sendName(myName, peerId)
      sendHistory(messagesRef.current, peerId)
    })
    room.onPeerLeave((peerId) => setPeers((prev) => prev.filter((id) => id !== peerId)))

    // Broadcast our name to all
    sendName(myName)

    // Initial load from Gun with a welcome system message
    const welcome: ChatMessage = {
      id: `system-${Date.now()}`,
      authorId: "System",
      authorName: "System",
      timestamp: Date.now(),
      kind: "text",
      content: isGeneral ? "Welcome to the community chat" : "Room chat active",
    }

    messagesNode.once((data: Record<string, ChatMessage>) => {
      const initial: ChatMessage[] = []
      Object.entries(data || {}).forEach(([key, value]) => {
        if (key === "_" || !value || !value.id) return
        const ts = normalizeTimestamp(value.timestamp, value.id)
        const msg = { ...value, timestamp: ts }
        loadedIds.current.add(msg.id)
        initial.push(msg)
        messagesNode.get(msg.id).put(msg)
      })
      const sorted = sortMessages([welcome, ...initial])
      setMessages(sorted)
      sendHReq(selfId)
      setIsJoining(false)
    })

    return () => {
      ;(messagesNode as any)?.off?.()
      ;(gunMap as any)?.off?.()
    }
  }, [room, roomId, isGeneral, myName])

  // Keep a live ref of messages for history sharing
  useEffect(() => {
    messagesRef.current = messages
  }, [messages])

  // Scroll to bottom on new messages
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" })
  }, [messages])

  // Persist nickname
  useEffect(() => {
    if (myName) localStorage.setItem("p2p-nickname", myName)
  }, [myName])

  // Init Helia once (browser Helia with IDB-backed blockstore if possible)
  useEffect(() => {
    let mounted = true
    ;(async () => {
      try {
        const node = await createHeliaNode()
        if (!mounted) return
        setHelia(node)
        setIsHeliaReady(true)
      } catch (e) {
        console.warn("Helia init failed:", e)
        setIsHeliaReady(false)
      }
    })()
    return () => {
      mounted = false
    }
  }, [])

  // Send a text message
  const sendMessage = async () => {
    const content = newMessage.trim()
    if (!content) return
    const ts = Date.now()
    const id = `${ts}-${selfId}`
    const msg: ChatMessage = {
      id,
      authorId: selfId,
      authorName: myName,
      timestamp: ts,
      kind: "text",
      content,
    }
    loadedIds.current.add(msg.id)
    setMessages((prev) => sortMessages([...prev, msg]))
    setNewMessage("")

    const payload: ChatPayload = {
      id,
      timestamp: ts,
      name: myName,
      content,
      kind: "text",
    }
    try {
      await sendChatRef.current?.(payload)
    } catch (err) {
      console.error("failed to send message", err)
    }
    gunNodeRef.current?.get(msg.id).put(msg)
  }

  // Send files via Helia (IPFS) – accepts an array of File
  const onPickFiles = async (files: File[]) => {
    if (!files.length || !helia) return
    setIsUploading(true)
    try {
      const fs = unixfs(helia)
      for (const file of files) {
        try {
          const ab = await file.arrayBuffer()
          const cid = await fs.addBytes(new Uint8Array(ab))
          const ts = Date.now()
          const id = `${ts}-${selfId}`

          const msg: ChatMessage = {
            id,
            authorId: selfId,
            authorName: myName,
            timestamp: ts,
            kind: "file",
            content: file.name || "Shared file",
            cid: cid.toString(),
            mimeType: file.type || "application/octet-stream",
            fileName: file.name,
            fileSize: file.size,
          }

          loadedIds.current.add(msg.id)
          setMessages((prev) => sortMessages([...prev, msg]))

          const payload: ChatPayload = {
            id,
            timestamp: ts,
            name: myName,
            content: file.name || "Shared file",
            kind: "file",
            cid: cid.toString(),
            mimeType: msg.mimeType,
            fileName: msg.fileName,
            fileSize: msg.fileSize,
          }
          try {
            await sendChatRef.current?.(payload)
          } catch (e) {
            console.error("failed to send file message", e)
          }
          gunNodeRef.current?.get(msg.id).put(msg)
        } catch (e) {
          console.error("IPFS add failed for a file:", e)
        }
      }
    } finally {
      setIsUploading(false)
    }
  }

  // Open native file picker – safe handling without relying on event targets after await
  const openFilePicker = () => {
    const el = fileInputRef.current
    if (!el) return
    // Clear value first so selecting the same file again triggers change
    el.value = ""
    el.click()
  }

  // Handle file input change using ref to avoid e.currentTarget null
  const handleFilesSelected = async () => {
    const el = fileInputRef.current
    if (!el || !el.files) return
    // Copy files synchronously and clear input before await to avoid race
    const copied = Array.from(el.files)
    el.value = ""
    await onPickFiles(copied)
  }

  const onlineCount = peers.length + 1 // include self

  return (
    <div className="relative flex h-screen w-full flex-col bg-[#0a0f0d] text-emerald-50 overflow-hidden">
      {/* Background grid + vignette */}
      <div className="pointer-events-none absolute inset-0 opacity-20 [background:radial-gradient(1000px_500px_at_0%_0%,rgba(16,185,129,0.15),transparent_60%),radial-gradient(1000px_500px_at_100%_100%,rgba(34,211,238,0.1),transparent_60%)]" />
      <div className="pointer-events-none absolute inset-0 opacity-[0.08] [background-image:linear-gradient(rgba(0,255,156,.15)_1px,transparent_1px),linear-gradient(90deg,rgba(0,255,156,.15)_1px,transparent_1px)] [background-size:24px_24px]" />

      {/* Main chat area - always visible */}
      <div className="relative flex h-full w-full">
        {/* Main chat area - always visible */}
        <div className="flex flex-1 flex-col min-w-0">
          {/* Header - optimized for mobile */}
          <header className="flex-shrink-0 border-b border-emerald-500/20 bg-[#0a0f0db3] backdrop-blur-md">
            <div className="flex items-center justify-between gap-2 p-3 sm:gap-4 sm:px-4">
              <div className="flex items-center gap-2 min-w-0 flex-1">
                <div className="flex items-center gap-2 rounded-lg border border-emerald-500/20 bg-[#0b1612] px-2.5 py-1.5 shadow-[0_0_15px_rgba(16,185,129,0.15)] sm:px-3">
                  <Hash className="h-3.5 w-3.5 text-emerald-400 sm:h-4 sm:w-4" />
                  <span className="font-mono text-xs tracking-wide sm:text-sm">{isGeneral ? "general" : "room"}</span>
                </div>

                <div className="flex items-center gap-1 sm:hidden">
                  <span className="inline-flex items-center gap-1 rounded-md border border-emerald-500/20 bg-[#0b1612] px-1.5 py-1 text-xs text-emerald-300">
                    <Users className="h-3 w-3" />
                    {onlineCount}
                  </span>
                  {isHeliaReady && (
                    <span className="inline-flex items-center rounded-md border border-emerald-500/20 bg-[#0b1612] px-1.5 py-1 text-xs text-emerald-300">
                      <Check className="h-3 w-3" />
                    </span>
                  )}
                </div>

                <div className="hidden items-center gap-2 sm:flex">
                  <span className="inline-flex items-center gap-1 rounded-md border border-emerald-500/20 bg-[#0b1612] px-2 py-1 text-xs text-emerald-300">
                    <Users className="h-3.5 w-3.5" />
                    {onlineCount} online
                  </span>
                  <span className="inline-flex items-center gap-1 rounded-md border border-emerald-500/20 bg-[#0b1612] px-2 py-1 text-xs text-emerald-300">
                    <Wifi className="h-3.5 w-3.5" />
                    P2P
                  </span>
                  <span className="inline-flex items-center gap-1 rounded-md border border-emerald-500/20 bg-[#0b1612] px-2 py-1 text-xs text-emerald-300">
                    {isHeliaReady ? (
                      <Check className="h-3.5 w-3.5" />
                    ) : (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    )}
                    IPFS
                  </span>
                  <span className="inline-flex items-center gap-1 rounded-md border border-emerald-500/20 bg-[#0b1612] px-2 py-1 text-xs text-emerald-300">
                    <Shield className="h-3.5 w-3.5" />
                    Local-first
                  </span>
                </div>
              </div>

              <div className="flex items-center gap-2 flex-shrink-0">
                <span className="hidden text-xs text-emerald-300/80 sm:inline">nick</span>
                <Input
                  value={myName}
                  onChange={(e) => setMyName(e.target.value)}
                  className="h-8 w-20 border-emerald-500/20 bg-[#0c1b16] text-xs text-emerald-100 placeholder:text-emerald-300/50 focus-visible:ring-emerald-600 sm:w-32 sm:text-sm md:w-40"
                  placeholder="hacker42"
                />
              </div>
            </div>
          </header>

          {/* Messages area - scrollable */}
          <main className="flex flex-1 flex-col min-h-0">
            <div className="flex-1 overflow-y-auto overscroll-contain px-3 py-4 sm:px-4 md:px-6">
              {isJoining && (
                <div className="mb-3 inline-flex items-center gap-2 rounded-md border border-emerald-500/20 bg-[#0b1612] px-3 py-1.5 text-xs text-emerald-300">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  connecting…
                </div>
              )}

              <MessageList messages={messages} />
              <div ref={messagesEndRef} />
            </div>

            <Composer
              isHeliaReady={isHeliaReady}
              isUploading={isUploading}
              newMessage={newMessage}
              onSend={sendMessage}
              onChangeMessage={setNewMessage}
              onOpenPicker={openFilePicker}
            />
            <input ref={fileInputRef} type="file" className="hidden" multiple onChange={handleFilesSelected} />
          </main>
        </div>

        <aside className="hidden w-72 flex-shrink-0 border-l border-emerald-500/20 bg-[#0a1311]/70 p-4 lg:block xl:w-80">
          <h4 className="mb-3 flex items-center gap-2 font-mono text-sm text-emerald-200">
            <Users className="h-4 w-4" />
            Online ({onlineCount})
          </h4>
          <div className="space-y-2 text-sm text-emerald-200/90">
            <div className="flex items-center gap-2 rounded-md border border-emerald-500/20 bg-[#0b1612] px-3 py-2">
              <Circle className="h-2.5 w-2.5 text-emerald-400 fill-current flex-shrink-0" />
              <span className="truncate font-medium" title={selfId}>
                {myName} (you)
              </span>
            </div>
            {peers.map((p) => (
              <div
                key={p}
                className="flex items-center gap-2 rounded-md border border-emerald-500/15 bg-[#0b1412] px-3 py-2 text-emerald-100"
                title={p}
              >
                <Circle className="h-2.5 w-2.5 text-emerald-400 fill-current flex-shrink-0" />
                <span className="truncate">{peerNames[p] || p}</span>
              </div>
            ))}
          </div>
        </aside>
      </div>
    </div>
  )
}

function Composer({
  isHeliaReady,
  isUploading,
  newMessage,
  onSend,
  onChangeMessage,
  onOpenPicker,
}: {
  isHeliaReady: boolean
  isUploading: boolean
  newMessage: string
  onSend: () => void
  onChangeMessage: (v: string) => void
  onOpenPicker: () => void
}) {
  return (
    <div className="flex-shrink-0 border-t border-emerald-500/20 bg-[#0a0f0df2] p-3 backdrop-blur-md sm:p-4">
      <div className="flex items-end gap-2 sm:gap-3">
        <Button
          variant="secondary"
          size="icon"
          className="h-10 w-10 flex-shrink-0 border-emerald-500/30 bg-[#0b1612] text-emerald-200 hover:bg-[#0e1f19] hover:text-emerald-100 active:scale-95 transition-transform sm:h-11 sm:w-11"
          onClick={onOpenPicker}
          title={isHeliaReady ? "Attach files (IPFS)" : "IPFS not ready"}
          disabled={!isHeliaReady || isUploading}
        >
          {isUploading ? (
            <Loader2 className="h-4 w-4 animate-spin sm:h-5 sm:w-5" />
          ) : (
            <Paperclip className="h-4 w-4 sm:h-5 sm:w-5" />
          )}
        </Button>

        <input
          type="text"
          value={newMessage}
          onChange={(e) => onChangeMessage(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault()
              onSend()
            }
          }}
          className="min-h-10 flex-1 rounded-xl border border-emerald-500/25 bg-[#0b1612] px-3 py-2 text-sm text-emerald-100 placeholder:text-emerald-300/50 focus:outline-none focus:ring-2 focus:ring-emerald-600 sm:min-h-11 sm:px-4 sm:text-base"
          placeholder="write message… supports markdown"
        />

        <Button
          onClick={onSend}
          disabled={!newMessage.trim()}
          className="h-10 flex-shrink-0 gap-2 rounded-xl border border-emerald-500/30 bg-gradient-to-tr from-emerald-700 to-emerald-500 px-3 text-sm text-emerald-50 shadow-[0_0_20px_rgba(16,185,129,.25)] hover:from-emerald-600 hover:to-emerald-400 active:scale-95 disabled:opacity-50 transition-transform sm:h-11 sm:px-4 sm:text-base"
        >
          <Send className="h-3.5 w-3.5 sm:h-4 sm:w-4" />
          <span className="hidden sm:inline">Send</span>
        </Button>
      </div>
    </div>
  )
}

function MessageList({ messages }: { messages: ChatMessage[] }) {
  return (
    <div className="space-y-3 sm:space-y-4">
      {messages.map((m) => (
        <MessageBubble key={m.id} message={m} />
      ))}
    </div>
  )
}

function MessageBubble({ message: m }: { message: ChatMessage }) {
  const mine = m.authorId === selfId
  return (
    <div className={`flex ${mine ? "justify-end" : "justify-start"}`}>
      <div
        className={[
          "max-w-[85%] rounded-2xl border px-3 py-2 text-sm shadow-sm transition-all duration-200 sm:max-w-[75%] sm:px-4 sm:py-3 md:max-w-[70%]",
          mine
            ? "border-emerald-500/40 bg-[#0c1b16]/95 text-emerald-50 shadow-[0_0_20px_rgba(16,185,129,.18)]"
            : "border-emerald-500/15 bg-[#0b1110]/95 text-emerald-100",
        ].join(" ")}
      >
        <div className="mb-1 flex items-center gap-2 text-[10px] text-emerald-300/80 sm:text-[11px]">
          <span className="font-mono truncate max-w-[30vw] sm:max-w-[40vw]">{mine ? "you" : m.authorName}</span>
          <span className="opacity-50">•</span>
          <span className="tabular-nums">
            {new Date(m.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
          </span>
        </div>

        {m.kind === "text" ? (
          <MarkdownRenderer text={m.content} />
        ) : (
          <FileBubble cid={m.cid} fileName={m.fileName || m.content} mimeType={m.mimeType} fileSize={m.fileSize} />
        )}
      </div>
    </div>
  )
}

function FileBubble({
  cid,
  fileName,
  mimeType,
  fileSize,
}: {
  cid: string
  fileName?: string
  mimeType?: string
  fileSize?: number
}) {
  const url = useMemo(() => gatewayFor(cid), [cid])
  const type = mimeType || "application/octet-stream"
  const isImage = type.startsWith("image/")
  const isVideo = type.startsWith("video/")
  const isAudio = type.startsWith("audio/")
  const isPdf = type === "application/pdf"

  const prettySize = useMemo(() => {
    if (typeof fileSize !== "number") return ""
    if (fileSize === 0) return "0 B"
    const i = Math.floor(Math.log(fileSize) / Math.log(1024))
    const sizes = ["B", "KB", "MB", "GB", "TB"]
    const val = (fileSize / Math.pow(1024, i)).toFixed(1)
    return `${val} ${sizes[i]}`
  }, [fileSize])

  const [copied, setCopied] = useState(false)
  const copyCid = async () => {
    try {
      await navigator.clipboard.writeText(cid)
      setCopied(true)
      setTimeout(() => setCopied(false), 900)
    } catch {}
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 text-xs text-emerald-300/80">
        {isImage ? (
          <ImageIcon className="h-3.5 w-3.5" />
        ) : isVideo ? (
          <Film className="h-3.5 w-3.5" />
        ) : isAudio ? (
          <Music className="h-3.5 w-3.5" />
        ) : (
          <FileText className="h-3.5 w-3.5" />
        )}
        <span className="truncate">{fileName || "Shared file"}</span>
        {prettySize ? <span className="opacity-60">• {prettySize}</span> : null}
      </div>

      {isImage && (
        <img
          src={url || "/placeholder.svg?height=300&width=500&query=hacker%20chat%20image%20preview"}
          alt={fileName || "image"}
          className="max-h-80 w-full rounded-lg border border-emerald-500/25 bg-black/20 object-contain shadow-[0_0_18px_rgba(34,211,238,.15)]"
          crossOrigin="anonymous"
        />
      )}

      {isVideo && (
        <video
          src={url}
          controls
          preload="metadata"
          className="max-h-80 w-full rounded-lg border border-emerald-500/25 bg-black/30"
          controlsList="nodownload noplaybackrate"
        />
      )}

      {isAudio && (
        <audio src={url} controls preload="metadata" className="w-full">
          Your browser does not support the audio element.
        </audio>
      )}

      {isPdf && (
        <div className="text-xs text-emerald-300/80">
          PDF preview may open externally on mobile.
          <div className="mt-1">
            <a
              href={url}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 text-emerald-300 underline underline-offset-4 hover:text-emerald-200"
            >
              <FileText className="h-3.5 w-3.5" />
              Open PDF
            </a>
          </div>
        </div>
      )}

      {!isImage && !isVideo && !isAudio && !isPdf && (
        <div className="flex items-center gap-2">
          <a
            href={url}
            download={fileName || "file"}
            className="inline-flex items-center gap-1 rounded-md border border-emerald-500/25 px-2 py-1 text-xs text-emerald-200 hover:bg-emerald-500/10"
          >
            <Download className="h-3.5 w-3.5" />
            Download
          </a>
          <a
            href={url}
            target="_blank"
            rel="noreferrer"
            className="text-xs text-emerald-300 underline underline-offset-4 hover:text-emerald-200"
          >
            Open
          </a>
        </div>
      )}

      <div className="flex items-center gap-2 text-[10px] text-emerald-300/70">
        <a
          href={url}
          target="_blank"
          rel="noreferrer"
          className="truncate underline underline-offset-4 hover:text-emerald-200"
          title={cid}
        >
          {cid}
        </a>
        <Button
          size="icon"
          variant="ghost"
          className="h-6 w-6 text-emerald-300 hover:text-emerald-200"
          onClick={copyCid}
          title="Copy CID"
        >
          {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
        </Button>
      </div>
    </div>
  )
}

function MarkdownRenderer({ text }: { text: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        code({ inline, className, children, ...props }: any) {
          const match = /language-(\w+)/.exec(className || "")
          if (!inline) {
            return (
              <SyntaxHighlighter
                style={coldarkDark}
                language={match?.[1] || "text"}
                PreTag="div"
                customStyle={{
                  margin: "0.25rem 0 0 0",
                  borderRadius: "0.5rem",
                  border: "1px solid rgba(16,185,129,.25)",
                  background: "#0a1311",
                  boxShadow: "0 0 12px rgba(16,185,129,.15)",
                }}
                {...props}
              >
                {String(children).replace(/\n$/, "")}
              </SyntaxHighlighter>
            )
          }
          return (
            <code className="rounded bg-black/30 px-1 py-0.5 font-mono text-[0.85em] text-emerald-200" {...props}>
              {children}
            </code>
          )
        },
        a({ children, href, ...props }: any) {
          return (
            <a
              href={href}
              target="_blank"
              rel="noreferrer"
              className="text-emerald-300 underline underline-offset-4 hover:text-emerald-200"
              {...props}
            >
              {children}
            </a>
          )
        },
        strong({ children }: any) {
          return <strong className="text-emerald-100">{children}</strong>
        },
        em({ children }: any) {
          return <em className="text-emerald-200">{children}</em>
        },
        ul({ children }: any) {
          return <ul className="list-disc pl-5">{children}</ul>
        },
        ol({ children }: any) {
          return <ol className="list-decimal pl-5">{children}</ol>
        },
        blockquote({ children }: any) {
          return (
            <blockquote className="border-l-2 border-emerald-500/30 pl-3 text-emerald-200/80">{children}</blockquote>
          )
        },
        p({ children }: any) {
          return <p className="leading-relaxed">{children}</p>
        },
      }}
    >
      {text}
    </ReactMarkdown>
  )
}

export default LiveChat

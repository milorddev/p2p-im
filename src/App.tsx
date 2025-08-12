import React, { useState, useEffect, useRef } from 'react'
import { selfId, type Room } from 'trystero'
import { joinRoomWithFallback } from '@/lib/trystero-client'

const config = { appId: 'my_super_react_app' } // Use a unique identifier for your app

function App() {
  const [room, setRoom] = useState<Room | null>(null)
  const [message, setMessage] = useState('')
  const [chatMessages, setChatMessages] = useState([])
  const sendChatRef = useRef<((m: string) => void) | null>(null)

  useEffect(() => {
    let manager: Awaited<ReturnType<typeof joinRoomWithFallback>> | null = null

    joinRoomWithFallback(config, 'chatroom').then((mgr) => {
      manager = mgr
      setRoom(mgr.room)

      const [sendChat, getChat] = mgr.room.makeAction('chat')
      sendChatRef.current = sendChat

      getChat((msg, peerId) => {
        setChatMessages((prev) => [...prev, { sender: peerId, msg }])
      })

      mgr.room.onPeerJoin((peerId) => {
        console.log(`Peer ${peerId} joined`)
      })

      mgr.onReconnect((r) => {
        const [send, get] = r.makeAction('chat')
        sendChatRef.current = send
        get((msg, peerId) => {
          setChatMessages((prev) => [...prev, { sender: peerId, msg }])
        })
      })
    })

    return () => {
      manager?.leave()
    }
  }, [])

  const handleSend = () => {
    if (room && sendChatRef.current && message.trim() !== '') {
      // Send the message to all peers
      sendChatRef.current(message)
      // Optionally, add the message to your own chat display
      setChatMessages((prev) => [...prev, { sender: selfId, msg: message }])
      setMessage('')
    }
  }

  return (
    <div style={{ padding: '2rem' }}>
      <h1>Trystero Chat</h1>
      <div
        style={{
          border: '1px solid #ccc',
          padding: '1rem',
          marginBottom: '1rem',
          height: '300px',
          overflowY: 'scroll'
        }}
      >
        {chatMessages.map((m, index) => (
          <div key={index}>
            <strong>{m.sender === selfId ? 'Me' : m.sender}:</strong> {m.msg}
          </div>
        ))}
      </div>
      <div>
        <input
          type="text"
          value={message}
          placeholder="Type your message..."
          onChange={(e) => setMessage(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleSend()}
          style={{ width: '80%', padding: '0.5rem' }}
        />
        <button onClick={handleSend} style={{ padding: '0.5rem 1rem', marginLeft: '0.5rem' }}>
          Send
        </button>
      </div>
    </div>
  )
}

export default App

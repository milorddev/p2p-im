import React, { useState, useEffect, useRef } from 'react'
import { selfId } from 'trystero'
import {joinRoom} from 'trystero/torrent'

const config = { appId: 'my_super_react_app' } // Use a unique identifier for your app

function App() {
  const [room, setRoom] = useState(null)
  const [message, setMessage] = useState('')
  const [chatMessages, setChatMessages] = useState([])
  const sendChatRef = useRef(null)

  useEffect(() => {
    // Join the room (using "chatroom" as the room name)
    const roomInstance = joinRoom(config, 'chatroom')
    setRoom(roomInstance)

    // Create a chat action for sending and receiving messages
    const [sendChat, getChat] = roomInstance.makeAction('chat')
    sendChatRef.current = sendChat

    // Listen for incoming chat messages
    getChat((msg, peerId) => {
      setChatMessages((prev) => [...prev, { sender: peerId, msg }])
    })

    // Log when peers join (optional)
    roomInstance.onPeerJoin((peerId) => {
      console.log(`Peer ${peerId} joined`)
    })

    // Cleanup when component unmounts
    return () => {
      roomInstance.leave()
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

---
name: whatsapp-listener
description: Activates the WhatsApp Earpiece to receive, search, and send WhatsApp messages via the local WebSocket Engine.
---

# Instructions

## 1. Engine Health Check & Auto-Start
Before starting the listener or running commands, verify that the local WhatsApp Engine (`ws://localhost:8080`) is online:
1. Run:
   `node C:\Users\cheta\Documents\antigravity\jarvis\whatsapp-engine\client.js status`
2. If the engine is offline, start it as a daemon (`IsDaemon: true`, `WaitMsBeforeAsync: 5000`):
   `node C:\Users\cheta\Documents\antigravity\jarvis\whatsapp-engine\engine.js`
   *(Optional)* You can also launch the live monitor dashboard on `http://localhost:3000` (`IsDaemon: true`):
   `node C:\Users\cheta\Documents\antigravity\jarvis\whatsapp-engine\dashboard.js`

## 2. Activating the Earpiece Listener
When the user asks to start, activate, or run the WhatsApp listener/earpiece:
1. Use `run_command` to run the listener in the background (`WaitMsBeforeAsync: 500`):
   `node C:\Users\cheta\Documents\antigravity\jarvis\whatsapp-engine\client.js listen`
   - **Keyword Filtering**: Only wake up when a specific keyword is mentioned:
     `node C:\Users\cheta\Documents\antigravity\jarvis\whatsapp-engine\client.js listen --keyword "your_keyword"`
   - **Chat / Sender Filtering**: Only wake up for messages from a specific chat or contact:
     `node C:\Users\cheta\Documents\antigravity\jarvis\whatsapp-engine\client.js listen --chat "Gamla"`
2. Inform the user that the Earpiece is active and listening for incoming WhatsApp messages.
3. When the background task completes, read the task output containing the `[WHATSAPP MESSAGE RECEIVED]` block (including `From`, `Chat`, `ChatID`, `ID`, and optional `Media` path).
4. Process the message according to the user's instructions.
5. **CRITICAL — CONTINUOUS RE-LISTEN LOOP**: Immediately after processing a message, re-run the `client.js listen` command (step 1) in the background so you never miss subsequent messages. The engine holds unacknowledged messages in an ACK-verified queue while you process the current message.

## 3. Additional CLI Commands (`client.js`)
- **Send Message** *(ONLY when explicitly instructed by the user — never send unsolicited automated replies)*:
  `node C:\Users\cheta\Documents\antigravity\jarvis\whatsapp-engine\client.js send "<ChatID_or_Name>" "<Message>" [--replyTo "<MessageID>"] [--media "<AbsolutePath>"]`
- **Fetch Chat History**:
  `node C:\Users\cheta\Documents\antigravity\jarvis\whatsapp-engine\client.js history "<ChatNameQuery>" [limit]`
- **List Groups**:
  `node C:\Users\cheta\Documents\antigravity\jarvis\whatsapp-engine\client.js groups ["<Query>"]`
- **UI DOM Search (Fallback for Unindexed Chats/Communities)**:
  `node C:\Users\cheta\Documents\antigravity\jarvis\whatsapp-engine\client.js ui_search "<Query>" ["<TargetTitle>"]`
- **Download Media by Message ID**:
  `node C:\Users\cheta\Documents\antigravity\jarvis\whatsapp-engine\scripts\get_media.js "<MessageID>" [outputFilename]`

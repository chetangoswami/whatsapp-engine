---
name: whatsapp-listener
description: >-
  Activates the WhatsApp Earpiece to receive, search, analyze, and send WhatsApp
  messages and media via the local WebSocket Engine (ws://localhost:8080). Use
  whenever the user asks to start the WhatsApp listener/earpiece, monitor a chat
  or keyword, fetch WhatsApp chat history, list groups, download attachments, or
  send a WhatsApp reply.
---

# WhatsApp Listener & Engine Skill (`whatsapp-listener`)

This skill connects Antigravity to the **WhatsApp WebSocket Engine** (`whatsapp-engine`), enabling real-time read-only message listening, history retrieval, group discovery, attachment downloading, and user-authorized outbound messaging.

> **Engine Path & Cloud Bridge Resolution (`<ENGINE_DIR>`):**
> - **Local Windows Machine:** `C:\Users\cheta\Documents\antigravity\jarvis\whatsapp-engine`
> - **Remote Cloud VM / Linux Sandbox (`/home/antigravity/...`):** Do **NOT** start `engine.js` inside a firewalled Cloud VM (whose proxy blocks `wss://web.whatsapp.com/ws/chat`). Instead, run `node <ENGINE_DIR>/client.js <command>` directly! When `localhost:8080` is not running locally, `client.js` **automatically discovers** the active HTTPS Cloudflare Bridge URL published to `chetangoswami/whatsapp-engine`'s repository metadata and routes all commands (`status`, `listen`, `history`, `groups`, `send`) over standard HTTPS (`POST /api/rpc` and `GET /api/poll`), bypassing WebSocket proxy blocks completely.

---

## 1. Engine Health Check & Auto-Start

Before launching the listener or running a query, verify that the local WhatsApp Engine (`ws://localhost:8080`) is running and authenticated:

1. Check engine status (`WaitMsBeforeAsync: 5000`):
   ```powershell
   node C:\Users\cheta\Documents\antigravity\jarvis\whatsapp-engine\client.js status
   ```
2. If the engine is offline (`ECONNREFUSED`) or `"ready": false`:
   - Start the engine daemon (`IsDaemon: true`, `WaitMsBeforeAsync: 5000`):
     ```powershell
     node C:\Users\cheta\Documents\antigravity\jarvis\whatsapp-engine\engine.js
     ```
   - *(Optional)* Start the live web monitor dashboard at `http://localhost:3000` (`IsDaemon: true`, `WaitMsBeforeAsync: 3000`):
     ```powershell
     node C:\Users\cheta\Documents\antigravity\jarvis\whatsapp-engine\dashboard.js
     ```

---

## 2. Activating the Earpiece Listener

When the user asks to start, activate, or run the WhatsApp listener/earpiece:

1. Launch `client.js listen` in the background (`WaitMsBeforeAsync: 500`):
   - **Listen to All Incoming Messages:**
     ```powershell
     node C:\Users\cheta\Documents\antigravity\jarvis\whatsapp-engine\client.js listen
     ```
   - **Keyword-Filtered Routing** (only wake up when a specific keyword appears):
     ```powershell
     node C:\Users\cheta\Documents\antigravity\jarvis\whatsapp-engine\client.js listen --keyword "jarvis"
     ```
   - **Chat / Contact Filtered Routing** (only wake up for a specific group or sender):
     ```powershell
     node C:\Users\cheta\Documents\antigravity\jarvis\whatsapp-engine\client.js listen --chat "Gamla"
     ```
2. Inform the user that the WhatsApp Earpiece is active and listening. Do **not** poll in a loop—stop calling tools and wait for the system notification when a message arrives.
3. When the background task completes, read the task output containing the `[WHATSAPP MESSAGE RECEIVED]` block:
   - `From`: Sender's display name or number
   - `Chat`: Group name (if received in a group)
   - `ChatID`: Serialized WhatsApp JID (`...@c.us`, `...@g.us`, or `...@lid`)
   - `[ID: ...]`: Unique serialized message ID (used for `--replyTo` or `get_media.js`)
   - `Media`: Absolute path to any auto-downloaded attachment inside `media/`
4. Process the message according to the user's instructions (e.g., summarizing, extracting tasks, or answering).
5. **CRITICAL — CONTINUOUS RE-LISTEN LOOP:** Immediately after processing the message, launch the `client.js listen` command (Step 1) in the background again so subsequent messages are never dropped. Any messages that arrived while you were busy are held in the engine's ACK-verified queue and will be delivered immediately upon reconnecting.

---

## 3. Querying History, Groups & Media

Use these synchronous CLI commands (`WaitMsBeforeAsync: 8000`) when the user asks to inspect past messages or groups:

- **Fetch Chat History:**
  ```powershell
  node C:\Users\cheta\Documents\antigravity\jarvis\whatsapp-engine\client.js history "<ChatNameOrID>" [limit]
  ```
- **List or Search Groups:**
  ```powershell
  node C:\Users\cheta\Documents\antigravity\jarvis\whatsapp-engine\client.js groups ["<SearchQuery>"]
  ```
- **UI DOM Search (Fallback for Unindexed Communities / Subgroups):**
  ```powershell
  node C:\Users\cheta\Documents\antigravity\jarvis\whatsapp-engine\client.js ui_search "<SearchQuery>" ["<TargetChatTitle>"]
  ```
- **Download Media Attachment by Message ID:**
  ```powershell
  node C:\Users\cheta\Documents\antigravity\jarvis\whatsapp-engine\scripts\get_media.js "<MessageID>" [outputFilenameWithoutExt]
  ```
- **Batch Scan Academic / Assignment Groups:**
  ```powershell
  node C:\Users\cheta\Documents\antigravity\jarvis\whatsapp-engine\scripts\fetch_assignments.js
  ```

---

## 4. Sending Messages & Safety Rules

- **Strict Safety Lock:** Only send messages when explicitly instructed by the user. Never send unsolicited or automated replies.
- **Send Text, Quoted Reply, or Media Attachment:**
  ```powershell
  node C:\Users\cheta\Documents\antigravity\jarvis\whatsapp-engine\client.js send "<ChatID_or_ExactName>" "<MessageText>" [--replyTo "<MessageID>"] [--media "<AbsoluteFilePath>"]
  ```
- Prefer passing the exact `ChatID` (e.g., `919876543210@c.us` or `1203630...@g.us`) over display names to avoid ambiguity.

> For deep WebSocket JSON payload schemas, ACK queue internals, and troubleshooting steps, read [references/websocket-protocol.md](./references/websocket-protocol.md).

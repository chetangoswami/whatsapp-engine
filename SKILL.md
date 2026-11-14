---
name: whatsapp-listener
description: >-
  Activates the WhatsApp Earpiece to receive, search, analyze, and send WhatsApp
  messages and media via the local WebSocket Engine or Private HTTPS Cloud Bridge.
  Use whenever the user asks to start the WhatsApp listener/earpiece, monitor a
  chat or keyword, fetch WhatsApp chat history, list groups, download attachments,
  or send a WhatsApp reply.
---

# WhatsApp Listener & Engine Skill (`whatsapp-listener`)

This skill connects Antigravity to the **WhatsApp WebSocket Engine & Private Cloud Bridge** (`whatsapp-engine`), enabling real-time read-only message listening, history retrieval, group discovery, attachment downloading, and user-authorized outbound messaging.

> **Engine Path & Private Cloud Bridge Resolution (`<ENGINE_DIR>`):**
> - Set `<ENGINE_DIR>` to your cloned `whatsapp-engine` folder (e.g., `./whatsapp-engine` or `C:\Users\cheta\Documents\antigravity\jarvis\whatsapp-engine`).
> - **Local Host Mode:** When running on the host machine where WhatsApp is linked, `client.js` connects to `ws://localhost:8080`.
> - **Remote Cloud Agent / VM Mode:** Do **NOT** start `engine.js` inside a firewalled Cloud VM (whose proxy blocks `wss://web.whatsapp.com/ws/chat`). Instead, run `node <ENGINE_DIR>/client.js <command>` directly! When `localhost:8080` is not running locally, `client.js` uses the caller's authenticated GitHub credentials (`gh auth token` / `git credential fill`) to read `<owner>/whatsapp-bridge-config` (a **private** GitHub repository), retrieves the user's private HTTPS tunnel URL + 256-bit Bearer token, and routes all commands over authenticated HTTPS (`POST /api/rpc` and `GET /api/poll`).

---

## 1. Engine Health Check & Auto-Start

Before launching the listener or running a query, verify that the WhatsApp Engine is reachable:

1. Check engine status (`WaitMsBeforeAsync: 5000`):
   ```bash
   node <ENGINE_DIR>/client.js status
   ```
2. If you are on the **local host machine** and the engine is offline (`ECONNREFUSED`):
   - Start the engine daemon (`IsDaemon: true`, `WaitMsBeforeAsync: 5000`):
     ```bash
     node <ENGINE_DIR>/engine.js
     ```
   - *(Optional)* To allow remote Cloud Agents to securely access your local engine, start the Private Cloud Bridge (`IsDaemon: true`, `WaitMsBeforeAsync: 8000`):
     ```bash
     node <ENGINE_DIR>/scripts/start_cloud_bridge.js
     ```
   - *(Optional)* Start the live web monitor dashboard at `http://localhost:3000` (`IsDaemon: true`, `WaitMsBeforeAsync: 3000`):
     ```bash
     node <ENGINE_DIR>/dashboard.js
     ```

---

## 2. Activating the Earpiece Listener

When the user asks to start, activate, or run the WhatsApp listener/earpiece:

1. Launch `client.js listen` in the background (`WaitMsBeforeAsync: 500`):
   - **Listen to All Incoming Messages:**
     ```bash
     node <ENGINE_DIR>/client.js listen
     ```
   - **Keyword-Filtered Routing** (only wake up when a specific keyword appears):
     ```bash
     node <ENGINE_DIR>/client.js listen --keyword "jarvis"
     ```
   - **Chat / Contact Filtered Routing** (only wake up for a specific group or sender):
     ```bash
     node <ENGINE_DIR>/client.js listen --chat "Gamla"
     ```
2. Inform the user that the WhatsApp Earpiece is active and listening. Do **not** poll in a loop—stop calling tools and wait for the system notification when a message arrives.
3. When the background task completes, read the task output containing the `[WHATSAPP MESSAGE RECEIVED]` block:
   - `From`: Sender's display name or number
   - `Chat`: Group name (if received in a group)
   - `ChatID`: Serialized WhatsApp JID (`...@c.us`, `...@g.us`, or `...@lid`)
   - `[ID: ...]`: Unique serialized message ID (used for `--replyTo` or `get_media.js`)
   - `Media`: Path to any auto-downloaded attachment inside `media/`
4. Process the message according to the user's instructions (e.g., summarizing, extracting tasks, or answering).
5. **CRITICAL — CONTINUOUS RE-LISTEN LOOP:** Immediately after processing the message, launch the `client.js listen` command (Step 1) in the background again so subsequent messages are never dropped. Any messages that arrived while you were busy are held in the engine's ACK-verified queue and will be delivered immediately upon reconnecting.

---

## 3. Querying History, Groups & Media

Use these synchronous CLI commands (`WaitMsBeforeAsync: 8000`) when the user asks to inspect past messages or groups:

- **Fetch Chat History:**
  ```bash
  node <ENGINE_DIR>/client.js history "<ChatNameOrID>" [limit]
  ```
- **List or Search Groups:**
  ```bash
  node <ENGINE_DIR>/client.js groups ["<SearchQuery>"]
  ```
- **UI DOM Search (Fallback for Unindexed Communities / Subgroups):**
  ```bash
  node <ENGINE_DIR>/client.js ui_search "<SearchQuery>" ["<TargetChatTitle>"]
  ```
- **Download Media Attachment by Message ID:**
  ```bash
  node <ENGINE_DIR>/scripts/get_media.js "<MessageID>" [outputFilenameWithoutExt]
  ```

---

## 4. Sending WhatsApp Messages & Safety Rules

- **Strict Safety Lock:** Only send WhatsApp messages when explicitly instructed by the user. Never send unsolicited or automated replies.
- **Send Text, Quoted Reply, or Media Attachment:**
  ```bash
  node <ENGINE_DIR>/client.js send "<ChatID_or_ExactName>" "<MessageText>" [--replyTo "<MessageID>"] [--media "<AbsoluteFilePath>"]
  ```
- Prefer passing the exact `ChatID` (e.g., `919876543210@c.us` or `1203630...@g.us`) over display names to avoid ambiguity.

---

## 5. Cloud ↔ Local Agent Intercom (`agent-send`)

The Cloud Agent (on a remote VM) and the Local Agent (on the host PC) can communicate directly with each other in real time through the same Earpiece (`client.js listen`) and Live Dashboard (`http://localhost:8080/`):

- **Cloud Agent → Local Agent** (wakes up the Local Agent's active Earpiece with `[AGENT INTERCOM MESSAGE RECEIVED]`):
  ```bash
  node <ENGINE_DIR>/client.js agent-send "local" "<MessageToLocalAgent>"
  ```
- **Local Agent → Cloud Agent** (wakes up the Cloud Agent's active `/api/poll` Earpiece with `[AGENT INTERCOM MESSAGE RECEIVED]`):
  ```bash
  node <ENGINE_DIR>/client.js agent-send "cloud" "<MessageToCloudAgent>"
  ```
- When awakened by an `[AGENT INTERCOM MESSAGE RECEIVED]` event, process the peer agent's request/update, reply via `agent-send` if needed, and immediately restart `node <ENGINE_DIR>/client.js listen` in the background.

> For deep WebSocket & HTTPS Bridge JSON payload schemas, ACK queue internals, and troubleshooting steps, read [skills/whatsapp-listener/references/websocket-protocol.md](./skills/whatsapp-listener/references/websocket-protocol.md).

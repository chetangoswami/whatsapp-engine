# WhatsApp Engine WebSocket Protocol & Troubleshooting Reference

The WhatsApp Engine runs a local WebSocket server on `ws://localhost:8080` (configurable via `WHATSAPP_ENGINE_PORT`). All payloads are UTF-8 JSON objects.

---

## 1. Client Roles & Queue Semantics

When a WebSocket client connects to `ws://localhost:8080`, it can register its role so the engine knows how to route and queue incoming messages:

### Register as an Active Listener (`register_listener`)
```json
{
  "action": "register_listener",
  "keyword": "jarvis",
  "chat": "gamla",
  "mentionedOnly": true
}
```
- `keyword` *(optional, string)*: Case-insensitive substring filter on `msg.body`.
- `chat` *(optional, string)*: Case-insensitive substring filter matched against `senderName`, `chatName`, and `from` JID.
- `mentionedOnly` *(optional, boolean)*: When `true`, only delivers messages where `msg.isMeMentioned === true` (or `agent_intercom` messages).
- **Queue Behavior**: Upon registration, the engine flushes the oldest unacknowledged message from `messageQueue` that matches the listener's filter.

### Acknowledge Processed Message (`ack_message`)
```json
{
  "action": "ack_message",
  "id": "false_1234567890@c.us_3EB0..."
}
```
- Removes the message with matching `id` from `messageQueue`.
- Ensures burst messages arriving while an AI agent is busy processing a previous turn are never lost.

### Register as a Passive Monitor (`register_monitor`)
```json
{
  "action": "register_monitor"
}
```
- Used by `dashboard.js`. Receives real-time `incoming_message` and `outgoing_message` broadcasts without ever draining `messageQueue`.

---

## 2. Server-to-Client Broadcast Events

### `incoming_message`
```json
{
  "type": "incoming_message",
  "id": "false_919876543210@c.us_3EB0123456789",
  "from": "919876543210@c.us",
  "senderName": "Hardik",
  "chatName": "Gamla Discussions",
  "body": "Can we check the client deck?",
  "isGroup": true,
  "timestamp": 1763128000,
  "media": {
    "filename": "temp_1763128000123.pdf",
    "mimetype": "application/pdf",
    "path": "C:\\Users\\cheta\\Documents\\antigravity\\jarvis\\whatsapp-engine\\media\\temp_1763128000123.pdf"
  }
}
```
- `media` is `null` if the message has no attachment.

### `outgoing_message`
```json
{
  "type": "outgoing_message",
  "to": "Gamla Discussions",
  "body": "Deck is ready for review."
}
```

---

## 3. Request / Response Actions

### `status`
- **Request:** `{ "action": "status", "requestId": "stat_1" }`
- **Response (`status_response`):**
  ```json
  {
    "type": "status_response",
    "requestId": "stat_1",
    "ready": true,
    "queuedMessages": 0,
    "connectedClients": 2
  }
  ```

### `send_message`
- **Request:**
  ```json
  {
    "action": "send_message",
    "requestId": "send_1",
    "to": "120363431880017269@g.us",
    "text": "Hey @919773530466, here is the updated document.",
    "quotedMessageId": "false_919876543210@c.us_3EB0...",
    "mediaPath": "C:\\absolute\\path\\to\\file.pdf",
    "mentions": ["9773530466"]
  }
  ```
- **Response (`send_response`):**
  ```json
  {
    "type": "send_response",
    "requestId": "send_1",
    "ok": true,
    "id": "true_120363431880017269@g.us_3EB0...",
    "mentions": ["919773530466@c.us"]
  }
  ```

### `create_group`
- **Request:**
  ```json
  {
    "action": "create_group",
    "requestId": "cgrp_1",
    "title": "Jarvis Tag Test",
    "participants": ["9773530466"]
  }
  ```
- **Response (`create_group_response`):**
  ```json
  {
    "type": "create_group_response",
    "requestId": "cgrp_1",
    "ok": true,
    "title": "Jarvis Tag Test",
    "gid": "120363431880017269@g.us",
    "participants": {
      "919773530466@c.us": { "statusCode": 200 }
    }
  }
  ```

### `agent_message` (Cloud ↔ Local Agent Intercom)
- **Request:**
  ```json
  {
    "action": "agent_message",
    "requestId": "ag_1",
    "fromAgent": "Cloud Agent",
    "target": "local",
    "text": "Downloaded all 12 full-res screenshots."
  }
  ```
- **Response (`agent_message_response`):** `{ "type": "agent_message_response", "ok": true, "id": "agent_1763..." }`

### `fetch_history`
- **Request:** `{ "action": "fetch_history", "query": "Gamla", "limit": 50, "requestId": "hist_1" }`
- **Response (`history_response`):** Returns matching chats with formatted messages (`id`, `fromMe`, `sender`, `type`, `body`, `hasMedia`, `timestamp`, `timeIST`).

### `list_chats`
- **Request:** `{ "action": "list_chats", "groupsOnly": true, "query": "CSE", "requestId": "grp_1" }`
- **Response (`list_response`):** Returns `totalChats` and filtered `chats` (`id`, `name`, `isGroup`, `archived`, `timestamp`).

### `ui_search_chat`
- **Request:** `{ "action": "ui_search_chat", "query": "Gamla", "targetTitle": "Gamla Discussions", "requestId": "ui_1" }`
- **Response (`ui_search_response`):** Queries `WAWebCollections.Chat` in Puppeteer and falls back to typing in the WhatsApp Web search bar to extract visible DOM rows for unindexed community/subgroup chats.

### `fetch_media`
- **Request:** `{ "action": "fetch_media", "messageId": "false_..." }`
- **Response (`media_response`):** Returns `{ "type": "media_response", "messageId": "...", "media": { "mimetype": "...", "data": "<base64>" } }`.

---

## 4. Troubleshooting

1. **`Engine offline: connect ECONNREFUSED 127.0.0.1:8080`**
   - The background engine (`engine.js`) is not running. Start it in daemon mode (`node engine.js`) and wait ~10–15 seconds for Puppeteer and `LocalAuth` to emit `WhatsApp Client is READY`.
2. **QR Code Required (`[Engine] QR CODE REQUIRED!`)**
   - Open `WhatsApp_QR.html` in the project root (or view `media/whatsapp_qr.png`) and scan via **WhatsApp -> Linked Devices -> Link a Device**. Once authenticated, session tokens persist automatically in `.wwebjs_auth/`.
3. **Chat Not Found When Sending by Name**
   - Run `node client.js groups "<Name>"` or `node client.js history "<Name>" 5` first to retrieve the exact serialized `ChatID` (`...@c.us`, `...@g.us`, or `...@lid`), then pass that `ChatID` to `node client.js send`.

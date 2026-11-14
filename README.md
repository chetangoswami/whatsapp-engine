# WhatsApp Engine & Agent Earpiece (`whatsapp-listener`)

[![License: MIT](https://img.shields.io/badge/License-MIT-00a884.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/Node.js-18%2B-339933.svg)](https://nodejs.org/)
[![Protocol](https://img.shields.io/badge/WebSocket-Port%208080-53bdeb.svg)](#websocket-protocol)
[![Agent Skill](https://img.shields.io/badge/Agent%20Skill-whatsapp--listener-a78bfa.svg)](./skills/whatsapp-listener/SKILL.md)

A persistent local **WhatsApp WebSocket Engine**, **CLI Earpiece Listener**, and **Live Web Monitor Dashboard** built on `whatsapp-web.js` for autonomous AI agent workflows (Google Antigravity, Claude Code, Codex, and custom agent runtimes).

---

## System Architecture

```mermaid
flowchart LR
    WA["WhatsApp Web\n(Puppeteer + LocalAuth)"] <--> ENG["src/engine.js\nWebSocket Server (:8080)\n+ ACK Message Queue"]
    ENG <-->|"register_listener\n+ ack_message"| CLI["src/client.js\nAgent CLI Earpiece"]
    ENG -->|"register_monitor\n(Read-Only Stream)"| DASH["src/dashboard.js\nLive Web UI (:3000)"]
    ENG -->|"Atomic Write"| LOG["chat_logs.json\n(Deduplicated Log)"]
    CLI <-->|"Wakeup & Commands"| AGY["AI Agent\n(whatsapp-listener Skill)"]
```

### Repository Structure

```text
whatsapp-engine/
├── src/
│   ├── engine.js                              # Persistent WhatsApp client + WS server (ws://localhost:8080)
│   ├── client.js                              # CLI Earpiece (listen, send, status, history, groups, ui_search)
│   ├── dashboard.js                           # Real-time web monitor UI (http://localhost:3000)
│   └── utils/
│       └── logger.js                          # Atomic, deduplicated JSON chat logger
├── scripts/
│   ├── fetch_assignments.js                   # Batch assignment & academic group scanner
│   └── get_media.js                           # On-demand media attachment downloader by Message ID
├── skills/
│   └── whatsapp-listener/
│       ├── SKILL.md                           # Official Agent Skill instructions
│       └── references/
│           └── websocket-protocol.md          # Full WebSocket JSON schema & troubleshooting guide
├── SKILL.md                                   # Root skill entrypoint for single-repo skill installers
├── engine.js                                  # Root shim -> src/engine.js
├── client.js                                  # Root shim -> src/client.js
└── dashboard.js                               # Root shim -> src/dashboard.js
```

---

## Core Capabilities

1. **ACK-Verified Message Queue (Zero Dropped Messages)**
   - Incoming messages that arrive while the AI agent is busy processing a turn are buffered in `engine.js` (up to 100 messages).
   - Messages are **only** removed from the queue when an active `listener` client sends an `ack_message` frame.
   - Passive monitors (`dashboard.js`) and filtered listeners (`--keyword`, `--chat`) never drain unmatched messages from the queue.
2. **Read-Only Safety Lock**
   - Listening to messages never triggers automatic blue ticks (`sendSeen`), typing indicators, or unsolicited auto-replies. Outbound messages are strictly opt-in via `client.js send`.
3. **Isolated Media & Session Storage**
   - Incoming media attachments are automatically saved into the git-ignored `media/` folder and their paths are included in the `[WHATSAPP MESSAGE RECEIVED]` output block.
   - Multi-Device authentication tokens persist across restarts inside `.wwebjs_auth/`.
4. **Live Web Monitor (`http://localhost:3000`)**
   - Dark-mode dashboard displaying connection health, queue protection status, and a real-time XSS-sanitized message stream.

---

## Installation & Setup

### 1. Clone & Install Dependencies

```bash
git clone https://github.com/chetangoswami/whatsapp-engine.git
cd whatsapp-engine
npm install
```

### 2. Start the Engine & Link WhatsApp

```bash
npm start
# or: node engine.js
```

- On first run, the engine generates a QR code in your terminal **and** creates a self-refreshing `WhatsApp_QR.html` file in the project root (plus `media/whatsapp_qr.png`).
- Scan the QR code using **WhatsApp -> Linked Devices -> Link a Device**.
- Once linked, you will see:
  ```text
  [Engine] WhatsApp Client is READY and listening for messages!
  ```

### 3. Install the Agent Skill

Copy `skills/whatsapp-listener` into your global or workspace skills folder:

```powershell
# Global Antigravity skills directory:
Copy-Item -Path ".\skills\whatsapp-listener" -Destination "$HOME\.gemini\config\skills\whatsapp-listener" -Recurse -Force

# Or workspace-level skills directory:
Copy-Item -Path ".\skills\whatsapp-listener" -Destination ".\.agents\skills\whatsapp-listener" -Recurse -Force
```

---

## CLI Reference (`client.js`)

| Command | Description | Example |
| :--- | :--- | :--- |
| `status` | Checks if the engine is online, authenticated, and reports queue size. | `node client.js status` |
| `listen` | Connects to the engine and waits for the next matching message, prints `[WHATSAPP MESSAGE RECEIVED]`, acknowledges receipt, and exits with `0`. | `node client.js listen` |
| `listen --keyword` | Wakes up only when a message contains the specified keyword (case-insensitive). | `node client.js listen --keyword "jarvis"` |
| `listen --chat` | Wakes up only for messages from a matching sender, group name, or ChatID. | `node client.js listen --chat "Gamla"` |
| `listen --continuous` | Keeps streaming matching messages without exiting after the first message. | `node client.js listen --continuous` |
| `send` | Sends a text message, quoted reply (`--replyTo`), or attachment (`--media`). | `node client.js send "919876543210@c.us" "Hello!" --replyTo "<MsgID>" --media "C:/file.pdf"` |
| `history` | Fetches recent messages (with IST timestamps) from matching chats. | `node client.js history "Gamla" 50` |
| `groups` | Lists all WhatsApp groups (optionally filtered by name substring). | `node client.js groups "CSE"` |
| `ui_search` | Fallback Puppeteer DOM search for unindexed community/subgroup chats. | `node client.js ui_search "Gamla" "Gamla Discussions"` |

### Utility Scripts (`scripts/`)

```bash
# Download a specific message's media attachment into ./media/
node scripts/get_media.js "<MessageID>" [outputFilenameWithoutExt]

# Scan academic/college groups for assignment & deadline notices
npm run assignments
```

---

## WebSocket Protocol (`ws://localhost:8080`)

See the full protocol documentation in [`skills/whatsapp-listener/references/websocket-protocol.md`](./skills/whatsapp-listener/references/websocket-protocol.md) for JSON request/response schemas (`register_listener`, `register_monitor`, `ack_message`, `status`, `send_message`, `fetch_history`, `list_chats`, `ui_search_chat`, `fetch_media`).

---

## License

MIT © [Chetan Goswami](https://github.com/chetangoswami)

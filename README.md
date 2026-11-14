# WhatsApp Engine & Agent Earpiece (`whatsapp-listener`)

A local WhatsApp WebSocket Engine, CLI Earpiece Listener, and Real-Time Monitor Dashboard built on `whatsapp-web.js` for AI agent workflows (Google Antigravity).

## Architecture

```
whatsapp-engine/
├── src/
│   ├── engine.js          # Persistent WhatsApp Web client + WebSocket server (ws://localhost:8080)
│   ├── client.js          # CLI Earpiece for listening, sending, history, and group queries
│   ├── dashboard.js       # Real-time web monitor UI (http://localhost:3000)
│   └── utils/
│       └── logger.js      # Atomic, deduplicated JSON chat logger
├── scripts/
│   ├── fetch_assignments.js # Batch assignment & academic group scanner
│   └── get_media.js         # On-demand media attachment downloader by Message ID
├── skill/
│   └── SKILL.md           # Antigravity skill definition (whatsapp-listener)
├── engine.js              # Root entrypoint shim -> src/engine.js
├── client.js              # Root entrypoint shim -> src/client.js
└── dashboard.js           # Root entrypoint shim -> src/dashboard.js
```

## Key Features

- **ACK-Verified Message Queue**: Incoming messages arriving while the agent is busy are buffered in `engine.js` and only removed when an active `listener` client acknowledges receipt (`ack_message`). Passive monitors (`dashboard.js`) and filtered listeners (`--keyword`, `--chat`) never drain unmatched messages.
- **Read-Only Safety Lock**: Incoming messages never trigger automatic read receipts (`sendSeen`), typing indicators, or unsolicited auto-replies.
- **Isolated Media Storage**: Incoming and requested attachments are stored inside the git-ignored `media/` directory.
- **XSS-Safe Live Dashboard**: Real-time WebSocket stream on `http://localhost:3000` with role-based monitor registration.

## Quick Start

```bash
# Install dependencies
npm install

# 1. Start the WhatsApp WebSocket Engine (Port 8080)
npm start

# 2. (Optional) Start the Live Monitor Dashboard (Port 3000)
npm run dashboard

# 3. Check Engine Status
node client.js status

# 4. Listen for Incoming Messages (Earpiece Mode)
node client.js listen
node client.js listen --keyword "jarvis"
node client.js listen --chat "Gamla"

# 5. Query History, Groups, or Send Messages
node client.js history "Gamla" 30
node client.js groups "CSE"
node client.js send "<ChatID_or_Name>" "Hello!" --replyTo "<MessageID>" --media "C:/path/to/file.pdf"
```

const express = require('express');
const { readChatLogs } = require('./utils/logger');

const app = express();
const PORT = Number(process.env.WHATSAPP_DASHBOARD_PORT || 3000);

app.use(express.json());

app.get('/', (req, res) => {
    res.send(`<!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>WhatsApp Engine Monitor</title>
        <script src="https://cdn.tailwindcss.com"></script>
        <script src="https://unpkg.com/lucide@latest"></script>
        <style>
            @import url('https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600&family=JetBrains+Mono:wght@400;500&display=swap');
            body { font-family: 'Inter', sans-serif; background-color: #0b141a; color: #e9edef; }
            .card { background: #111b21; border-radius: 10px; border: 1px solid #202c33; box-shadow: 0 4px 12px rgba(0,0,0,0.15); }
            .log-window { font-family: 'JetBrains Mono', monospace; font-size: 13px; background: #0c1317; color: #8696a0; padding: 1.25rem; border-radius: 8px; overflow-y: auto; height: 380px; border: 1px solid #202c33; }
            .log-success { color: #00a884; }
            .log-info { color: #53bdeb; }
            .log-highlight { color: #a78bfa; }
            .log-alert { color: #f15c6d; }
            .log-entry { padding: 4px 0; border-bottom: 1px solid rgba(255,255,255,0.03); }
        </style>
    </head>
    <body class="min-h-screen p-6 max-w-5xl mx-auto flex flex-col gap-6">
        <div class="flex justify-between items-center border-b border-[#202c33] pb-4">
            <div class="flex items-center gap-3">
                <div class="w-10 h-10 rounded-full bg-[#00a884]/20 text-[#00a884] flex items-center justify-center border border-[#00a884]/30">
                    <i data-lucide="message-square" class="w-5 h-5"></i>
                </div>
                <div>
                    <h1 class="text-2xl font-semibold tracking-tight text-[#e9edef]">WhatsApp Engine & Listener</h1>
                    <p class="text-xs text-[#8696a0] mt-0.5">Real-time local connection & live message stream</p>
                </div>
            </div>
            <div class="flex items-center gap-3">
                <span id="wsStatusBadge" class="px-3 py-1 bg-[#00a884]/20 text-[#00a884] rounded-full border border-[#00a884]/40 flex items-center gap-2 text-xs font-semibold">
                    <div class="w-2 h-2 bg-[#00a884] rounded-full animate-pulse"></div>WS: CONNECTED
                </span>
            </div>
        </div>

        <div class="grid grid-cols-3 gap-4">
            <div class="card p-4 flex items-center gap-3.5">
                <div class="p-2.5 bg-[#202c33] rounded-lg text-[#00a884]">
                    <i data-lucide="shield-check" class="w-5 h-5"></i>
                </div>
                <div>
                    <p class="text-[11px] text-[#8696a0] font-semibold uppercase tracking-wider">Engine Protocol</p>
                    <p class="font-medium text-[#e9edef] text-sm">WebSocket (Port 8080)</p>
                    <p class="text-[11px] text-[#00a884] font-mono mt-0.5">LocalAuth Session Active</p>
                </div>
            </div>

            <div class="card p-4 flex items-center gap-3.5">
                <div class="p-2.5 bg-[#202c33] rounded-lg text-[#53bdeb]">
                    <i data-lucide="radio" class="w-5 h-5"></i>
                </div>
                <div>
                    <p class="text-[11px] text-[#8696a0] font-semibold uppercase tracking-wider">Listener Mode</p>
                    <p class="font-medium text-[#e9edef] text-sm">Read-Only Earpiece</p>
                    <p class="text-[11px] text-[#8696a0] font-mono mt-0.5">Safety Lock: Active (No Auto-Send)</p>
                </div>
            </div>

            <div class="card p-4 flex items-center gap-3.5">
                <div class="p-2.5 bg-[#202c33] rounded-lg text-slate-400">
                    <i data-lucide="bell-off" class="w-5 h-5"></i>
                </div>
                <div>
                    <p class="text-[11px] text-[#8696a0] font-semibold uppercase tracking-wider">Queue Protection</p>
                    <p class="font-medium text-[#e9edef] text-sm">ACK-Verified Queue</p>
                    <p class="text-[11px] text-slate-400 font-mono mt-0.5">Zero dropped burst messages</p>
                </div>
            </div>
        </div>

        <div class="card p-5">
            <div class="flex justify-between items-center mb-3">
                <div class="flex items-center gap-3">
                    <h2 class="font-semibold text-sm text-[#e9edef] flex items-center gap-2">
                        <i data-lucide="terminal" class="w-4 h-4 text-[#8696a0]"></i> Live WhatsApp Message & Activity Stream
                    </h2>
                    <span id="msgCountBadge" class="text-xs bg-[#202c33] text-[#8696a0] px-2 py-0.5 rounded-full font-mono">0 events</span>
                </div>
                <div class="flex items-center gap-2">
                    <button onclick="clearTerminal()" class="text-xs text-[#8696a0] hover:text-[#e9edef] px-2 py-1 rounded bg-[#202c33] transition">Clear View</button>
                    <button onclick="loadLogs(true)" class="text-xs text-[#00a884] hover:bg-[#00a884]/20 px-2 py-1 rounded bg-[#00a884]/10 transition flex items-center gap-1">
                        <i data-lucide="refresh-cw" class="w-3 h-3"></i> Refresh
                    </button>
                </div>
            </div>
            <div id="terminalLog" class="log-window">
                <div class="log-entry log-success">[SYSTEM] WhatsApp Engine running on port 8080 (MultiDevice Authenticated)</div>
                <div class="log-entry text-slate-400">[SYSTEM] Live listener streaming active. Waiting for incoming messages...</div>
            </div>
        </div>

        <script>
            lucide.createIcons();

            const seenSignatures = new Set();
            let totalMsgCount = 0;

            function escapeHtml(str) {
                return String(str ?? '')
                    .replace(/&/g, '&amp;')
                    .replace(/</g, '&lt;')
                    .replace(/>/g, '&gt;')
                    .replace(/"/g, '&quot;')
                    .replace(/'/g, '&#39;');
            }

            function logTerminal(msg, type = '', timeStr = null) {
                const term = document.getElementById('terminalLog');
                const time = timeStr || new Date().toLocaleTimeString();
                const row = document.createElement('div');
                row.className = 'log-entry ' + type;
                row.textContent = '[' + time + '] ' + msg;
                term.appendChild(row);
                term.scrollTop = term.scrollHeight;
                totalMsgCount++;
                document.getElementById('msgCountBadge').textContent = totalMsgCount + ' events';
            }

            function clearTerminal() {
                const term = document.getElementById('terminalLog');
                term.innerHTML = '<div class="log-entry text-slate-400">[SYSTEM] View cleared. Listening for new messages...</div>';
                totalMsgCount = 0;
                document.getElementById('msgCountBadge').textContent = '0 events';
            }

            function connectWs() {
                const badge = document.getElementById('wsStatusBadge');
                try {
                    const ws = new WebSocket('ws://' + window.location.hostname + ':8080');
                    
                    ws.onopen = () => {
                        ws.send(JSON.stringify({ action: 'register_monitor' }));
                        badge.className = "px-3 py-1 bg-[#00a884]/20 text-[#00a884] rounded-full border border-[#00a884]/40 flex items-center gap-2 text-xs font-semibold";
                        badge.innerHTML = '<div class="w-2 h-2 bg-[#00a884] rounded-full animate-pulse"></div>WS: CONNECTED';
                    };

                    ws.onmessage = (event) => {
                        try {
                            const data = JSON.parse(event.data);
                            const sig = (data.id || '') + '_' + (data.from || data.to) + '_' + (data.body || '');
                            if (seenSignatures.has(sig)) return;
                            seenSignatures.add(sig);

                            if (data.type === 'incoming_message') {
                                const sender = data.senderName || data.from;
                                logTerminal('⚡ [INCOMING LIVE] From ' + sender + ': ' + (data.body || '(Media packet)'), 'log-info');
                            } else if (data.type === 'outgoing_message') {
                                logTerminal('⚡ [OUTGOING LIVE] To ' + data.to + ': ' + data.body, 'log-success');
                            }
                        } catch(e) {}
                    };

                    ws.onclose = () => {
                        badge.className = "px-3 py-1 bg-amber-500/20 text-amber-400 rounded-full border border-amber-500/40 flex items-center gap-2 text-xs font-semibold";
                        badge.innerHTML = '<div class="w-2 h-2 bg-amber-400 rounded-full animate-ping"></div>WS: RECONNECTING';
                        setTimeout(connectWs, 3000);
                    };

                    ws.onerror = () => {
                        ws.close();
                    };
                } catch(e) {
                    setTimeout(connectWs, 3000);
                }
            }

            function loadLogs(forceScroll = false) {
                fetch('/api/chat-logs')
                    .then(res => res.json())
                    .then(logs => {
                        if (!Array.isArray(logs)) return;
                        logs.forEach(log => {
                            const text = log.text || '';
                            if (text.includes('API Limit') || text.includes('WebCMD')) return;
                            if (log.type === 'system' && log.time && log.time.startsWith('2026-09')) return;

                            const timeStr = log.time ? new Date(log.time).toLocaleTimeString() : null;
                            const sig = (log.time || '') + '_' + (log.from || log.to || '') + '_' + text;
                            if (seenSignatures.has(sig)) return;
                            seenSignatures.add(sig);

                            if (log.type === 'incoming') {
                                logTerminal('[INCOMING] From ' + log.from + ': ' + (text || '(Media / Sync packet)'), 'log-info', timeStr);
                            } else if (log.type === 'outgoing') {
                                logTerminal('[OUTGOING] To ' + log.to + ': ' + text, 'log-success', timeStr);
                            } else if (log.type === 'system') {
                                logTerminal('[SYSTEM] ' + text, 'text-yellow-400', timeStr);
                            }
                        });
                        if (forceScroll) {
                            const term = document.getElementById('terminalLog');
                            term.scrollTop = term.scrollHeight;
                        }
                    })
                    .catch(err => console.error('Fetch error:', err));
            }

            connectWs();
            loadLogs(true);
            setInterval(() => loadLogs(false), 2000);
        </script>
    </body>
    </html>`);
});

app.get('/api/chat-logs', (req, res) => {
    try {
        res.json(readChatLogs());
    } catch (e) {
        console.error('Error serving /api/chat-logs:', e);
        res.status(500).json({ error: e.message });
    }
});

app.listen(PORT, () => {
    console.log("WhatsApp Engine Dashboard running at http://localhost:" + PORT);
});

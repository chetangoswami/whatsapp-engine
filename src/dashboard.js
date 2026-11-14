const express = require('express');
const fs = require('fs');
const path = require('path');
const { ROOT_DIR, readChatLogs } = require('./utils/logger');

const app = express();
const PORT = Number(process.env.WHATSAPP_DASHBOARD_PORT || 3000);
const QR_PNG_PATH = path.join(ROOT_DIR, 'media', 'whatsapp_qr.png');

app.use(express.json());

app.get('/api/qr', (req, res) => {
    if (fs.existsSync(QR_PNG_PATH)) {
        res.setHeader('Cache-Control', 'no-store');
        res.sendFile(QR_PNG_PATH);
    } else {
        res.status(404).json({ error: 'No QR code pending' });
    }
});

app.get('/api/chat-logs', (req, res) => {
    try {
        res.json(readChatLogs());
    } catch (e) {
        console.error('Error serving /api/chat-logs:', e);
        res.status(500).json({ error: e.message });
    }
});

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
        .log-window { font-family: 'JetBrains Mono', monospace; font-size: 13px; background: #0c1317; color: #8696a0; padding: 1.25rem; border-radius: 8px; overflow-y: auto; height: 400px; border: 1px solid #202c33; scroll-behavior: smooth; }
        .log-success { color: #00a884; }
        .log-info { color: #53bdeb; }
        .log-highlight { color: #a78bfa; }
        .log-alert { color: #f15c6d; }
        .log-entry { padding: 5px 0; border-bottom: 1px solid rgba(255,255,255,0.03); word-break: break-word; }
        .filter-btn.active { background-color: rgba(0, 168, 132, 0.2); color: #00a884; border-color: rgba(0, 168, 132, 0.4); }
    </style>
</head>
<body class="min-h-screen p-6 max-w-5xl mx-auto flex flex-col gap-6">
    <!-- Header -->
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
            <span id="wsStatusBadge" class="px-3 py-1 bg-amber-500/20 text-amber-400 rounded-full border border-amber-500/40 flex items-center gap-2 text-xs font-semibold">
                <div class="w-2 h-2 bg-amber-400 rounded-full animate-ping"></div>WS: CONNECTING
            </span>
        </div>
    </div>

    <!-- Dynamic QR Banner (Hidden unless qrPending is true) -->
    <div id="qrBanner" class="hidden card p-4 border-amber-500/40 flex items-center justify-between gap-4">
        <div>
            <h3 class="text-sm font-semibold text-amber-400">WhatsApp Authentication Required</h3>
            <p class="text-xs text-[#8696a0] mt-1">Open WhatsApp &rarr; Linked Devices &rarr; Link a Device and scan this live QR code.</p>
        </div>
        <img id="qrImage" src="/api/qr" alt="WhatsApp QR" class="w-36 h-36 rounded-lg bg-white p-2" />
    </div>

    <!-- Dynamic Metric Cards -->
    <div class="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div class="card p-4 flex items-center gap-3.5">
            <div class="p-2.5 bg-[#202c33] rounded-lg text-[#00a884]">
                <i data-lucide="shield-check" class="w-5 h-5"></i>
            </div>
            <div>
                <p class="text-[11px] text-[#8696a0] font-semibold uppercase tracking-wider">Engine Status</p>
                <p id="enginePrimaryText" class="font-medium text-[#e9edef] text-sm">Checking Port 8080...</p>
                <p id="engineSubText" class="text-[11px] text-amber-400 font-mono mt-0.5">Waiting for handshake</p>
            </div>
        </div>

        <div class="card p-4 flex items-center gap-3.5">
            <div class="p-2.5 bg-[#202c33] rounded-lg text-[#53bdeb]">
                <i data-lucide="radio" class="w-5 h-5"></i>
            </div>
            <div>
                <p class="text-[11px] text-[#8696a0] font-semibold uppercase tracking-wider">Active Listeners</p>
                <p id="listenerPrimaryText" class="font-medium text-[#e9edef] text-sm">0 Active Earpieces</p>
                <p id="listenerSubText" class="text-[11px] text-[#8696a0] font-mono mt-0.5">Read-Only Safety Lock Active</p>
            </div>
        </div>

        <div class="card p-4 flex items-center gap-3.5">
            <div class="p-2.5 bg-[#202c33] rounded-lg text-slate-400">
                <i data-lucide="layers" class="w-5 h-5"></i>
            </div>
            <div>
                <p class="text-[11px] text-[#8696a0] font-semibold uppercase tracking-wider">ACK Message Queue</p>
                <p id="queuePrimaryText" class="font-medium text-[#e9edef] text-sm">0 Queued Messages</p>
                <p id="queueSubText" class="text-[11px] text-slate-400 font-mono mt-0.5">ACK-verified buffer (max 100)</p>
            </div>
        </div>
    </div>

    <!-- Live Message Log Stream -->
    <div class="card p-5 relative">
        <div class="flex flex-wrap justify-between items-center gap-3 mb-3">
            <div class="flex items-center gap-3">
                <h2 class="font-semibold text-sm text-[#e9edef] flex items-center gap-2">
                    <i data-lucide="terminal" class="w-4 h-4 text-[#8696a0]"></i> Live WhatsApp Message Stream
                </h2>
                <span id="msgCountBadge" class="text-xs bg-[#202c33] text-[#8696a0] px-2 py-0.5 rounded-full font-mono">0 events</span>
            </div>

            <div class="flex flex-wrap items-center gap-2">
                <!-- Filter Buttons -->
                <div class="flex items-center gap-1 bg-[#0c1317] p-1 rounded border border-[#202c33]">
                    <button onclick="setFilter('all')" id="filter-all" class="filter-btn active text-xs px-2 py-0.5 rounded border border-transparent transition">All</button>
                    <button onclick="setFilter('incoming')" id="filter-incoming" class="filter-btn text-xs text-[#8696a0] px-2 py-0.5 rounded border border-transparent transition">Incoming</button>
                    <button onclick="setFilter('outgoing')" id="filter-outgoing" class="filter-btn text-xs text-[#8696a0] px-2 py-0.5 rounded border border-transparent transition">Outgoing</button>
                </div>

                <!-- Search Input -->
                <input id="searchInput" oninput="applyFilters()" type="text" placeholder="Search sender or text..." class="text-xs bg-[#0c1317] border border-[#202c33] rounded px-2.5 py-1 text-[#e9edef] placeholder-[#8696a0] focus:outline-none focus:border-[#00a884]" />

                <button onclick="clearTerminal()" class="text-xs text-[#8696a0] hover:text-[#e9edef] px-2 py-1 rounded bg-[#202c33] transition">Clear</button>
                <button onclick="loadLogs(true)" class="text-xs text-[#00a884] hover:bg-[#00a884]/20 px-2 py-1 rounded bg-[#00a884]/10 transition flex items-center gap-1">
                    <i data-lucide="refresh-cw" class="w-3 h-3"></i> Sync History
                </button>
            </div>
        </div>

        <div id="terminalLog" class="log-window">
            <div class="log-entry text-slate-400" data-category="system">[SYSTEM] Connecting to local WhatsApp Engine on ws://localhost:8080...</div>
        </div>

        <!-- Floating Jump-to-Latest Button (shown when user scrolls up) -->
        <button id="jumpBottomBtn" onclick="scrollToBottom()" class="hidden absolute bottom-8 right-8 bg-[#00a884] text-[#0b141a] font-semibold text-xs px-3 py-1.5 rounded-full shadow-lg hover:bg-[#00a884]/90 transition">
            &darr; Jump to Latest
        </button>
    </div>

    <script>
        lucide.createIcons();

        const MAX_DOM_ROWS = 500;
        const seenSignatures = new Set();
        let totalMsgCount = 0;
        let currentFilter = 'all';
        let wsConnected = false;
        let activeWs = null;

        const term = document.getElementById('terminalLog');
        const jumpBtn = document.getElementById('jumpBottomBtn');

        function isNearBottom() {
            return term.scrollHeight - term.scrollTop - term.clientHeight < 65;
        }

        function scrollToBottom() {
            term.scrollTop = term.scrollHeight;
            jumpBtn.classList.add('hidden');
        }

        term.addEventListener('scroll', () => {
            if (isNearBottom()) {
                jumpBtn.classList.add('hidden');
            } else {
                jumpBtn.classList.remove('hidden');
            }
        });

        // ID-first deduplication key shared by both WebSocket events and /api/chat-logs
        function buildDedupKey(id, category, peer, text, timeIsoOrNow) {
            if (id) {
                return 'id:' + String(id);
            }
            const normPeer = String(peer || '').trim().toLowerCase();
            const normText = String(text || '').trim();
            const ts = timeIsoOrNow ? new Date(timeIsoOrNow).getTime() : Date.now();
            const bucket = Number.isFinite(ts) ? Math.floor(ts / 5000) : 0;
            return category + '|' + normPeer + '|' + normText + '|' + bucket;
        }

        function logTerminal(msg, typeClass = '', category = 'system', timeStr = null, forceScroll = false) {
            const stickToBottom = forceScroll || isNearBottom();
            const time = timeStr || new Date().toLocaleTimeString();
            const row = document.createElement('div');
            row.className = 'log-entry ' + typeClass;
            row.dataset.category = category;
            row.textContent = '[' + time + '] ' + msg;

            term.appendChild(row);
            while (term.children.length > MAX_DOM_ROWS) {
                term.removeChild(term.firstElementChild);
            }
            applyRowFilter(row);

            totalMsgCount++;
            document.getElementById('msgCountBadge').textContent = totalMsgCount + ' events';

            if (stickToBottom) {
                term.scrollTop = term.scrollHeight;
            } else {
                jumpBtn.classList.remove('hidden');
            }
        }

        function applyRowFilter(row) {
            const q = (document.getElementById('searchInput').value || '').toLowerCase();
            const cat = row.dataset.category || 'system';
            const matchesCat = currentFilter === 'all' || cat === currentFilter;
            const matchesSearch = !q || row.textContent.toLowerCase().includes(q);
            row.style.display = (matchesCat && matchesSearch) ? '' : 'none';
        }

        function applyFilters() {
            Array.from(term.children).forEach(applyRowFilter);
        }

        function setFilter(filter) {
            currentFilter = filter;
            ['all', 'incoming', 'outgoing'].forEach(f => {
                const btn = document.getElementById('filter-' + f);
                if (f === filter) {
                    btn.classList.add('active');
                } else {
                    btn.classList.remove('active');
                }
            });
            applyFilters();
        }

        function clearTerminal() {
            term.innerHTML = '';
            seenSignatures.clear();
            totalMsgCount = 0;
            document.getElementById('msgCountBadge').textContent = '0 events';
            logTerminal('[SYSTEM] View cleared. Listening for new messages...', 'text-slate-400', 'system', null, true);
        }

        function updateMetrics(status) {
            const engMain = document.getElementById('enginePrimaryText');
            const engSub = document.getElementById('engineSubText');
            const lisMain = document.getElementById('listenerPrimaryText');
            const lisSub = document.getElementById('listenerSubText');
            const qMain = document.getElementById('queuePrimaryText');
            const qSub = document.getElementById('queueSubText');
            const qrBanner = document.getElementById('qrBanner');
            const qrImage = document.getElementById('qrImage');

            if (!status) {
                engMain.textContent = 'Engine Offline';
                engSub.textContent = 'Run: node engine.js';
                engSub.className = 'text-[11px] text-[#f15c6d] font-mono mt-0.5';
                qrBanner.classList.add('hidden');
                return;
            }

            if (status.qrPending) {
                engMain.textContent = 'QR Scan Required';
                engSub.textContent = 'Awaiting device link';
                engSub.className = 'text-[11px] text-amber-400 font-mono mt-0.5';
                qrBanner.classList.remove('hidden');
                qrImage.src = '/api/qr?t=' + Date.now();
            } else if (status.ready) {
                engMain.textContent = 'WebSocket (Port 8080)';
                engSub.textContent = 'LocalAuth Session Active';
                engSub.className = 'text-[11px] text-[#00a884] font-mono mt-0.5';
                qrBanner.classList.add('hidden');
            } else {
                engMain.textContent = 'Booting Puppeteer...';
                engSub.textContent = 'Authenticating session';
                engSub.className = 'text-[11px] text-amber-400 font-mono mt-0.5';
                qrBanner.classList.add('hidden');
            }

            const listeners = Array.isArray(status.activeListeners) ? status.activeListeners : [];
            lisMain.textContent = listeners.length === 1
                ? '1 Active Earpiece'
                : listeners.length + ' Active Earpieces';

            if (listeners.length > 0) {
                const filters = listeners.map(l => {
                    const parts = [];
                    if (l.keyword) parts.push('kw:' + l.keyword);
                    if (l.chat) parts.push('chat:' + l.chat);
                    return parts.length ? parts.join(', ') : 'all messages';
                });
                lisSub.textContent = 'Filter: ' + filters.join(' | ');
                lisSub.className = 'text-[11px] text-[#53bdeb] font-mono mt-0.5';
            } else {
                lisSub.textContent = 'Idle (Messages buffered in queue)';
                lisSub.className = 'text-[11px] text-[#8696a0] font-mono mt-0.5';
            }

            const qCount = status.queuedMessages || 0;
            qMain.textContent = qCount + (qCount === 1 ? ' Queued Message' : ' Queued Messages');
            qSub.textContent = qCount > 0 ? 'Waiting for listener ACK' : 'Zero unacknowledged messages';
            qSub.className = qCount > 0
                ? 'text-[11px] text-amber-400 font-mono mt-0.5'
                : 'text-[11px] text-slate-400 font-mono mt-0.5';
        }

        function connectWs() {
            const badge = document.getElementById('wsStatusBadge');
            try {
                const ws = new WebSocket('ws://' + window.location.hostname + ':8080');
                activeWs = ws;

                ws.onopen = () => {
                    wsConnected = true;
                    ws.send(JSON.stringify({ action: 'register_monitor' }));
                    ws.send(JSON.stringify({ action: 'status', requestId: 'dash_init' }));
                    badge.className = "px-3 py-1 bg-[#00a884]/20 text-[#00a884] rounded-full border border-[#00a884]/40 flex items-center gap-2 text-xs font-semibold";
                    badge.innerHTML = '<div class="w-2 h-2 bg-[#00a884] rounded-full animate-pulse"></div>WS: CONNECTED';
                };

                ws.onmessage = (event) => {
                    try {
                        const data = JSON.parse(event.data);
                        if (data.type === 'status_response') {
                            updateMetrics(data);
                            return;
                        }

                        if (data.type === 'incoming_message') {
                            const sender = data.senderName || data.from;
                            const text = data.body || '(Media packet)';
                            const sig = buildDedupKey(data.id, 'incoming', sender, text, new Date().toISOString());
                            if (seenSignatures.has(sig)) return;
                            seenSignatures.add(sig);
                            logTerminal('[INCOMING] From ' + sender + ': ' + text, 'log-info', 'incoming');
                        } else if (data.type === 'outgoing_message') {
                            const text = data.body || '';
                            const sig = buildDedupKey(data.id, 'outgoing', data.to, text, new Date().toISOString());
                            if (seenSignatures.has(sig)) return;
                            seenSignatures.add(sig);
                            logTerminal('[OUTGOING] To ' + data.to + ': ' + text, 'log-success', 'outgoing');
                        }
                    } catch (e) {}
                };

                ws.onclose = () => {
                    wsConnected = false;
                    updateMetrics(null);
                    badge.className = "px-3 py-1 bg-amber-500/20 text-amber-400 rounded-full border border-amber-500/40 flex items-center gap-2 text-xs font-semibold";
                    badge.innerHTML = '<div class="w-2 h-2 bg-amber-400 rounded-full animate-ping"></div>WS: RECONNECTING';
                    setTimeout(connectWs, 3000);
                };

                ws.onerror = () => {
                    ws.close();
                };
            } catch (e) {
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

                        const peer = log.from || log.to || '';
                        const displayText = text || '(Media / Sync packet)';
                        const sig = buildDedupKey(log.id, log.type, peer, displayText, log.time);
                        if (seenSignatures.has(sig)) return;
                        seenSignatures.add(sig);

                        const timeStr = log.time ? new Date(log.time).toLocaleTimeString() : null;
                        if (log.type === 'incoming') {
                            logTerminal('[INCOMING] From ' + peer + ': ' + displayText, 'log-info', 'incoming', timeStr, forceScroll);
                        } else if (log.type === 'outgoing') {
                            logTerminal('[OUTGOING] To ' + peer + ': ' + text, 'log-success', 'outgoing', timeStr, forceScroll);
                        } else if (log.type === 'system') {
                            logTerminal('[SYSTEM] ' + text, 'text-yellow-400', 'system', timeStr, forceScroll);
                        }
                    });
                })
                .catch(err => console.error('Fetch error:', err));
        }

        connectWs();
        loadLogs(true);

        // Poll engine status over WS every 2s; only fallback-poll /api/chat-logs if WS is disconnected
        setInterval(() => {
            if (wsConnected && activeWs && activeWs.readyState === WebSocket.OPEN) {
                activeWs.send(JSON.stringify({ action: 'status', requestId: 'dash_poll' }));
            } else {
                loadLogs(false);
            }
        }, 2000);
    </script>
</body>
</html>`);
});

app.listen(PORT, () => {
    console.log("WhatsApp Engine Dashboard running at http://localhost:" + PORT);
});

const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const QRCode = require('qrcode-terminal/vendor/QRCode');
const QRErrorCorrectLevel = require('qrcode-terminal/vendor/QRCode/QRErrorCorrectLevel');
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { ROOT_DIR, readChatLogs, appendToChatLogs } = require('./utils/logger');
const { readLocalBridgeAuth, fetchGitHubUser } = require('./utils/auth');

const PORT = Number(process.env.WHATSAPP_ENGINE_PORT || 8080);
const BRIDGE_TOKEN = process.env.WHATSAPP_BRIDGE_TOKEN || '';
const MEDIA_DIR = path.join(ROOT_DIR, 'media');
const AUTH_DIR = path.join(ROOT_DIR, '.wwebjs_auth');
const QR_HTML_PATH = path.join(ROOT_DIR, 'WhatsApp_QR.html');
const QR_PNG_PATH = path.join(MEDIA_DIR, 'whatsapp_qr.png');
const HEARTBEAT_INTERVAL_MS = 30000;

if (!fs.existsSync(MEDIA_DIR)) {
    fs.mkdirSync(MEDIA_DIR, { recursive: true });
}

function clearStaleBrowserLocks(dirPath) {
    try {
        if (!fs.existsSync(dirPath)) return;
        const lockNames = new Set(['SingletonLock', 'SingletonCookie', 'SingletonSocket']);
        const entries = fs.readdirSync(dirPath, { withFileTypes: true });
        for (const entry of entries) {
            const fullPath = path.join(dirPath, entry.name);
            if (lockNames.has(entry.name)) {
                try {
                    fs.unlinkSync(fullPath);
                    console.log(`[Engine] Removed stale Chromium lock: ${fullPath}`);
                } catch (e) {}
            } else if (entry.isDirectory()) {
                clearStaleBrowserLocks(fullPath);
            }
        }
    } catch (e) {}
}
clearStaleBrowserLocks(AUTH_DIR);

function crc32(buf) {
    let c = 0xffffffff;
    for (let i = 0; i < buf.length; i++) {
        c ^= buf[i];
        for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (c & 1 ? 0xedb88320 : 0);
    }
    return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
    const out = Buffer.alloc(12 + data.length);
    out.writeUInt32BE(data.length, 0);
    out.write(type, 4, 4, 'ascii');
    data.copy(out, 8);
    out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
    return out;
}

function buildQrOutputs(text) {
    const model = new QRCode(-1, QRErrorCorrectLevel.L);
    model.addData(text);
    model.make();
    const n = model.getModuleCount();
    const quiet = 4;
    const total = n + quiet * 2;

    const rects = [];
    for (let r = 0; r < n; r++) {
        for (let c = 0; c < n; c++) {
            if (model.isDark(r, c)) rects.push(`<rect x="${c + quiet}" y="${r + quiet}" width="1" height="1"/>`);
        }
    }
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${total} ${total}" width="320" height="320" shape-rendering="crispEdges"><rect width="100%" height="100%" fill="#fff"/><g fill="#000">${rects.join('')}</g></svg>`;

    const scale = 8;
    const size = total * scale;
    const raw = Buffer.alloc(size * (size + 1));
    for (let py = 0; py < size; py++) {
        const rowOff = py * (size + 1);
        raw[rowOff] = 0;
        const mr = Math.floor(py / scale) - quiet;
        for (let px = 0; px < size; px++) {
            const mc = Math.floor(px / scale) - quiet;
            const dark = mr >= 0 && mr < n && mc >= 0 && mc < n && model.isDark(mr, mc);
            raw[rowOff + 1 + px] = dark ? 0 : 255;
        }
    }
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(size, 0);
    ihdr.writeUInt32BE(size, 4);
    ihdr[8] = 8;
    const png = Buffer.concat([
        Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
        pngChunk('IHDR', ihdr),
        pngChunk('IDAT', zlib.deflateSync(raw)),
        pngChunk('IEND', Buffer.alloc(0))
    ]);
    return { svg, png };
}

const puppeteerConfig = {
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox']
};
if (process.env.PUPPETEER_EXECUTABLE_PATH) {
    puppeteerConfig.executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;
}

const client = new Client({
    authStrategy: new LocalAuth({ dataPath: AUTH_DIR }),
    authTimeoutMs: 0,
    puppeteer: puppeteerConfig
});

let isReady = false;
let qrPending = false;
const clients = new Set();
const httpPollers = new Set();
const messageQueue = [];
const MAX_QUEUE_SIZE = 100;

function matchesFilter(msg, meta) {
    if (!meta) return true;
    // Prevent local listener from stealing messages addressed strictly to cloud agent, and vice-versa
    if (msg.isAgentMessage && msg.toAgent && msg.toAgent !== 'all' && meta.agentRole) {
        if (msg.toAgent !== meta.agentRole) {
            return false;
        }
    }
    if (meta.keyword && !(msg.body || '').toLowerCase().includes(meta.keyword)) {
        return false;
    }
    if (meta.chat) {
        const sender = (msg.senderName || '').toLowerCase();
        const chatName = (msg.chatName || '').toLowerCase();
        const from = (msg.from || '').toLowerCase();
        if (!sender.includes(meta.chat) && !chatName.includes(meta.chat) && !from.includes(meta.chat)) {
            return false;
        }
    }
    return true;
}

function flushQueueForListener(ws) {
    if (!ws || ws.readyState !== WebSocket.OPEN || !ws.clientMeta || ws.clientMeta.role !== 'listener') {
        return;
    }
    for (const msg of messageQueue) {
        if (matchesFilter(msg, ws.clientMeta)) {
            ws.send(JSON.stringify(msg));
            break;
        }
    }
}

// Shared action executor used by BOTH WebSocket and HTTP POST /api/rpc
async function executeAction(parsed) {
    if (parsed.action === 'ack_message') {
        const idx = messageQueue.findIndex(m => m.id === parsed.id);
        if (idx !== -1) {
            messageQueue.splice(idx, 1);
        }
        return { type: 'ack_response', id: parsed.id, ok: true };
    }

    if (parsed.action === 'agent_message') {
        const fromAgent = String(parsed.fromAgent || 'cloud').toLowerCase();
        const toAgent = String(parsed.toAgent || 'local').toLowerCase();
        const text = String(parsed.text || '');
        const msgId = `agent_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;

        console.log(`[Engine Intercom] ${fromAgent.toUpperCase()} AGENT -> ${toAgent.toUpperCase()} AGENT: ${text}`);

        appendToChatLogs({
            id: msgId,
            type: 'agent',
            from: `${fromAgent.toUpperCase()} AGENT`,
            to: `${toAgent.toUpperCase()} AGENT`,
            text,
            time: new Date().toISOString()
        });

        const payload = {
            type: 'incoming_message',
            isAgentMessage: true,
            id: msgId,
            from: `agent:${fromAgent}@intercom`,
            senderName: `${fromAgent.toUpperCase()} AGENT`,
            chatName: `Agent Intercom (${fromAgent} -> ${toAgent})`,
            fromAgent,
            toAgent,
            body: text,
            isGroup: false,
            timestamp: Math.floor(Date.now() / 1000),
            media: null
        };

        messageQueue.push(payload);
        if (messageQueue.length > MAX_QUEUE_SIZE) {
            messageQueue.shift();
        }

        // 1. Broadcast to WebSocket monitors & matching local listeners
        clients.forEach(ws => {
            if (ws.readyState !== WebSocket.OPEN) return;
            const role = ws.clientMeta?.role || 'legacy';
            if (role === 'monitor') {
                ws.send(JSON.stringify(payload));
            } else if (role === 'listener') {
                if (matchesFilter(payload, ws.clientMeta)) {
                    ws.send(JSON.stringify(payload));
                }
            }
        });

        // 2. Wake up matching HTTP Long-Polling listeners (/api/poll)
        for (const poller of Array.from(httpPollers)) {
            if (matchesFilter(payload, poller.meta)) {
                clearTimeout(poller.timer);
                httpPollers.delete(poller);
                if (!poller.res.headersSent) {
                    poller.res.json({ ok: true, message: payload });
                }
            }
        }

        return { type: 'agent_response', requestId: parsed.requestId, id: msgId, ok: true };
    }

    if (parsed.action === 'status') {
        const activeListeners = [];
        clients.forEach(c => {
            if (c.readyState === WebSocket.OPEN && c.clientMeta?.role === 'listener') {
                activeListeners.push({
                    transport: 'ws',
                    keyword: c.clientMeta.keyword || null,
                    chat: c.clientMeta.chat || null
                });
            }
        });
        httpPollers.forEach(p => {
            activeListeners.push({
                transport: 'http_poll',
                keyword: p.meta.keyword || null,
                chat: p.meta.chat || null
            });
        });
        return {
            type: 'status_response',
            requestId: parsed.requestId,
            ready: isReady,
            qrPending,
            queuedMessages: messageQueue.length,
            connectedClients: clients.size + httpPollers.size,
            activeListeners
        };
    }

    if (parsed.action === 'send_message') {
        const { to, text, mediaPath, mediaBase64, mediaMimetype, mediaFilename, quotedMessageId, mentions, requestId } = parsed;
        console.log(`[Engine] Requested to send message to "${to}"`);

        const options = {};
        if (quotedMessageId) options.quotedMessageId = quotedMessageId;
        if (mentions) options.mentions = mentions;

        let contentToSend = text;
        if (mediaBase64 && mediaMimetype) {
            contentToSend = new MessageMedia(mediaMimetype, mediaBase64, mediaFilename || 'attachment');
            if (text) options.caption = text;
        } else if (mediaPath) {
            try {
                contentToSend = MessageMedia.fromFilePath(mediaPath);
                if (text) options.caption = text;
            } catch (err) {
                console.error(`[Engine] Failed to load media at ${mediaPath}:`, err);
            }
        }

        if (!to) {
            return { type: 'send_response', requestId, ok: false, error: 'Missing recipient' };
        }

        if (!isReady) {
            return { type: 'send_response', requestId, ok: false, error: 'Engine not ready' };
        }

        if (to.includes('@c.us') || to.includes('@g.us') || to.includes('@lid')) {
            try {
                let chat = null;
                try {
                    chat = await client.getChatById(to);
                } catch (err) {
                    const chats = await client.getChats();
                    chat = chats.find(c => (c.id._serialized || c.id.$1) === to || c.id.user === to);
                }
                if (chat) {
                    await chat.sendMessage(contentToSend, options);
                    console.log(`[Engine] Message sent successfully to ID ${to} via chat object!`);
                    try { await chat.clearState(); } catch (err) {}
                } else {
                    await client.sendMessage(to, contentToSend, options);
                    console.log(`[Engine] Message sent successfully to ID ${to} via client!`);
                }
                return { type: 'send_response', requestId, ok: true };
            } catch (e) {
                console.error(`[Engine] Error sending to ${to}:`, e);
                return { type: 'send_response', requestId, ok: false, error: e.message };
            }
        }

        const chats = await client.getChats();
        const targetChat = chats.find(c =>
            c.name === to ||
            (c.name && c.name.toLowerCase() === to.toLowerCase()) ||
            c.id.user === to ||
            (c.id._serialized || c.id.$1) === to
        );

        if (targetChat) {
            await targetChat.sendMessage(contentToSend, options);
            console.log(`[Engine] Message sent successfully to ${to}!`);
            return { type: 'send_response', requestId, ok: true };
        } else {
            return { type: 'send_response', requestId, ok: false, error: `Chat not found: ${to}` };
        }
    }

    if (parsed.action === 'list_chats') {
        if (!isReady) {
            return { type: 'list_response', requestId: parsed.requestId, error: 'Not ready' };
        }
        const query = (parsed.query || '').toLowerCase();
        const groupsOnly = !!parsed.groupsOnly;
        const chats = await client.getChats();
        const filtered = chats
            .filter(c => (!groupsOnly || c.isGroup) && (!query || (c.name || '').toLowerCase().includes(query)))
            .map(c => ({
                id: c.id._serialized,
                name: c.name,
                isGroup: c.isGroup,
                archived: c.archived,
                timestamp: c.timestamp
            }));
        return { type: 'list_response', requestId: parsed.requestId, totalChats: chats.length, chats: filtered };
    }

    if (parsed.action === 'ui_search_chat') {
        if (!isReady || !client.pupPage) {
            return { type: 'ui_search_response', requestId: parsed.requestId, error: 'Not ready' };
        }
        const query = parsed.query || 'Gamla';
        const targetTitle = parsed.targetTitle || 'Gamla Discussions';
        const page = client.pupPage;

        const storeMatches = await page.evaluate((q) => {
            try {
                const col = window.require('WAWebCollections').Chat;
                const arr = col.getModelsArray ? col.getModelsArray() : [];
                return arr
                    .filter(c => {
                        const hay = `${c.name || ''} ${c.formattedTitle || ''} ${c.contact?.name || ''} ${c.contact?.pushname || ''}`.toLowerCase();
                        return hay.includes(q.toLowerCase());
                    })
                    .map(c => ({
                        id: c.id?._serialized || String(c.id),
                        name: c.name || c.formattedTitle,
                        isGroup: !!c.isGroup,
                        isParentGroup: !!c.groupMetadata?.isParentGroup,
                        msgsCount: c.msgs?.length || 0
                    }));
            } catch (e) {
                return [{ error: e.message }];
            }
        }, query);

        let domResult = { clicked: null, visibleItems: [], messages: [], searchError: null };
        try {
            const searchSelector = 'div[contenteditable="true"][data-tab="3"], div[role="textbox"][aria-label*="Search"], div[contenteditable="true"]';
            await page.waitForSelector(searchSelector, { timeout: 4000 });
            const searchBox = await page.$(searchSelector);
            await searchBox.click({ clickCount: 3 });
            await page.keyboard.press('Backspace');
            await page.keyboard.type(query, { delay: 30 });
            await new Promise(r => setTimeout(r, 2000));

            const items = await page.evaluate((target) => {
                const spans = Array.from(document.querySelectorAll('#pane-side span[title]'));
                const titles = [...new Set(spans.map(s => s.getAttribute('title')).filter(Boolean))];
                const match = spans.find(s => (s.getAttribute('title') || '').toLowerCase().includes(target.toLowerCase()))
                    || spans.find(s => (s.getAttribute('title') || '').toLowerCase().includes('discussion'))
                    || spans.find(s => (s.getAttribute('title') || '').toLowerCase().includes('gamla'));
                if (match) {
                    match.click();
                    return { titles, clicked: match.getAttribute('title') };
                }
                return { titles, clicked: null };
            }, targetTitle);

            domResult.visibleItems = items.titles;
            domResult.clicked = items.clicked;

            if (items.clicked) {
                await new Promise(r => setTimeout(r, 2500));
                await page.evaluate(() => {
                    const main = document.querySelector('#main div[data-testid="conversation-panel-messages"], #main div.copyable-area > div');
                    if (main) main.scrollTop = Math.max(0, main.scrollTop - 1500);
                });
                await new Promise(r => setTimeout(r, 1500));

                domResult.messages = await page.evaluate(() => {
                    const rows = Array.from(document.querySelectorAll('#main div[data-id]'));
                    return rows.slice(-60).map(row => {
                        const pre = row.querySelector('[data-pre-plain-text]');
                        const meta = pre ? pre.getAttribute('data-pre-plain-text') : '';
                        const textEl = row.querySelector('span.selectable-text, span._ao3e');
                        const text = textEl ? textEl.innerText : (row.innerText || '').trim();
                        return {
                            dataId: row.getAttribute('data-id'),
                            meta,
                            text
                        };
                    }).filter(m => m.text || m.meta);
                });
            }
        } catch (e) {
            domResult.searchError = e.message;
        }

        return { type: 'ui_search_response', requestId: parsed.requestId, storeMatches, domResult };
    }

    if (parsed.action === 'fetch_history') {
        if (!isReady) {
            return { type: 'history_response', requestId: parsed.requestId, error: 'WhatsApp client is not ready yet' };
        }
        const query = (parsed.query || '').toLowerCase();
        const limit = parsed.limit || 50;
        const chats = await client.getChats();
        const matches = query
            ? chats.filter(c => (c.name || '').toLowerCase().includes(query) || (c.id._serialized || '').toLowerCase() === query)
            : chats.slice(0, 20);

        const contactCache = new Map();
        const results = [];
        for (const chat of matches) {
            const msgs = await chat.fetchMessages({ limit });
            const formatted = [];
            for (const m of msgs) {
                const authorKey = m.author || m.from;
                let sender = m.fromMe ? 'Me (Chetan)' : authorKey;
                if (!m.fromMe && authorKey) {
                    if (contactCache.has(authorKey)) {
                        sender = contactCache.get(authorKey);
                    } else {
                        try {
                            const c = await m.getContact();
                            sender = c.name || c.pushname || c.number || authorKey;
                            contactCache.set(authorKey, sender);
                        } catch (err) {}
                    }
                }
                formatted.push({
                    id: m.id._serialized,
                    fromMe: m.fromMe,
                    sender,
                    type: m.type,
                    body: m.body,
                    hasMedia: m.hasMedia,
                    timestamp: m.timestamp,
                    timeIST: new Date(m.timestamp * 1000).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })
                });
            }
            results.push({
                id: chat.id._serialized,
                name: chat.name,
                isGroup: chat.isGroup,
                unreadCount: chat.unreadCount,
                messages: formatted
            });
        }
        return { type: 'history_response', requestId: parsed.requestId, chats: results };
    }

    if (parsed.action === 'fetch_media') {
        if (!isReady) {
            return { type: 'media_response', error: 'WhatsApp client is not ready yet' };
        }
        try {
            let msg = null;
            try {
                msg = await client.getMessageById(parsed.messageId);
            } catch (e) {}
            if (!msg && parsed.messageId) {
                const parts = String(parsed.messageId).split('_');
                const chatId = parts.length >= 3 ? parts[1] : null;
                if (chatId) {
                    let chat = null;
                    try {
                        chat = await client.getChatById(chatId);
                    } catch (err) {
                        const chats = await client.getChats();
                        chat = chats.find(c => (c.id._serialized || c.id.$1) === chatId);
                    }
                    if (chat) {
                        const msgs = await chat.fetchMessages({ limit: 80 });
                        msg = msgs.find(m => m.id._serialized === parsed.messageId);
                    }
                }
            }
            if (msg && msg.hasMedia) {
                let media = null;
                try {
                    media = await msg.downloadMedia();
                } catch (dlErr) {
                    console.warn(`[Engine] Primary msg.downloadMedia() failed (${dlErr.message}), attempting pupPage mediaData blob fallback...`);
                }
                if (!media && client.pupPage) {
                    media = await client.pupPage.evaluate(async (msgId) => {
                        const m =
                            window.require('WAWebCollections').Msg.get(msgId) ||
                            (await window.require('WAWebCollections').Msg.getMessagesById([msgId]))?.messages?.[0];
                        if (!m) return null;

                        try {
                            if (!m.mediaData || m.mediaData.mediaStage !== 'RESOLVED') {
                                await m.downloadMedia({ downloadEvenIfExpensive: true, rmrReason: 1 });
                            }
                        } catch (e) {}

                        // Fallback 1: Read directly from WhatsApp Web's resolved OpaqueData (mediaBlob)
                        const mediaBlob = m.mediaData && m.mediaData.mediaBlob;
                        if (mediaBlob) {
                            const blob = typeof mediaBlob.forceToBlob === 'function'
                                ? mediaBlob.forceToBlob()
                                : (mediaBlob._blob || (typeof mediaBlob.url === 'function' ? await fetch(mediaBlob.url()).then(r => r.blob()) : null));
                            if (blob) {
                                const buf = await blob.arrayBuffer();
                                const data = await window.WWebJS.arrayBufferToBase64Async(buf);
                                return {
                                    data,
                                    mimetype: m.mimetype || blob.type || 'image/jpeg',
                                    filename: m.filename || null,
                                    filesize: m.size || blob.size || null
                                };
                            }
                        }

                        // Fallback 2: Try downloadAndDecrypt / downloadAndMaybeDecrypt with full mock QPL
                        try {
                            const dlMgr = window.require('WAWebDownloadManager').downloadManager;
                            const mockQpl = new Proxy({}, {
                                get: (target, prop) => () => mockQpl
                            });
                            const fn = dlMgr.downloadAndMaybeDecrypt || dlMgr.downloadAndDecrypt;
                            if (fn) {
                                const decryptedMedia = await fn.call(dlMgr, {
                                    directPath: m.directPath,
                                    encFilehash: m.encFilehash,
                                    filehash: m.filehash,
                                    mediaKey: m.mediaKey,
                                    mediaKeyTimestamp: m.mediaKeyTimestamp,
                                    type: m.type,
                                    signal: new AbortController().signal,
                                    downloadQpl: mockQpl
                                });
                                const data = await window.WWebJS.arrayBufferToBase64Async(decryptedMedia);
                                return {
                                    data,
                                    mimetype: m.mimetype || 'image/jpeg',
                                    filename: m.filename || null,
                                    filesize: m.size || null
                                };
                            }
                        } catch (e2) {}

                        // Fallback 3: Base64 preview thumbnail from msg.body if full blob unavailable
                        if (m.type === 'image' && m.body && m.body.length > 100) {
                            return {
                                data: m.body,
                                mimetype: m.mimetype || 'image/jpeg',
                                filename: m.filename || 'thumbnail.jpg',
                                filesize: m.body.length
                            };
                        }
                        return null;
                    }, parsed.messageId);
                }
                if (media && media.data) {
                    return { type: 'media_response', messageId: parsed.messageId, media };
                } else {
                    return { type: 'media_response', messageId: parsed.messageId, error: 'Media could not be decrypted or resolved' };
                }
            } else {
                return { type: 'media_response', messageId: parsed.messageId, error: 'Media not found on message' };
            }
        } catch (err) {
            return { type: 'media_response', messageId: parsed.messageId, error: err.message };
        }
    }

    return { type: 'error_response', error: `Unknown action: ${parsed.action}` };
}

// Express HTTP Server + WebSocket Server sharing Port 8080
const app = express();
app.use(express.json({ limit: '50mb' }));

const verifiedGithubTokenCache = new Map();

// Strict privacy authentication middleware for remote / tunneled requests
async function checkBridgeAuth(req, res, next) {
    const isProxied = !!(req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for']);
    const remoteIp = req.socket?.remoteAddress || '';
    const isLocalLoopback = !isProxied && (remoteIp === '127.0.0.1' || remoteIp === '::1' || remoteIp === '::ffff:127.0.0.1');

    if (isLocalLoopback && !BRIDGE_TOKEN) {
        return next();
    }

    const authHeader = req.headers.authorization || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
    if (!token) {
        return res.status(401).json({ error: 'Unauthorized: Private WhatsApp Bridge requires Bearer token' });
    }

    const localAuth = readLocalBridgeAuth();
    const expectedToken = BRIDGE_TOKEN || (localAuth && localAuth.bridgeToken);

    if (expectedToken && token === expectedToken) {
        return next();
    }

    // Also allow if the caller presents a valid GitHub token belonging to the bridge owner
    const expectedOwner = localAuth && localAuth.owner;
    if (expectedOwner) {
        if (verifiedGithubTokenCache.get(token) === expectedOwner.toLowerCase()) {
            return next();
        }
        const ghUser = await fetchGitHubUser(token);
        if (ghUser && ghUser.login && ghUser.login.toLowerCase() === expectedOwner.toLowerCase()) {
            verifiedGithubTokenCache.set(token, expectedOwner.toLowerCase());
            return next();
        }
    }

    return res.status(401).json({ error: 'Unauthorized: Invalid WhatsApp Bridge credentials' });
}

app.get('/api/health', (req, res) => {
    res.json({ ok: true, ready: isReady, qrPending });
});

// Local-only monitor routes on Port 8080 (blocked over public tunnel)
function requireLocalLoopback(req, res, next) {
    const isProxied = !!(req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for']);
    const remoteIp = req.socket?.remoteAddress || '';
    const isLocalLoopback = !isProxied && (remoteIp === '127.0.0.1' || remoteIp === '::1' || remoteIp === '::ffff:127.0.0.1');
    if (!isLocalLoopback) {
        return res.status(403).send('Forbidden: Dashboard UI is restricted to localhost.');
    }
    next();
}

app.get('/api/qr', requireLocalLoopback, (req, res) => {
    if (fs.existsSync(QR_PNG_PATH)) {
        res.setHeader('Cache-Control', 'no-store');
        res.sendFile(QR_PNG_PATH);
    } else {
        res.status(404).json({ error: 'No QR code pending' });
    }
});

app.get('/api/chat-logs', requireLocalLoopback, (req, res) => {
    res.json(readChatLogs());
});

app.get('/', requireLocalLoopback, (req, res) => {
    const dashFile = fs.readFileSync(path.join(__dirname, 'dashboard.js'), 'utf8');
    const match = dashFile.match(/res\.send\(`([\s\S]*?)`\);/);
    if (match) {
        res.send(match[1]);
    } else {
        res.send('WhatsApp Engine Running on Port 8080');
    }
});

// HTTP REST RPC Endpoint (Bypasses Cloud VM WebSocket Proxy Blocks)
app.post('/api/rpc', checkBridgeAuth, async (req, res) => {
    try {
        const responsePayload = await executeAction(req.body || {});
        res.json(responsePayload);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// HTTP Long-Polling Endpoint for `client.js listen` over pure HTTPS
app.get('/api/poll', checkBridgeAuth, (req, res) => {
    const keyword = req.query.keyword ? String(req.query.keyword).toLowerCase() : null;
    const chat = req.query.chat ? String(req.query.chat).toLowerCase() : null;
    const agentRole = req.query.agentRole ? String(req.query.agentRole).toLowerCase() : 'cloud';
    const timeoutMs = Math.min(Number(req.query.timeout || 25000), 30000);
    const meta = { role: 'listener', keyword, chat, agentRole };

    // 1. Check if a matching message is already waiting in messageQueue
    for (const msg of messageQueue) {
        if (matchesFilter(msg, meta)) {
            return res.json({ ok: true, message: msg });
        }
    }

    // 2. Otherwise hold the HTTP request open until a matching message arrives or timeout expires
    const poller = {
        meta,
        res,
        timer: setTimeout(() => {
            httpPollers.delete(poller);
            if (!res.headersSent) {
                res.json({ ok: true, timeout: true, message: null });
            }
        }, timeoutMs)
    };

    httpPollers.add(poller);

    req.on('close', () => {
        clearTimeout(poller.timer);
        httpPollers.delete(poller);
    });
});

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

console.log('[Engine] Starting WhatsApp client...');

client.on('qr', (qr) => {
    qrPending = true;
    console.log('[Engine] QR CODE REQUIRED! Scan this with your WhatsApp app:');
    qrcode.generate(qr, { small: true });

    try {
        const { svg, png } = buildQrOutputs(qr);
        fs.writeFileSync(QR_PNG_PATH, png);

        const html = `<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <title>WhatsApp QR Code</title>
    <meta http-equiv="refresh" content="3">
</head>
<body style="display:flex;justify-content:center;align-items:center;height:100vh;margin:0;background:#111;color:#fff;font-family:system-ui,sans-serif;flex-direction:column;gap:16px;">
    <h2 style="margin:0;">Scan with WhatsApp (Linked Devices)</h2>
    <div style="background:#fff;padding:16px;border-radius:12px;line-height:0;">${svg}</div>
    <p style="margin:0;color:#aaa;font-size:14px;">Auto-refreshes every 3s when a new code is issued (${new Date().toLocaleTimeString()})</p>
</body>
</html>`;
        fs.writeFileSync(QR_HTML_PATH, html);
        console.log('[Engine] QR image saved to:', QR_PNG_PATH);
    } catch (e) {
        console.error('[Engine] Failed to render QR image:', e);
    }
});

client.on('authenticated', () => {
    qrPending = false;
    console.log('[Engine] Authenticated! (Wait for READY)');
});

client.on('auth_failure', msg => {
    qrPending = false;
    console.error('[Engine] AUTHENTICATION FAILURE', msg);
});

client.on('disconnected', (reason) => {
    isReady = false;
    console.log('[Engine] Client was logged out', reason);
});

client.on('error', (error) => {
    console.error('[Engine] ERROR:', error);
});

client.on('ready', () => {
    isReady = true;
    qrPending = false;
    console.log('[Engine] WhatsApp Client is READY and listening for messages!');

    try {
        if (fs.existsSync(QR_HTML_PATH)) fs.unlinkSync(QR_HTML_PATH);
    } catch (e) {}
});

const engineStartTime = Math.floor(Date.now() / 1000) - 60;

client.on('message_create', async (msg) => {
    if (msg.fromMe && msg.timestamp >= engineStartTime) {
        if (msg.to === 'status@broadcast' || msg.from === 'status@broadcast') return;
        try {
            let targetName = msg.to;
            try {
                const chat = await msg.getChat();
                if (chat && chat.name) targetName = chat.name;
            } catch (err) {}

            const msgId = msg.id?._serialized || msg.id?.$1 || `out_${Date.now()}`;
            appendToChatLogs({
                id: msgId,
                type: 'outgoing',
                to: targetName,
                text: msg.body,
                time: new Date().toISOString()
            });
            const payload = {
                type: 'outgoing_message',
                id: msgId,
                to: targetName,
                body: msg.body
            };
            clients.forEach(ws => {
                if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
            });
        } catch (e) {
            console.error('[Engine] Failed to log outgoing message:', e);
        }
    }
});

client.on('message', async (msg) => {
    if (msg.timestamp < engineStartTime) {
        return;
    }
    if (msg.from === 'status@broadcast' || msg.isStatus) {
        return;
    }

    let name = msg._data?.notifyName || msg.author || msg.from;
    let chatName = name;
    let isGroup = String(msg.from || '').endsWith('@g.us');

    try {
        const contact = await msg.getContact();
        if (contact) {
            name = contact.name || contact.pushname || contact.number || name;
        }
    } catch (err) {
        console.warn(`[Engine] Unresolvable @lid contact for ${msg.from}, using fallback name.`);
    }

    try {
        const chat = await msg.getChat();
        if (chat) {
            chatName = chat.name || name;
            isGroup = !!chat.isGroup;
        }
    } catch (err) {
        console.warn(`[Engine] getChat() fallback for ${msg.from}:`, err.message);
    }

    console.log(`[Engine] Received message from ${name}: ${msg.body}`);

    const msgId = msg.id?._serialized || msg.id?.$1 || `msg_${Date.now()}`;

    appendToChatLogs({
        id: msgId,
        type: 'incoming',
        from: name || msg.from,
        text: msg.body,
        time: new Date().toISOString()
    });

    let mediaData = null;
    if (msg.hasMedia) {
        try {
            const media = await msg.downloadMedia();
            if (media) {
                const ext = media.mimetype.split('/')[1].split(';')[0] || 'bin';
                const filename = `temp_${Date.now()}.${ext}`;
                const filePath = path.join(MEDIA_DIR, filename);
                fs.writeFileSync(filePath, media.data, 'base64');
                mediaData = { filename, mimetype: media.mimetype, path: filePath };
            }
        } catch (e) {
            console.error('[Engine] Failed to download media:', e);
        }
    }

    const payload = {
        type: 'incoming_message',
        id: msgId,
        from: msg.from,
        senderName: name,
        chatName,
        body: msg.body || '',
        isGroup,
        timestamp: msg.timestamp,
        media: mediaData
    };

    if (!messageQueue.some(m => m.id === payload.id)) {
        messageQueue.push(payload);
        if (messageQueue.length > MAX_QUEUE_SIZE) {
            messageQueue.shift();
        }
    }

    // 1. Broadcast to WebSocket monitors & matching listeners
    clients.forEach(ws => {
        if (ws.readyState !== WebSocket.OPEN) return;
        const role = ws.clientMeta?.role || 'legacy';
        if (role === 'monitor') {
            ws.send(JSON.stringify(payload));
        } else if (role === 'listener') {
            if (matchesFilter(payload, ws.clientMeta)) {
                ws.send(JSON.stringify(payload));
            }
        } else {
            ws.send(JSON.stringify(payload));
        }
    });

    // 2. Wake up any matching HTTP Long-Polling listeners (/api/poll)
    for (const poller of Array.from(httpPollers)) {
        if (matchesFilter(payload, poller.meta)) {
            clearTimeout(poller.timer);
            httpPollers.delete(poller);
            if (!poller.res.headersSent) {
                poller.res.json({ ok: true, message: payload });
            }
        }
    }
});

wss.on('connection', (ws) => {
    console.log('[Engine] New WebSocket client connected.');
    ws.isAlive = true;
    ws.clientMeta = { role: 'legacy', keyword: null, chat: null };
    clients.add(ws);

    ws.on('pong', () => {
        ws.isAlive = true;
    });

    ws.on('message', async (data) => {
        ws.isAlive = true;
        try {
            const parsed = JSON.parse(data);

            if (parsed.action === 'register_listener') {
                ws.clientMeta = {
                    role: 'listener',
                    agentRole: parsed.agentRole ? String(parsed.agentRole).toLowerCase() : 'local',
                    keyword: parsed.keyword ? String(parsed.keyword).toLowerCase() : null,
                    chat: parsed.chat ? String(parsed.chat).toLowerCase() : null
                };
                flushQueueForListener(ws);
                return;
            }

            if (parsed.action === 'register_monitor') {
                ws.clientMeta = { role: 'monitor' };
                return;
            }

            if (parsed.action === 'ack_message') {
                await executeAction(parsed);
                return;
            }

            if (parsed.action === 'mcp_proxy_request') {
                clients.forEach(c => {
                    if (c !== ws) c.send(JSON.stringify({ type: 'mcp_request', payload: parsed.payload }));
                });
                return;
            }

            if (parsed.action === 'mcp_desktop_response') {
                clients.forEach(c => {
                    if (c !== ws) c.send(JSON.stringify({ type: 'mcp_response', payload: parsed.payload }));
                });
                return;
            }

            const result = await executeAction(parsed);
            if (result && ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify(result));
            }
        } catch (e) {
            console.error('[Engine] WS Message Error:', e);
        }
    });

    ws.on('close', () => {
        console.log('[Engine] Client disconnected.');
        clients.delete(ws);
    });
});

const heartbeatTimer = setInterval(() => {
    clients.forEach(ws => {
        if (ws.isAlive === false) {
            clients.delete(ws);
            return ws.terminate();
        }
        ws.isAlive = false;
        try {
            ws.ping();
        } catch (e) {}
    });
}, HEARTBEAT_INTERVAL_MS);

wss.on('close', () => {
    clearInterval(heartbeatTimer);
});

async function gracefulShutdown(signal) {
    console.log(`[Engine] Received ${signal}. Shutting down gracefully...`);
    clearInterval(heartbeatTimer);
    try {
        server.close();
        wss.close();
        await client.destroy();
    } catch (e) {}
    process.exit(0);
}

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

server.listen(PORT, () => {
    console.log(`[Engine] Unified WebSocket + HTTP Bridge Server listening on http://localhost:${PORT} (WS & /api/rpc, /api/poll)`);
});
client.initialize();

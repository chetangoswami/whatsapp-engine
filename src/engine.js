const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const QRCode = require('qrcode-terminal/vendor/QRCode');
const QRErrorCorrectLevel = require('qrcode-terminal/vendor/QRCode/QRErrorCorrectLevel');
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { ROOT_DIR, appendToChatLogs } = require('./utils/logger');

const PORT = Number(process.env.WHATSAPP_ENGINE_PORT || 8080);
const MEDIA_DIR = path.join(ROOT_DIR, 'media');
const QR_HTML_PATH = path.join(ROOT_DIR, 'WhatsApp_QR.html');
const QR_PNG_PATH = path.join(MEDIA_DIR, 'whatsapp_qr.png');

if (!fs.existsSync(MEDIA_DIR)) {
    fs.mkdirSync(MEDIA_DIR, { recursive: true });
}

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

const client = new Client({
    authStrategy: new LocalAuth({ dataPath: path.join(ROOT_DIR, '.wwebjs_auth') }),
    authTimeoutMs: 0,
    puppeteer: {
        headless: 'new',
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    }
});

let isReady = false;
let qrPending = false;
const wss = new WebSocket.Server({ port: PORT });
const clients = new Set();
const messageQueue = [];
const MAX_QUEUE_SIZE = 100;

function matchesFilter(msg, meta) {
    if (!meta) return true;
    if (meta.keyword && !(msg.body || '').toLowerCase().includes(meta.keyword)) {
        return false;
    }
    if (meta.chat) {
        const sender = (msg.senderName || '').toLowerCase();
        const from = (msg.from || '').toLowerCase();
        if (!sender.includes(meta.chat) && !from.includes(meta.chat)) {
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
            break; // Send one at a time; wait for ack_message before removing from queue
        }
    }
}

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
        try {
            const chat = await msg.getChat();
            appendToChatLogs({
                type: 'outgoing',
                to: chat.name || msg.to,
                text: msg.body,
                time: new Date().toISOString()
            });
            const payload = {
                type: 'outgoing_message',
                to: chat.name || msg.to,
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

    const contact = await msg.getContact();
    const chat = await msg.getChat();
    const name = contact.name || contact.pushname || contact.number;

    console.log(`[Engine] Received message from ${name}: ${msg.body}`);

    appendToChatLogs({
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
        id: msg.id._serialized || msg.id.$1 || `msg_${Date.now()}`,
        from: msg.from,
        senderName: name,
        chatName: chat.name || name,
        body: msg.body || '',
        isGroup: chat.isGroup,
        timestamp: msg.timestamp,
        media: mediaData
    };

    // Always broadcast to passive monitors (e.g. dashboard)
    let deliveredToActiveListener = false;
    clients.forEach(ws => {
        if (ws.readyState !== WebSocket.OPEN) return;
        const role = ws.clientMeta?.role || 'legacy';
        if (role === 'monitor') {
            ws.send(JSON.stringify(payload));
        } else if (role === 'listener') {
            if (matchesFilter(payload, ws.clientMeta)) {
                ws.send(JSON.stringify(payload));
                deliveredToActiveListener = true;
            }
        } else {
            ws.send(JSON.stringify(payload));
            deliveredToActiveListener = true;
        }
    });

    if (!deliveredToActiveListener) {
        messageQueue.push(payload);
        if (messageQueue.length > MAX_QUEUE_SIZE) {
            messageQueue.shift();
        }
    }
});

wss.on('connection', (ws) => {
    console.log('[Engine] New WebSocket client connected.');
    ws.clientMeta = { role: 'legacy', keyword: null, chat: null };
    clients.add(ws);

    ws.on('message', async (data) => {
        try {
            const parsed = JSON.parse(data);

            if (parsed.action === 'register_listener') {
                ws.clientMeta = {
                    role: 'listener',
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
                const idx = messageQueue.findIndex(m => m.id === parsed.id);
                if (idx !== -1) {
                    messageQueue.splice(idx, 1);
                }
                return;
            }

            if (parsed.action === 'status') {
                const activeListeners = [];
                clients.forEach(c => {
                    if (c.readyState === WebSocket.OPEN && c.clientMeta?.role === 'listener') {
                        activeListeners.push({
                            keyword: c.clientMeta.keyword || null,
                            chat: c.clientMeta.chat || null
                        });
                    }
                });
                ws.send(JSON.stringify({
                    type: 'status_response',
                    requestId: parsed.requestId,
                    ready: isReady,
                    qrPending,
                    queuedMessages: messageQueue.length,
                    connectedClients: clients.size,
                    activeListeners
                }));
                return;
            }

            if (parsed.action === 'send_message') {
                const { to, text, mediaPath, quotedMessageId, mentions, requestId } = parsed;
                console.log(`[Engine] Requested to send message to "${to}"`);

                const options = {};
                if (quotedMessageId) options.quotedMessageId = quotedMessageId;
                if (mentions) options.mentions = mentions;

                let contentToSend = text;
                if (mediaPath) {
                    try {
                        contentToSend = MessageMedia.fromFilePath(mediaPath);
                        if (text) options.caption = text;
                    } catch (err) {
                        console.error(`[Engine] Failed to load media at ${mediaPath}:`, err);
                    }
                }

                if (!to) {
                    console.error(`[Engine] send_message action received with no 'to' field. Ignoring.`);
                    if (requestId) ws.send(JSON.stringify({ type: 'send_response', requestId, ok: false, error: 'Missing recipient' }));
                    return;
                }

                if (!isReady) {
                    console.log(`[Engine] Cannot send message yet, WhatsApp client is not fully booted!`);
                    if (requestId) ws.send(JSON.stringify({ type: 'send_response', requestId, ok: false, error: 'Engine not ready' }));
                    return;
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
                        if (requestId) ws.send(JSON.stringify({ type: 'send_response', requestId, ok: true }));
                    } catch (e) {
                        console.error(`[Engine] Error sending to ${to}:`, e);
                        if (requestId) ws.send(JSON.stringify({ type: 'send_response', requestId, ok: false, error: e.message }));
                    }
                    return;
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
                    if (requestId) ws.send(JSON.stringify({ type: 'send_response', requestId, ok: true }));
                } else {
                    console.log(`[Engine] Could not find chat matching name: ${to}. Try using the exact ChatID.`);
                    if (requestId) ws.send(JSON.stringify({ type: 'send_response', requestId, ok: false, error: `Chat not found: ${to}` }));
                }
            } else if (parsed.action === 'list_chats') {
                if (!isReady) {
                    ws.send(JSON.stringify({ type: 'list_response', requestId: parsed.requestId, error: 'Not ready' }));
                    return;
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
                ws.send(JSON.stringify({ type: 'list_response', requestId: parsed.requestId, totalChats: chats.length, chats: filtered }));
            } else if (parsed.action === 'ui_search_chat') {
                if (!isReady || !client.pupPage) {
                    ws.send(JSON.stringify({ type: 'ui_search_response', requestId: parsed.requestId, error: 'Not ready' }));
                    return;
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

                ws.send(JSON.stringify({ type: 'ui_search_response', requestId: parsed.requestId, storeMatches, domResult }));
            } else if (parsed.action === 'fetch_history') {
                if (!isReady) {
                    ws.send(JSON.stringify({ type: 'history_response', requestId: parsed.requestId, error: 'WhatsApp client is not ready yet' }));
                    return;
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
                ws.send(JSON.stringify({ type: 'history_response', requestId: parsed.requestId, chats: results }));
            } else if (parsed.action === 'fetch_media') {
                if (!isReady) {
                    ws.send(JSON.stringify({ type: 'media_response', error: 'WhatsApp client is not ready yet' }));
                    return;
                }
                try {
                    const msg = await client.getMessageById(parsed.messageId);
                    if (msg && msg.hasMedia) {
                        const media = await msg.downloadMedia();
                        ws.send(JSON.stringify({ type: 'media_response', messageId: parsed.messageId, media }));
                    } else {
                        ws.send(JSON.stringify({ type: 'media_response', messageId: parsed.messageId, error: 'Media not found on message' }));
                    }
                } catch (err) {
                    ws.send(JSON.stringify({ type: 'media_response', messageId: parsed.messageId, error: err.message }));
                }
            } else if (parsed.action === 'mcp_proxy_request') {
                console.log(`[Engine] Routing MCP Proxy Request to Desktop Earpiece...`);
                clients.forEach(c => {
                    if (c !== ws) c.send(JSON.stringify({ type: 'mcp_request', payload: parsed.payload }));
                });
            } else if (parsed.action === 'mcp_desktop_response') {
                console.log(`[Engine] Routing MCP Desktop Response back to Proxy...`);
                clients.forEach(c => {
                    if (c !== ws) c.send(JSON.stringify({ type: 'mcp_response', payload: parsed.payload }));
                });
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

console.log(`[Engine] WebSocket Server started on ws://localhost:${PORT}`);
client.initialize();

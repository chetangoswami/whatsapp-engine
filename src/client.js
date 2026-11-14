if ((process.env.HTTPS_PROXY || process.env.https_proxy) && !process.env.NODE_USE_ENV_PROXY) {
    const { spawnSync } = require('child_process');
    const res = spawnSync(process.execPath, process.argv.slice(1), {
        stdio: 'inherit',
        env: { ...process.env, NODE_USE_ENV_PROXY: '1' }
    });
    process.exit(res.status ?? 0);
}

const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');
const { appendToChatLogs } = require('./utils/logger');
const { discoverPrivateBridgeConfig, getLocalGitHubToken } = require('./utils/auth');

const command = process.argv[2];

function getFlagValue(flag) {
    const idx = process.argv.indexOf(flag);
    if (idx !== -1 && process.argv.length > idx + 1) {
        return process.argv[idx + 1];
    }
    return null;
}

const EXPLICIT_URL = getFlagValue('--url') || process.env.WHATSAPP_ENGINE_HTTP || process.env.WHATSAPP_ENGINE_WS || '';
let activeBridgeToken = getFlagValue('--token') || process.env.WHATSAPP_BRIDGE_TOKEN || '';

function guessMimeType(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    const map = {
        '.pdf': 'application/pdf',
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.webp': 'image/webp',
        '.gif': 'image/gif',
        '.mp4': 'video/mp4',
        '.mp3': 'audio/mpeg',
        '.txt': 'text/plain',
        '.json': 'application/json'
    };
    return map[ext] || 'application/octet-stream';
}

function buildAuthHeaders() {
    const headers = { 'Content-Type': 'application/json' };
    const token = activeBridgeToken || getLocalGitHubToken() || '';
    if (token) {
        headers['Authorization'] = `Bearer ${token}`;
    }
    return headers;
}

// Check if local engine is reachable on localhost:8080
async function isLocalEngineAlive() {
    try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 1200);
        const res = await fetch('http://localhost:8080/api/health', { signal: controller.signal });
        clearTimeout(timer);
        return res.ok;
    } catch (e) {
        return false;
    }
}

async function resolveTransport() {
    if (EXPLICIT_URL.startsWith('http://') || EXPLICIT_URL.startsWith('https://')) {
        return { mode: 'http', baseUrl: EXPLICIT_URL.replace(/\/+$/, '') };
    }
    if (EXPLICIT_URL.startsWith('ws://') || EXPLICIT_URL.startsWith('wss://')) {
        return { mode: 'ws', wsUrl: EXPLICIT_URL };
    }
    if (await isLocalEngineAlive()) {
        return { mode: 'ws', wsUrl: 'ws://localhost:8080' };
    }
    const discovered = await discoverPrivateBridgeConfig();
    if (discovered && discovered.bridgeUrl) {
        if (!activeBridgeToken && discovered.bridgeToken) {
            activeBridgeToken = discovered.bridgeToken;
        }
        return { mode: 'http', baseUrl: discovered.bridgeUrl };
    }
    return { mode: 'ws', wsUrl: 'ws://localhost:8080' };
}

async function callHttpRpc(baseUrl, payload) {
    const res = await fetch(`${baseUrl}/api/rpc`, {
        method: 'POST',
        headers: buildAuthHeaders(),
        body: JSON.stringify(payload)
    });
    if (!res.ok) {
        const text = await res.text();
        throw new Error(`HTTP ${res.status}: ${text}`);
    }
    return await res.json();
}

function printIncomingMessage(payload) {
    const bodyText = payload.body || '';
    if (payload.isAgentMessage) {
        console.log('\n[AGENT INTERCOM MESSAGE RECEIVED]');
        console.log(`From: ${payload.senderName} (${payload.from})`);
        console.log(`To: ${payload.toAgent || 'all'}`);
        console.log(`[ID: ${payload.id}]`);
        console.log(`\n${bodyText}\n`);
        return;
    }
    console.log('\n[WHATSAPP MESSAGE RECEIVED]');
    console.log(`From: ${payload.senderName}`);
    if (payload.chatName && payload.chatName !== payload.senderName) {
        console.log(`Chat: ${payload.chatName}`);
    }
    console.log(`ChatID: ${payload.from}`);
    if (payload.author && payload.author !== payload.from) {
        console.log(`AuthorID: ${payload.author}`);
    }
    if (payload.mentionedIds && payload.mentionedIds.length > 0) {
        console.log(`Mentions: ${payload.mentionedIds.join(', ')}${payload.isMeMentioned ? ' (Mentioned Me: YES)' : ''}`);
    }
    console.log(`[ID: ${payload.id}]`);
    if (payload.media) {
        console.log(`Media: ${payload.media.path} (${payload.media.mimetype})`);
    }
    console.log(`\n${bodyText}\n`);
}

async function run() {
    if (!command || !['listen', 'send', 'create-group', 'agent-send', 'status', 'history', 'groups', 'ui_search'].includes(command)) {
        console.log('Usage:');
        console.log('  node client.js status [--url "https://..."]');
        console.log('  node client.js listen [--keyword "jarvis"] [--chat "Gamla"] [--mentioned] [--continuous] [--url "https://..."]');
        console.log('  node client.js agent-send "<local|cloud|all>" "<Message>"');
        console.log('  node client.js send "<ChatID_or_Name>" "<Message>" [--replyTo "<MessageID>"] [--media "<AbsolutePath>"] [--mentions "919773530466@c.us,..."]');
        console.log('  node client.js create-group "<GroupTitle>" "<PhoneOrJID1,PhoneOrJID2,...>"');
        console.log('  node client.js history "<ChatNameQuery>" [limit]');
        console.log('  node client.js groups ["<Query>"]');
        console.log('  node client.js ui_search "<Query>" ["<TargetTitle>"]');
        process.exit(1);
    }

    const transport = await resolveTransport();

    // =========================================================================
    // HTTP REST / LONG-POLLING TRANSPORT (Cloud VM & Remote Tunnel Compatible)
    // =========================================================================
    if (transport.mode === 'http') {
        const { baseUrl } = transport;

        if (command === 'listen') {
            const keywordRaw = getFlagValue('--keyword');
            const keyword = keywordRaw ? keywordRaw.toLowerCase() : '';
            const chatRaw = getFlagValue('--chat');
            const chat = chatRaw ? chatRaw.toLowerCase() : '';
            const mentionedOnly = process.argv.includes('--mentioned');
            const continuous = process.argv.includes('--continuous');

            while (true) {
                try {
                    const params = new URLSearchParams({ timeout: '25000', agentRole: 'cloud' });
                    if (keyword) params.set('keyword', keyword);
                    if (chat) params.set('chat', chat);
                    if (mentionedOnly) params.set('mentionedOnly', '1');

                    const res = await fetch(`${baseUrl}/api/poll?${params.toString()}`, {
                        headers: buildAuthHeaders()
                    });
                    if (!res.ok) {
                        throw new Error(`Bridge poll returned HTTP ${res.status}`);
                    }
                    const data = await res.json();
                    if (data && data.message) {
                        // If the message has media and we are on a remote Cloud VM, auto-download it locally
                        if (data.message.media && data.message.id) {
                            try {
                                const mediaRes = await callHttpRpc(baseUrl, {
                                    action: 'fetch_media',
                                    messageId: data.message.id
                                });
                                if (mediaRes && mediaRes.media && mediaRes.media.data) {
                                    const localMediaDir = path.resolve(__dirname, '../media');
                                    if (!fs.existsSync(localMediaDir)) {
                                        fs.mkdirSync(localMediaDir, { recursive: true });
                                    }
                                    const filename = data.message.media.filename || `temp_${Date.now()}.bin`;
                                    const localFilePath = path.join(localMediaDir, filename);
                                    fs.writeFileSync(localFilePath, Buffer.from(mediaRes.media.data, 'base64'));
                                    data.message.media.path = localFilePath;
                                }
                            } catch (e) {}
                        }
                        printIncomingMessage(data.message);
                        await callHttpRpc(baseUrl, { action: 'ack_message', id: data.message.id });
                        if (!continuous) {
                            return;
                        }
                    }
                } catch (err) {
                    console.error('Failed to poll WhatsApp HTTP Bridge:', err.message);
                    process.exitCode = 1;
                    return;
                }
            }
        }

        if (command === 'agent-send') {
            const toAgent = (process.argv[3] || 'local').toLowerCase();
            const text = process.argv[4] || '';
            const fromAgent = getFlagValue('--from') || 'cloud';
            if (!text) {
                console.error('Error: Missing message text for agent-send.');
                process.exitCode = 1;
                return;
            }
            try {
                const res = await callHttpRpc(baseUrl, {
                    action: 'agent_message',
                    requestId: 'ag_' + Date.now(),
                    fromAgent,
                    toAgent,
                    text
                });
                console.log(`Agent Intercom message delivered (${fromAgent} -> ${toAgent}) [ID: ${res.id}]`);
                return;
            } catch (err) {
                console.error('Failed to send Agent Intercom message via Bridge:', err.message);
                process.exitCode = 1;
                return;
            }
        }

        if (command === 'create-group') {
            const title = process.argv[3];
            const participantsRaw = process.argv[4] || '';
            const participants = participantsRaw.split(',').map(s => s.trim()).filter(Boolean);
            if (!title || participants.length === 0) {
                console.error('Error: Usage: node client.js create-group "<GroupTitle>" "<PhoneOrJID1,PhoneOrJID2,...>"');
                process.exitCode = 1;
                return;
            }
            try {
                const res = await callHttpRpc(baseUrl, {
                    action: 'create_group',
                    requestId: 'cgrp_' + Date.now(),
                    title,
                    participants
                });
                console.log(JSON.stringify(res, null, 2));
                return;
            } catch (err) {
                console.error('Failed to create group via Bridge:', err.message);
                process.exitCode = 1;
                return;
            }
        }

        if (command === 'send') {
            const to = process.argv[3];
            const text = process.argv[4] || '';
            const replyTo = getFlagValue('--replyTo');
            const mediaPath = getFlagValue('--media');
            const mentionsRaw = getFlagValue('--mentions');
            const mentions = mentionsRaw ? mentionsRaw.split(',').map(s => s.trim()).filter(Boolean) : undefined;
            const requestId = 'send_' + Date.now();

            if (!to) {
                console.error('Error: Missing recipient ChatID or Name.');
                process.exitCode = 1;
                return;
            }

            const payload = {
                action: 'send_message',
                requestId,
                to,
                text,
                quotedMessageId: replyTo,
                mentions
            };

            if (mediaPath && fs.existsSync(mediaPath)) {
                payload.mediaBase64 = fs.readFileSync(mediaPath).toString('base64');
                payload.mediaMimetype = guessMimeType(mediaPath);
                payload.mediaFilename = path.basename(mediaPath);
            } else if (mediaPath) {
                payload.mediaPath = mediaPath;
            }

            try {
                const res = await callHttpRpc(baseUrl, payload);
                if (!res.ok) {
                    console.error('Send error:', res.error);
                    process.exitCode = 1;
                    return;
                }
                console.log(`Message sent to ${to} (via HTTPS Bridge)`);
                return;
            } catch (err) {
                console.error('Failed to send via WhatsApp HTTP Bridge:', err.message);
                process.exitCode = 1;
                return;
            }
        }

        if (command === 'status') {
            try {
                const res = await callHttpRpc(baseUrl, { action: 'status', requestId: 'stat_' + Date.now() });
                console.log(JSON.stringify({ ...res, bridgeUrl: baseUrl, transport: 'https' }, null, 2));
                return;
            } catch (err) {
                console.error('Bridge offline:', err.message);
                process.exitCode = 1;
                return;
            }
        }

        if (command === 'history') {
            const query = process.argv[3] || '';
            const limit = parseInt(process.argv[4] || '50', 10);
            try {
                const res = await callHttpRpc(baseUrl, { action: 'fetch_history', query, limit, requestId: 'hist_' + Date.now() });
                console.log(JSON.stringify(res, null, 2));
                return;
            } catch (err) {
                console.error('Failed to fetch history via Bridge:', err.message);
                process.exitCode = 1;
                return;
            }
        }

        if (command === 'groups') {
            const query = process.argv[3] || '';
            try {
                const res = await callHttpRpc(baseUrl, { action: 'list_chats', groupsOnly: true, query, requestId: 'grp_' + Date.now() });
                console.log(JSON.stringify(res, null, 2));
                return;
            } catch (err) {
                console.error('Failed to list groups via Bridge:', err.message);
                process.exitCode = 1;
                return;
            }
        }

        if (command === 'ui_search') {
            const query = process.argv[3] || 'Gamla';
            const targetTitle = process.argv[4] || 'Gamla Discussions';
            try {
                const res = await callHttpRpc(baseUrl, { action: 'ui_search_chat', query, targetTitle, requestId: 'ui_' + Date.now() });
                console.log(JSON.stringify(res, null, 2));
                return;
            } catch (err) {
                console.error('Failed UI search via Bridge:', err.message);
                process.exitCode = 1;
                return;
            }
        }
        return;
    }

    // =========================================================================
    // WEBSOCKET TRANSPORT (Default Localhost Mode)
    // =========================================================================
    const WS_URL = transport.wsUrl;

    if (command === 'listen') {
        const keywordRaw = getFlagValue('--keyword');
        const keyword = keywordRaw ? keywordRaw.toLowerCase() : null;
        const chatRaw = getFlagValue('--chat');
        const chat = chatRaw ? chatRaw.toLowerCase() : null;
        const mentionedOnly = process.argv.includes('--mentioned');
        const continuous = process.argv.includes('--continuous');

        const ws = new WebSocket(WS_URL);

        ws.on('open', () => {
            ws.send(JSON.stringify({
                action: 'register_listener',
                agentRole: 'local',
                keyword,
                chat,
                mentionedOnly
            }));
        });

        ws.on('message', (data) => {
            try {
                const payload = JSON.parse(data);
                if (payload.type === 'incoming_message') {
                    if (payload.isAgentMessage && payload.toAgent && payload.toAgent !== 'all' && payload.toAgent !== 'local') {
                        return;
                    }
                    if (mentionedOnly && !payload.isAgentMessage && !payload.isMeMentioned) {
                        return;
                    }
                    const bodyText = payload.body || '';
                    if (keyword && !bodyText.toLowerCase().includes(keyword)) {
                        return;
                    }
                    if (chat) {
                        const sender = (payload.senderName || '').toLowerCase();
                        const from = (payload.from || '').toLowerCase();
                        const chatName = (payload.chatName || '').toLowerCase();
                        if (!sender.includes(chat) && !from.includes(chat) && !chatName.includes(chat)) {
                            return;
                        }
                    }

                    printIncomingMessage(payload);
                    ws.send(JSON.stringify({ action: 'ack_message', id: payload.id }));

                    if (!continuous) {
                        setTimeout(() => {
                            ws.close();
                            process.exit(0);
                        }, 100);
                    }
                }
            } catch (e) {
                console.error('Parse error:', e.message);
            }
        });

        ws.on('error', (err) => {
            console.error('Failed to connect to WhatsApp Engine. Is it running?', err.message);
            process.exit(1);
        });
    } else if (command === 'agent-send') {
        const toAgent = (process.argv[3] || 'cloud').toLowerCase();
        const text = process.argv[4] || '';
        const fromAgent = getFlagValue('--from') || 'local';
        const requestId = 'ag_' + Date.now();

        if (!text) {
            console.error('Error: Missing message text for agent-send.');
            process.exit(1);
        }

        const ws = new WebSocket(WS_URL);
        ws.on('open', () => {
            ws.send(JSON.stringify({
                action: 'agent_message',
                requestId,
                fromAgent,
                toAgent,
                text
            }));
        });

        ws.on('message', (data) => {
            try {
                const payload = JSON.parse(data);
                if (payload.type === 'agent_response' && payload.requestId === requestId) {
                    console.log(`Agent Intercom message delivered (${fromAgent} -> ${toAgent}) [ID: ${payload.id}]`);
                    ws.close();
                    process.exit(0);
                }
            } catch (e) {}
        });

        setTimeout(() => {
            ws.close();
            process.exit(0);
        }, 3000);

        ws.on('error', (err) => {
            console.error('Failed to connect to WhatsApp Engine:', err.message);
            process.exit(1);
        });
    } else if (command === 'create-group') {
        const title = process.argv[3];
        const participantsRaw = process.argv[4] || '';
        const participants = participantsRaw.split(',').map(s => s.trim()).filter(Boolean);
        const requestId = 'cgrp_' + Date.now();

        if (!title || participants.length === 0) {
            console.error('Error: Usage: node client.js create-group "<GroupTitle>" "<PhoneOrJID1,PhoneOrJID2,...>"');
            process.exit(1);
        }

        const ws = new WebSocket(WS_URL);
        ws.on('open', () => {
            ws.send(JSON.stringify({
                action: 'create_group',
                requestId,
                title,
                participants
            }));
        });

        ws.on('message', (data) => {
            try {
                const payload = JSON.parse(data);
                if (payload.type === 'create_group_response' && payload.requestId === requestId) {
                    console.log(JSON.stringify(payload, null, 2));
                    ws.close();
                    process.exit(payload.ok ? 0 : 1);
                }
            } catch (e) {}
        });

        setTimeout(() => {
            ws.close();
            process.exit(1);
        }, 12000);

        ws.on('error', (err) => {
            console.error('Failed to connect to WhatsApp Engine:', err.message);
            process.exit(1);
        });
    } else if (command === 'send') {
        const to = process.argv[3];
        const text = process.argv[4] || '';
        const replyTo = getFlagValue('--replyTo');
        const mediaPath = getFlagValue('--media');
        const mentionsRaw = getFlagValue('--mentions');
        const mentions = mentionsRaw ? mentionsRaw.split(',').map(s => s.trim()).filter(Boolean) : undefined;
        const requestId = 'send_' + Date.now();

        if (!to) {
            console.error('Error: Missing recipient ChatID or Name.');
            process.exit(1);
        }

        const ws = new WebSocket(WS_URL);
        ws.on('open', () => {
            ws.send(JSON.stringify({
                action: 'send_message',
                requestId,
                to,
                text,
                quotedMessageId: replyTo,
                mediaPath,
                mentions
            }));

            appendToChatLogs({ type: 'outgoing', to, text });
        });

        ws.on('message', (data) => {
            try {
                const payload = JSON.parse(data);
                if (payload.type === 'send_response' && payload.requestId === requestId) {
                    if (!payload.ok) {
                        console.error('Send error:', payload.error);
                        ws.close();
                        process.exit(1);
                    }
                    console.log(`Message sent to ${to}`);
                    ws.close();
                    process.exit(0);
                }
            } catch (e) {}
        });

        setTimeout(() => {
            ws.close();
            process.exit(0);
        }, 5000);

        ws.on('error', (err) => {
            console.error('Failed to connect to WhatsApp Engine. Is it running?', err.message);
            process.exit(1);
        });
    } else if (command === 'status') {
        const requestId = 'stat_' + Date.now();
        const ws = new WebSocket(WS_URL);

        ws.on('open', () => {
            ws.send(JSON.stringify({ action: 'status', requestId }));
        });

        ws.on('message', (data) => {
            try {
                const payload = JSON.parse(data);
                if (payload.type === 'status_response' && payload.requestId === requestId) {
                    console.log(JSON.stringify(payload, null, 2));
                    ws.close();
                    process.exit(0);
                }
            } catch (e) {}
        });

        ws.on('error', (err) => {
            console.error('Engine offline:', err.message);
            process.exit(1);
        });
    } else if (command === 'history') {
        const query = process.argv[3] || '';
        const limit = parseInt(process.argv[4] || '50', 10);
        const requestId = 'hist_' + Date.now();
        const ws = new WebSocket(WS_URL);

        ws.on('open', () => {
            ws.send(JSON.stringify({ action: 'fetch_history', query, limit, requestId }));
        });

        ws.on('message', (data) => {
            try {
                const payload = JSON.parse(data);
                if (payload.type === 'history_response' && payload.requestId === requestId) {
                    console.log(JSON.stringify(payload, null, 2));
                    ws.close();
                    process.exit(0);
                }
            } catch (e) {}
        });

        ws.on('error', (err) => {
            console.error('Failed to connect to WhatsApp Engine:', err.message);
            process.exit(1);
        });
    } else if (command === 'groups') {
        const query = process.argv[3] || '';
        const requestId = 'grp_' + Date.now();
        const ws = new WebSocket(WS_URL);

        ws.on('open', () => {
            ws.send(JSON.stringify({ action: 'list_chats', groupsOnly: true, query, requestId }));
        });

        ws.on('message', (data) => {
            try {
                const payload = JSON.parse(data);
                if (payload.type === 'list_response' && payload.requestId === requestId) {
                    console.log(JSON.stringify(payload, null, 2));
                    ws.close();
                    process.exit(0);
                }
            } catch (e) {}
        });

        ws.on('error', (err) => {
            console.error('Failed to connect to WhatsApp Engine:', err.message);
            process.exit(1);
        });
    } else if (command === 'ui_search') {
        const query = process.argv[3] || 'Gamla';
        const targetTitle = process.argv[4] || 'Gamla Discussions';
        const requestId = 'ui_' + Date.now();
        const ws = new WebSocket(WS_URL);

        ws.on('open', () => {
            ws.send(JSON.stringify({ action: 'ui_search_chat', query, targetTitle, requestId }));
        });

        ws.on('message', (data) => {
            try {
                const payload = JSON.parse(data);
                if (payload.type === 'ui_search_response' && payload.requestId === requestId) {
                    console.log(JSON.stringify(payload, null, 2));
                    ws.close();
                    process.exit(0);
                }
            } catch (e) {}
        });

        ws.on('error', (err) => {
            console.error('Failed to connect to WhatsApp Engine:', err.message);
            process.exit(1);
        });
    }
}

run();

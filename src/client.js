const WebSocket = require('ws');
const { appendToChatLogs } = require('./utils/logger');

const WS_URL = process.env.WHATSAPP_ENGINE_WS || 'ws://localhost:8080';
const command = process.argv[2];

function getFlagValue(flag) {
    const idx = process.argv.indexOf(flag);
    if (idx !== -1 && process.argv.length > idx + 1) {
        return process.argv[idx + 1];
    }
    return null;
}

if (command === 'listen') {
    const keywordRaw = getFlagValue('--keyword');
    const keyword = keywordRaw ? keywordRaw.toLowerCase() : null;
    const chatRaw = getFlagValue('--chat');
    const chat = chatRaw ? chatRaw.toLowerCase() : null;
    const continuous = process.argv.includes('--continuous');

    const ws = new WebSocket(WS_URL);

    ws.on('open', () => {
        ws.send(JSON.stringify({
            action: 'register_listener',
            keyword,
            chat
        }));
    });

    ws.on('message', (data) => {
        try {
            const payload = JSON.parse(data);
            if (payload.type === 'incoming_message') {
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

                console.log('\n[WHATSAPP MESSAGE RECEIVED]');
                console.log(`From: ${payload.senderName}`);
                if (payload.chatName && payload.chatName !== payload.senderName) {
                    console.log(`Chat: ${payload.chatName}`);
                }
                console.log(`ChatID: ${payload.from}`);
                console.log(`[ID: ${payload.id}]`);
                if (payload.media) {
                    console.log(`Media: ${payload.media.path} (${payload.media.mimetype})`);
                }
                console.log(`\n${bodyText}\n`);

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
} else if (command === 'send') {
    const to = process.argv[3];
    const text = process.argv[4] || '';
    const replyTo = getFlagValue('--replyTo');
    const mediaPath = getFlagValue('--media');
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
            mediaPath
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
} else {
    console.log('Usage:');
    console.log('  node client.js status');
    console.log('  node client.js listen [--keyword "jarvis"] [--chat "Gamla"] [--continuous]');
    console.log('  node client.js send "<ChatID_or_Name>" "<Message>" [--replyTo "<MessageID>"] [--media "<AbsolutePath>"]');
    console.log('  node client.js history "<ChatNameQuery>" [limit]');
    console.log('  node client.js groups ["<Query>"]');
    console.log('  node client.js ui_search "<Query>" ["<TargetTitle>"]');
    process.exit(1);
}

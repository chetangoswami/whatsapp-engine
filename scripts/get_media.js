const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');
const { discoverPrivateBridgeConfig, getLocalGitHubToken } = require('../src/utils/auth');

const messageId = process.argv[2];
const outputName = process.argv[3] || `media_${Date.now()}`;

if (!messageId) {
    console.error('Usage: node scripts/get_media.js "<MessageID>" [outputFilenameWithoutExt]');
    process.exit(1);
}

const ROOT_DIR = path.resolve(__dirname, '..');
const mediaDir = path.join(ROOT_DIR, 'media');

if (!fs.existsSync(mediaDir)) {
    fs.mkdirSync(mediaDir, { recursive: true });
}

async function run() {
    let localAlive = false;
    try {
        const res = await fetch('http://localhost:8080/api/health');
        localAlive = res.ok;
    } catch (e) {}

    if (!localAlive) {
        const discovered = await discoverPrivateBridgeConfig();
        if (discovered && discovered.bridgeUrl) {
            const headers = { 'Content-Type': 'application/json' };
            const token = discovered.bridgeToken || getLocalGitHubToken();
            if (token) {
                headers['Authorization'] = `Bearer ${token}`;
            }
            const res = await fetch(`${discovered.bridgeUrl}/api/rpc`, {
                method: 'POST',
                headers,
                body: JSON.stringify({ action: 'fetch_media', messageId })
            });
            const data = await res.json();
            if (data.media && data.media.data) {
                const ext = (data.media.mimetype.split('/')[1] || 'bin').split(';')[0];
                const savePath = path.join(mediaDir, `${outputName}.${ext}`);
                fs.writeFileSync(savePath, Buffer.from(data.media.data, 'base64'));
                console.log('Saved media to ' + savePath);
                return;
            } else {
                console.error('Media error:', data.error || 'No media payload returned');
                process.exitCode = 1;
                return;
            }
        }
    }

    const ws = new WebSocket(process.env.WHATSAPP_ENGINE_WS || 'ws://localhost:8080');
    ws.on('open', () => {
        ws.send(JSON.stringify({
            action: 'fetch_media',
            messageId
        }));
    });

    ws.on('message', (data) => {
        try {
            const res = JSON.parse(data.toString());
            if (res.type === 'media_response') {
                if (res.media && res.media.data) {
                    const ext = (res.media.mimetype.split('/')[1] || 'bin').split(';')[0];
                    const savePath = path.join(mediaDir, `${outputName}.${ext}`);
                    fs.writeFileSync(savePath, Buffer.from(res.media.data, 'base64'));
                    console.log('Saved media to ' + savePath);
                    ws.close();
                    process.exit(0);
                } else {
                    console.error('Media error:', res.error || 'No media payload returned');
                    ws.close();
                    process.exit(1);
                }
            }
        } catch (e) {
            console.error(e.message);
            ws.close();
            process.exit(1);
        }
    });

    setTimeout(() => {
        console.error('Timeout waiting for media response');
        ws.close();
        process.exit(1);
    }, 10000);
}

run();

const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');

const messageId = process.argv[2];
const outputName = process.argv[3] || `media_${Date.now()}`;

if (!messageId) {
    console.error('Usage: node scripts/get_media.js "<MessageID>" [outputFilenameWithoutExt]');
    process.exit(1);
}

const ROOT_DIR = path.resolve(__dirname, '..');
const mediaDir = path.join(ROOT_DIR, 'media');
const BRIDGE_FILE = path.join(ROOT_DIR, '.bridge_url');

if (!fs.existsSync(mediaDir)) {
    fs.mkdirSync(mediaDir, { recursive: true });
}

async function discoverHttpBridgeUrl() {
    if (process.env.WHATSAPP_ENGINE_HTTP) return process.env.WHATSAPP_ENGINE_HTTP.replace(/\/+$/, '');
    if (fs.existsSync(BRIDGE_FILE)) {
        const saved = fs.readFileSync(BRIDGE_FILE, 'utf8').trim();
        if (saved.startsWith('http')) return saved.replace(/\/+$/, '');
    }
    try {
        const res = await fetch('https://api.github.com/repos/chetangoswami/whatsapp-engine', {
            headers: { 'User-Agent': 'whatsapp-engine-client', 'Accept': 'application/vnd.github+json' }
        });
        if (res.ok) {
            const repo = await res.json();
            if (repo.homepage && repo.homepage.startsWith('http')) return repo.homepage.replace(/\/+$/, '');
        }
    } catch (e) {}
    return null;
}

async function run() {
    // Check if local engine is alive first
    let localAlive = false;
    try {
        const res = await fetch('http://localhost:8080/api/health');
        localAlive = res.ok;
    } catch (e) {}

    if (!localAlive) {
        const bridgeUrl = await discoverHttpBridgeUrl();
        if (bridgeUrl) {
            const headers = { 'Content-Type': 'application/json' };
            if (process.env.WHATSAPP_BRIDGE_TOKEN) {
                headers['Authorization'] = `Bearer ${process.env.WHATSAPP_BRIDGE_TOKEN}`;
            }
            const res = await fetch(`${bridgeUrl}/api/rpc`, {
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
                process.exit(0);
            } else {
                console.error('Media error:', data.error || 'No media payload returned');
                process.exit(1);
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
                    process.exit(0);
                } else {
                    console.error('Media error:', res.error || 'No media payload returned');
                    process.exit(1);
                }
            }
        } catch (e) {
            console.error(e.message);
            process.exit(1);
        }
    });

    setTimeout(() => {
        console.error('Timeout waiting for media response');
        process.exit(1);
    }, 10000);
}

run();

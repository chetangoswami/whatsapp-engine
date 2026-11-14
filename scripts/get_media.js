const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');

const messageId = process.argv[2];
const outputName = process.argv[3] || `media_${Date.now()}`;

if (!messageId) {
    console.error('Usage: node scripts/get_media.js "<MessageID>" [outputFilenameWithoutExt]');
    process.exit(1);
}

const mediaDir = path.resolve(__dirname, '../media');
if (!fs.existsSync(mediaDir)) {
    fs.mkdirSync(mediaDir, { recursive: true });
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

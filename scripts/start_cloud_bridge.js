const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { publishPrivateBridgeConfig } = require('../src/utils/auth');

const ROOT_DIR = path.resolve(__dirname, '..');
const BIN_DIR = path.join(ROOT_DIR, 'bin');
const CLOUDFLARED_EXE = process.platform === 'win32'
    ? path.join(BIN_DIR, 'cloudflared.exe')
    : path.join(BIN_DIR, 'cloudflared');
const PORT = Number(process.env.WHATSAPP_ENGINE_PORT || 8080);

async function ensureCloudflared() {
    if (fs.existsSync(CLOUDFLARED_EXE)) {
        return CLOUDFLARED_EXE;
    }
    if (!fs.existsSync(BIN_DIR)) {
        fs.mkdirSync(BIN_DIR, { recursive: true });
    }
    const downloadUrl = process.platform === 'win32'
        ? 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe'
        : 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64';

    console.log(`[Bridge] Downloading official cloudflared binary from ${downloadUrl}...`);
    const res = await fetch(downloadUrl, { redirect: 'follow' });
    if (!res.ok) {
        throw new Error(`Failed to download cloudflared: HTTP ${res.status}`);
    }
    const buffer = Buffer.from(await res.arrayBuffer());
    fs.writeFileSync(CLOUDFLARED_EXE, buffer);
    if (process.platform !== 'win32') {
        fs.chmodSync(CLOUDFLARED_EXE, 0o755);
    }
    console.log(`[Bridge] Saved cloudflared to ${CLOUDFLARED_EXE}`);
    return CLOUDFLARED_EXE;
}

async function main() {
    const binPath = await ensureCloudflared();
    console.log(`[Bridge] Starting Private Cloudflare HTTPS Tunnel -> http://localhost:${PORT} ...`);

    const child = spawn(binPath, ['tunnel', '--url', `http://localhost:${PORT}`, '--no-autoupdate'], {
        stdio: ['ignore', 'pipe', 'pipe']
    });

    let published = false;
    function handleOutput(chunk) {
        const text = chunk.toString();
        const match = text.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i);
        if (match && !published) {
            published = true;
            const tunnelUrl = match[0];
            console.log(`\n=============================================================`);
            console.log(`[Bridge] PRIVATE HTTPS BRIDGE ACTIVE: ${tunnelUrl}`);
            console.log(`=============================================================\n`);
            publishPrivateBridgeConfig(tunnelUrl);
        }
    }

    child.stdout.on('data', handleOutput);
    child.stderr.on('data', handleOutput);

    child.on('exit', (code) => {
        console.log(`[Bridge] cloudflared exited with code ${code}`);
        process.exit(code || 0);
    });
}

main().catch(err => {
    console.error('[Bridge] Fatal error:', err.message);
    process.exit(1);
});

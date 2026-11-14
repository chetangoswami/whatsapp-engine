const { spawn, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT_DIR = path.resolve(__dirname, '..');
const BIN_DIR = path.join(ROOT_DIR, 'bin');
const CLOUDFLARED_EXE = process.platform === 'win32'
    ? path.join(BIN_DIR, 'cloudflared.exe')
    : path.join(BIN_DIR, 'cloudflared');
const BRIDGE_FILE = path.join(ROOT_DIR, '.bridge_url');
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

function getGitHubToken() {
    if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
    try {
        const out = execSync('git credential fill', {
            input: 'protocol=https\nhost=github.com\n\n',
            encoding: 'utf8',
            stdio: ['pipe', 'pipe', 'ignore']
        });
        const match = out.match(/^password=(.+)$/m);
        return match ? match[1].trim() : null;
    } catch (e) {
        return null;
    }
}

async function publishBridgeUrlToGitHub(tunnelUrl) {
    const token = getGitHubToken();
    if (!token) {
        console.log('[Bridge] No GitHub token found to auto-publish tunnel URL; saved locally to .bridge_url');
        return;
    }
    try {
        const res = await fetch('https://api.github.com/repos/chetangoswami/whatsapp-engine', {
            method: 'PATCH',
            headers: {
                'Authorization': `Bearer ${token}`,
                'User-Agent': 'whatsapp-engine-bridge',
                'Accept': 'application/vnd.github+json',
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ homepage: tunnelUrl })
        });
        if (res.ok) {
            console.log(`[Bridge] Published live tunnel URL to GitHub repo metadata: ${tunnelUrl}`);
            console.log(`[Bridge] Remote Cloud Agents can now run 'node client.js status|listen|history|send' with zero config!`);
        } else {
            console.warn(`[Bridge] Failed to update GitHub repo homepage: HTTP ${res.status}`);
        }
    } catch (e) {
        console.warn('[Bridge] Error publishing tunnel URL to GitHub:', e.message);
    }
}

async function main() {
    const binPath = await ensureCloudflared();
    console.log(`[Bridge] Starting Cloudflare HTTPS Tunnel -> http://localhost:${PORT} ...`);

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
            fs.writeFileSync(BRIDGE_FILE, tunnelUrl, 'utf8');
            console.log(`\n=============================================================`);
            console.log(`[Bridge] LIVE HTTPS BRIDGE ACTIVE: ${tunnelUrl}`);
            console.log(`=============================================================\n`);
            publishBridgeUrlToGitHub(tunnelUrl);
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

const { execSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { ROOT_DIR } = require('./logger');

const AUTH_FILE = path.join(ROOT_DIR, '.bridge_auth.json');
const PRIVATE_BRIDGE_REPO = 'whatsapp-bridge-config';

// Retrieve GitHub token from env, `gh auth token`, or `git credential fill`
function getLocalGitHubToken() {
    if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN.trim();
    if (process.env.GH_TOKEN) return process.env.GH_TOKEN.trim();

    try {
        const ghToken = execSync('gh auth token', {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore']
        }).trim();
        if (ghToken) return ghToken;
    } catch (e) {}

    try {
        const out = execSync('git credential fill', {
            input: 'protocol=https\nhost=github.com\n\n',
            encoding: 'utf8',
            stdio: ['pipe', 'pipe', 'ignore']
        });
        const match = out.match(/^password=(.+)$/m);
        if (match) return match[1].trim();
    } catch (e) {}

    return null;
}

async function fetchGitHubUser(token) {
    if (!token) return null;
    try {
        const res = await fetch('https://api.github.com/user', {
            headers: {
                'Authorization': `Bearer ${token}`,
                'User-Agent': 'whatsapp-engine',
                'Accept': 'application/vnd.github+json'
            }
        });
        if (!res.ok) return null;
        return await res.json();
    } catch (e) {
        return null;
    }
}

function readLocalBridgeAuth() {
    try {
        if (fs.existsSync(AUTH_FILE)) {
            return JSON.parse(fs.readFileSync(AUTH_FILE, 'utf8'));
        }
    } catch (e) {}
    return null;
}

function writeLocalBridgeAuth(data) {
    const current = readLocalBridgeAuth() || {};
    const merged = {
        ...current,
        ...data,
        updatedAt: new Date().toISOString()
    };
    if (!merged.bridgeToken) {
        merged.bridgeToken = crypto.randomBytes(32).toString('hex');
    }
    fs.writeFileSync(AUTH_FILE, JSON.stringify(merged, null, 2), 'utf8');
    return merged;
}

// Publish { bridgeUrl, bridgeToken } to the user's private GitHub repo `<owner>/whatsapp-bridge-config`
async function publishPrivateBridgeConfig(tunnelUrl) {
    const githubToken = getLocalGitHubToken();
    const user = await fetchGitHubUser(githubToken);
    const localAuth = writeLocalBridgeAuth({
        owner: user ? user.login : undefined,
        bridgeUrl: tunnelUrl
    });

    if (!githubToken || !user) {
        console.log('[Bridge Auth] Saved bridge token locally to .bridge_auth.json (no GitHub token found for cloud sync).');
        return localAuth;
    }

    const owner = user.login;
    const headers = {
        'Authorization': `Bearer ${githubToken}`,
        'User-Agent': 'whatsapp-engine',
        'Accept': 'application/vnd.github+json',
        'Content-Type': 'application/json'
    };

    // 1. Clear public homepage on whatsapp-engine if it was set previously
    try {
        await fetch(`https://api.github.com/repos/${owner}/whatsapp-engine`, {
            method: 'PATCH',
            headers,
            body: JSON.stringify({ homepage: '' })
        });
    } catch (e) {}

    // 2. Ensure private repo `<owner>/whatsapp-bridge-config` exists
    const repoCheck = await fetch(`https://api.github.com/repos/${owner}/${PRIVATE_BRIDGE_REPO}`, { headers });
    if (repoCheck.status === 404) {
        await fetch('https://api.github.com/user/repos', {
            method: 'POST',
            headers,
            body: JSON.stringify({
                name: PRIVATE_BRIDGE_REPO,
                description: 'Private encrypted endpoint configuration for whatsapp-engine cloud bridge',
                private: true,
                auto_init: true
            })
        });
        await new Promise(r => setTimeout(r, 1500));
    }

    // 3. Upsert `bridge.json` inside the private repository
    const fileUrl = `https://api.github.com/repos/${owner}/${PRIVATE_BRIDGE_REPO}/contents/bridge.json`;
    let sha = undefined;
    try {
        const existing = await fetch(fileUrl, { headers });
        if (existing.ok) {
            const existingJson = await existing.json();
            sha = existingJson.sha;
        }
    } catch (e) {}

    const payloadContent = Buffer.from(JSON.stringify({
        owner,
        bridgeUrl: localAuth.bridgeUrl,
        bridgeToken: localAuth.bridgeToken,
        updatedAt: localAuth.updatedAt
    }, null, 2)).toString('base64');

    const putRes = await fetch(fileUrl, {
        method: 'PUT',
        headers,
        body: JSON.stringify({
            message: 'chore: update live whatsapp bridge endpoint',
            content: payloadContent,
            ...(sha ? { sha } : {})
        })
    });

    if (putRes.ok) {
        console.log(`[Bridge Auth] Synced private bridge endpoint & 256-bit token to private repo: ${owner}/${PRIVATE_BRIDGE_REPO}`);
    } else {
        console.warn(`[Bridge Auth] Failed to update private bridge config: HTTP ${putRes.status}`);
    }

    return localAuth;
}

// Discover { bridgeUrl, bridgeToken } from env, local file, or the authenticated user's private GitHub repo
async function discoverPrivateBridgeConfig() {
    if (process.env.WHATSAPP_ENGINE_HTTP) {
        return {
            bridgeUrl: process.env.WHATSAPP_ENGINE_HTTP.replace(/\/+$/, ''),
            bridgeToken: process.env.WHATSAPP_BRIDGE_TOKEN || getLocalGitHubToken() || ''
        };
    }

    const local = readLocalBridgeAuth();
    if (local && local.bridgeUrl) {
        return {
            bridgeUrl: local.bridgeUrl.replace(/\/+$/, ''),
            bridgeToken: local.bridgeToken || ''
        };
    }

    const githubToken = getLocalGitHubToken();
    if (!githubToken) return null;

    const user = await fetchGitHubUser(githubToken);
    if (!user || !user.login) return null;

    try {
        const res = await fetch(`https://api.github.com/repos/${user.login}/${PRIVATE_BRIDGE_REPO}/contents/bridge.json`, {
            headers: {
                'Authorization': `Bearer ${githubToken}`,
                'User-Agent': 'whatsapp-engine',
                'Accept': 'application/vnd.github+json'
            }
        });
        if (res.ok) {
            const fileData = await res.json();
            const decoded = JSON.parse(Buffer.from(fileData.content, 'base64').toString('utf8'));
            if (decoded && decoded.bridgeUrl) {
                return {
                    bridgeUrl: decoded.bridgeUrl.replace(/\/+$/, ''),
                    bridgeToken: decoded.bridgeToken || githubToken
                };
            }
        }
    } catch (e) {}

    return null;
}

module.exports = {
    AUTH_FILE,
    PRIVATE_BRIDGE_REPO,
    getLocalGitHubToken,
    fetchGitHubUser,
    readLocalBridgeAuth,
    writeLocalBridgeAuth,
    publishPrivateBridgeConfig,
    discoverPrivateBridgeConfig
};

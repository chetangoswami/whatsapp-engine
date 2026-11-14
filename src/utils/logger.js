const fs = require('fs');
const path = require('path');

const ROOT_DIR = path.resolve(__dirname, '../..');
const LOG_PATH = path.join(ROOT_DIR, 'chat_logs.json');
const MAX_LOGS = 1000;

function readChatLogs() {
    try {
        if (!fs.existsSync(LOG_PATH)) {
            return [];
        }
        const raw = fs.readFileSync(LOG_PATH, 'utf8').replace(/^\uFEFF/, '').trim();
        if (!raw) return [];
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : [];
    } catch (e) {
        console.error('[Logger] Failed to read chat_logs.json:', e.message);
        return [];
    }
}

function appendToChatLogs(entry) {
    try {
        const logs = readChatLogs();
        const now = new Date().toISOString();
        const record = {
            ...entry,
            time: entry.time || now
        };

        // 1. Exact ID deduplication if message ID is present
        if (record.id && logs.some(l => l.id === record.id)) {
            return;
        }

        // 2. Fallback deduplication for entries without ID within 1.5s
        const last = logs[logs.length - 1];
        if (
            !record.id &&
            last &&
            last.type === record.type &&
            (last.from || last.to) === (record.from || record.to) &&
            last.text === record.text &&
            Math.abs(new Date(record.time).getTime() - new Date(last.time).getTime()) < 1500
        ) {
            return;
        }

        logs.push(record);
        const trimmed = logs.length > MAX_LOGS ? logs.slice(-MAX_LOGS) : logs;
        const tempPath = `${LOG_PATH}.tmp`;
        fs.writeFileSync(tempPath, JSON.stringify(trimmed, null, 2), 'utf8');
        fs.renameSync(tempPath, LOG_PATH);
    } catch (e) {
        console.error('[Logger] Failed to write chat_logs.json:', e.message);
    }
}

module.exports = {
    ROOT_DIR,
    LOG_PATH,
    readChatLogs,
    appendToChatLogs
};

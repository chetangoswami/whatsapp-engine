const { Client, LocalAuth } = require('whatsapp-web.js');
const fs = require('fs');
const path = require('path');

const ROOT_DIR = path.resolve(__dirname, '..');
console.log('[Assignment Analyzer] Starting WhatsApp client...');

const client = new Client({
    authStrategy: new LocalAuth({ dataPath: path.join(ROOT_DIR, '.wwebjs_auth') }),
    authTimeoutMs: 60000,
    puppeteer: {
        headless: 'new',
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    }
});

client.on('qr', () => {
    console.log('[Assignment Analyzer] QR CODE REQUIRED! Scan with your WhatsApp app.');
});

client.on('authenticated', () => {
    console.log('[Assignment Analyzer] Authenticated successfully!');
});

client.on('auth_failure', (msg) => {
    console.error('[Assignment Analyzer] Authentication failure:', msg);
    process.exit(1);
});

client.on('ready', async () => {
    console.log('[Assignment Analyzer] WhatsApp Client is ready! Fetching chats...');

    try {
        const chats = await client.getChats();
        console.log(`[Assignment Analyzer] Total chats found: ${chats.length}`);

        const chatOverview = chats.map(c => ({
            id: c.id._serialized,
            name: c.name,
            isGroup: c.isGroup,
            unreadCount: c.unreadCount,
            timestamp: c.timestamp
        }));

        const overviewPath = path.join(ROOT_DIR, 'chats_overview.json');
        fs.writeFileSync(overviewPath, JSON.stringify(chatOverview, null, 2));
        console.log(`[Assignment Analyzer] Saved chats overview to ${overviewPath}`);

        const targetChats = chats.filter(c => {
            const name = (c.name || '').toLowerCase();
            const isGroup = c.isGroup;
            const matchesCse = name.includes('cse') || name.includes('rjit') || name.includes('section a') || name.includes('cse a') || name.includes('cse-a') || name.includes('batch');
            const matchesSubject = name.includes('chem') || name.includes('math') || name.includes('beee') || name.includes('english') || name.includes('graphics') || name.includes('bt-10') || name.includes('bt10');
            return matchesCse || matchesSubject || (isGroup && (name.includes('assignment') || name.includes('class') || name.includes('official') || name.includes('college')));
        });

        console.log(`[Assignment Analyzer] Found ${targetChats.length} potential target chats:`);
        targetChats.forEach(c => console.log(` - [${c.isGroup ? 'Group' : 'DM'}] ${c.name} (${c.id._serialized})`));

        const allGroups = chats.filter(c => c.isGroup);
        const chatsToScan = [...new Set([...targetChats, ...allGroups.slice(0, 15)])];

        console.log(`[Assignment Analyzer] Scanning ${chatsToScan.length} chats for assignment messages...`);

        const assignmentKeywords = [
            'assignment', 'submission', 'submit', 'homework', 'last date', 'due date', 'deadline',
            'bt-101', 'bt-102', 'bt-103', 'bt-104', 'bt-105', 'bt101', 'bt102', 'bt103', 'bt104', 'bt105',
            'chemistry', 'mathematics', 'maths', 'beee', 'electrical', 'electronics', 'graphics', 'ed',
            'unit 1', 'unit 2', 'unit 3', 'unit 4', 'unit 5', 'unit-1', 'unit-2', 'unit-3', 'unit-4', 'unit-5',
            'experiment', 'lab manual', 'write-up', 'practical', 'rgpv', 'questions'
        ];

        const results = [];

        for (const chat of chatsToScan) {
            console.log(`Fetching messages from: ${chat.name}...`);
            try {
                const messages = await chat.fetchMessages({ limit: 80 });
                for (const msg of messages) {
                    const body = (msg.body || '').toLowerCase();
                    const hasKeyword = assignmentKeywords.some(kw => body.includes(kw));

                    if (hasKeyword || msg.hasMedia) {
                        const isRelevant = hasKeyword || (body.length > 0 && body.includes('pdf'));
                        if (isRelevant) {
                            results.push({
                                chatName: chat.name,
                                chatId: chat.id._serialized,
                                isGroup: chat.isGroup,
                                from: msg.author || msg.from,
                                timestamp: msg.timestamp,
                                date: new Date(msg.timestamp * 1000).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }),
                                body: msg.body,
                                hasMedia: msg.hasMedia,
                                type: msg.type
                            });
                        }
                    }
                }
            } catch (err) {
                console.error(`Error fetching messages for ${chat.name}:`, err.message);
            }
        }

        console.log(`[Assignment Analyzer] Extracted ${results.length} relevant assignment/notice messages!`);
        const resultPath = path.join(ROOT_DIR, 'assignment_messages.json');
        fs.writeFileSync(resultPath, JSON.stringify(results, null, 2));
        console.log(`[Assignment Analyzer] Results saved to ${resultPath}`);

    } catch (e) {
        console.error('[Assignment Analyzer] Encountered error:', e);
    } finally {
        console.log('[Assignment Analyzer] Finished. Closing client...');
        await client.destroy();
        process.exit(0);
    }
});

client.initialize();

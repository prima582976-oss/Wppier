const express = require('express');
const path = require('path');
const fs = require('fs');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const pino = require('pino');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

// Kalıcı Session Klasör Yolu
const AUTH_DIR = process.env.RAILWAY_VOLUME ? 
    path.join(process.env.RAILWAY_VOLUME, 'session') : 
    path.join(__dirname, 'session');

if (!fs.existsSync(AUTH_DIR)) {
    fs.mkdirSync(AUTH_DIR, { recursive: true });
}

let sock = null;
let isReady = false;
let pairingCode = null;
let allChats = [];

const logger = pino({ level: 'silent' });

async function startBot() {
    try {
        const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

        sock = makeWASocket({
            version: [2, 3000, 1015901307],
            auth: state,
            printQRInTerminal: false,
            logger: logger,
            connectTimeoutMs: 60000,
            keepAliveIntervalMs: 10000,
        });

        sock.ev.on('connection.update', async (update) => {
            if (update.connection === 'open') {
                isReady = true;
                pairingCode = null;
                console.log('✅ BAĞLANTI BAŞARILI - Kalıcı oturum aktif');
                await loadAllChats();
            }
            if (update.connection === 'close') {
                isReady = false;
                pairingCode = null;
                if (update.lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut) {
                    setTimeout(startBot, 8000);
                }
            }
        });

        sock.ev.on('creds.update', saveCreds);
    } catch (e) {
        console.error('Hata:', e);
        setTimeout(startBot, 10000);
    }
}

async function loadAllChats() {
    if (!sock || !isReady) return;
    try {
        const groups = await sock.groupFetchAllParticipating();
        allChats = [];

        Object.keys(groups).forEach(key => {
            allChats.push({ id: key, name: groups[key].subject || 'Grup', type: 'group' });
        });
    } catch (e) {
        console.error('Sohbetler yüklenirken hata:', e);
    }
}

// ===================== ROUTES =====================
app.get('/', (req, res) => {
    res.send(`
<!DOCTYPE html>
<html lang="tr">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>WA Otomasyon Paneli</title>
    <style>
        * { margin:0; padding:0; box-sizing:border-box; }
        body { background:#0a0a0a; color:#ddd; font-family:Arial, sans-serif; padding:15px; }
        .container { max-width:800px; margin:auto; background:#111; padding:20px; border-radius:12px; border:1px solid #222; }
        h1 { text-align:center; color:#25D366; margin-bottom:15px; }
        .pairing { font-size:24px; letter-spacing:5px; background:#1a1a1a; padding:15px; border-radius:8px; text-align:center; margin:15px 0; word-break:break-all; }
        .status { padding:12px; background:#1a1a1a; border-radius:8px; margin-bottom:15px; text-align:center; font-weight:bold; }
        button { padding:12px 20px; margin:5px 0; border:none; border-radius:6px; cursor:pointer; font-weight:bold; width:100%; }
        .start { background:#25D366; color:black; }
        .stop { background:#e53e3e; color:white; }
        .secondary { background:#333; color:white; }
        input, textarea { width:100%; padding:10px; background:#1a1a1a; border:1px solid #333; color:#fff; border-radius:6px; box-sizing:border-box; }
        label { font-size:14px; color:#aaa; margin-bottom:5px; display:block; }
        .form-group { margin-bottom:15px; }
    </style>
</head>
<body>
<div class="container">
    <h1>💬 WhatsApp Gönderim Paneli</h1>
    <div class="status" id="status">Bağlanıyor...</div>
    <div class="pairing" id="pairingBox">Oturum Durumu Bekleniyor...</div>

    <div class="form-group">
        <label>Gönderim Hızı (ms):</label>
        <input type="number" id="speed" value="3000" min="1000">
    </div>

    <div class="form-group">
        <label>Hedef ID (Grup veya Kişi JID):</label>
        <input type="text" id="target" placeholder="Örn: 905xxxxxxxxx@s.whatsapp.net veya xxx@g.us">
    </div>

    <div class="form-group">
        <label>Mesajlar (Her satıra bir mesaj):</label>
        <textarea id="messages" rows="5" placeholder="Merhaba&#10;Nasılsın?&#10;Test mesajı"></textarea>
    </div>

    <button class="start" onclick="startSending()">▶ Gönderimi Başlat</button>
    <button class="stop" onclick="stopSending()" id="stopBtn" disabled>⏹ Durdur</button>
    <button class="secondary" onclick="loadChatsUI()">🔄 Grupları Çek</button>

    <div id="chatList" style="margin-top:20px; max-height:250px; overflow:auto; background:#1a1a1a; padding:10px; border-radius:8px;"></div>
</div>

<script>
    async function updateUI() {
        try {
            const res = await fetch('/status');
            const d = await res.json();
            document.getElementById('status').innerHTML = d.isReady ? '✅ Bağlı (Kalıcı Oturum)' : '⏳ Bağlanıyor...';
            if (d.pairingCode) {
                document.getElementById('pairingBox').textContent = 'Eşleşme Kodu: ' + d.pairingCode;
            } else if (d.isReady) {
                document.getElementById('pairingBox').textContent = 'WhatsApp Aktif';
            }
        } catch(e) {}
    }

    async function loadChatsUI() {
        try {
            const res = await fetch('/chats');
            const data = await res.json();
            if (data.success) {
                let html = '';
                data.chats.forEach(c => {
                    html += \`<div style="padding:10px;background:#222;margin:5px 0;border-radius:6px;cursor:pointer" onclick="selectChat('\${c.id}')">
                        \${c.name} \${c.type==='group'?'👥':'👤'}<br><small style="color:#888">\${c.id}</small>
                    </div>\`;
                });
                document.getElementById('chatList').innerHTML = html || 'Grup bulunamadı.';
            }
        } catch(e) {
            alert('Sohbetler alınamadı.');
        }
    }

    window.selectChat = (id) => document.getElementById('target').value = id;

    async function startSending() {
        const speed = parseInt(document.getElementById('speed').value);
        const target = document.getElementById('target').value.trim();
        const messages = document.getElementById('messages').value.split('\\n').filter(m => m.trim());

        if (!target || messages.length === 0) return alert('Lütfen hedef ve mesaj alanlarını doldurun!');

        const res = await fetch('/start', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({speed, target, messages})
        });

        const data = await res.json();
        if (data.success) {
            document.getElementById('stopBtn').disabled = false;
            alert('Gönderim işlemi başlatıldı!');
        } else {
            alert('Gönderim başlatılamadı: ' + (data.error || 'Bağlantı hazır değil'));
        }
    }

    async function stopSending() {
        await fetch('/stop', {method: 'POST'});
        document.getElementById('stopBtn').disabled = true;
        alert('Gönderim durduruldu.');
    }

    setInterval(updateUI, 3000);
    updateUI();
</script>
</body>
</html>`);
});

app.get('/status', (req, res) => res.json({ isReady, pairingCode }));

app.get('/chats', async (req, res) => {
    if (!isReady) return res.json({success: false, error: 'Oturum aktif değil'});
    await loadAllChats();
    res.json({success: true, chats: allChats});
});

let activeLoopTimeout = null;
let isLoopRunning = false;

app.post('/start', (req, res) => {
    const { speed, target, messages } = req.body;
    if (!isReady || !sock) return res.json({ success: false, error: 'WhatsApp bağlı değil' });

    const messageList = (messages || []).map(m => m.trim()).filter(m => m.length > 0);
    if (!target || messageList.length === 0) return res.json({ success: false, error: 'Eksik veri' });

    if (activeLoopTimeout) clearTimeout(activeLoopTimeout);
    isLoopRunning = true;

    let index = 0;
    const intervalMs = Math.max(Number(speed) || 3000, 1000);

    const sendWithTyping = async () => {
        if (!isLoopRunning || !sock || !isReady) return;

        const currentMsg = messageList[index % messageList.length];
        try {
            // 1. Yazıyor... (composing) efekti başlatılıyor
            await sock.presenceSubscribe(target).catch(() => {});
            await sock.sendPresenceUpdate('composing', target).catch(() => {});

            // 2. Gerçekçi yazma hissi için 1.5 saniye bekleme
            await new Promise(resolve => setTimeout(resolve, 1500));

            // 3. Mesaj gönderimi
            await sock.sendMessage(target, { text: currentMsg });

            // 4. Durumu duraklatıldıya çekme
            await sock.sendPresenceUpdate('paused', target).catch(() => {});

            index++;
        } catch (err) {
            console.error('Mesaj gönderim hatası:', err.message);
        }

        // Sonraki mesaj zamanlaması
        if (isLoopRunning) {
            activeLoopTimeout = setTimeout(sendWithTyping, intervalMs);
        }
    };

    sendWithTyping();
    res.json({ success: true });
});

app.post('/stop', (req, res) => {
    isLoopRunning = false;
    if (activeLoopTimeout) {
        clearTimeout(activeLoopTimeout);
        activeLoopTimeout = null;
    }
    res.json({ success: true });
});

app.listen(PORT, '0.0.0.0', () => {
    console.log('🚀 Sunucu http://localhost:' + PORT + ' üzerinde çalışıyor');
    startBot();
});
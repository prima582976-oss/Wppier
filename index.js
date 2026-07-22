// Node.js Web Crypto API Düzeltmesi (crypto is not defined hatası için)
const crypto = require('crypto');
if (!globalThis.crypto) {
    globalThis.crypto = crypto.webcrypto || crypto;
}

const express = require('express');
const path = require('path');
const fs = require('fs');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
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
        const { version } = await fetchLatestBaileysVersion();

        sock = makeWASocket({
            version,
            auth: state,
            printQRInTerminal: false,
            logger: logger,
            connectTimeoutMs: 60000,
            keepAliveIntervalMs: 10000,
            browser: ["Ubuntu", "Chrome", "20.0.04"]
        });

        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect } = update;
            
            if (connection === 'open') {
                isReady = true;
                pairingCode = null;
                console.log('✅ BAĞLANTI BAŞARILI - Kalıcı oturum aktif');
                await loadAllChats();
            }
            
            if (connection === 'close') {
                isReady = false;
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                if (statusCode !== DisconnectReason.loggedOut) {
                    setTimeout(startBot, 5000);
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
        allChats = Object.keys(groups).map(key => ({
            id: key,
            name: groups[key].subject || 'Grup',
            type: 'group'
        }));
    } catch (e) {
        console.error('Sohbet yükleme hatası:', e);
    }
}

// ===================== ROUTES =====================

// Eşleşme Kodu İsteme Endpoint'i
app.post('/request-code', async (req, res) => {
    const { phoneNumber } = req.body;
    if (!phoneNumber) return res.json({ success: false, error: 'Telefon numarası girin!' });
    if (!sock) return res.json({ success: false, error: 'Sistem hazırlanıyor, tekrar deneyin.' });

    try {
        const cleanNumber = phoneNumber.replace(/[^0-9]/g, '');
        const code = await sock.requestPairingCode(cleanNumber);
        pairingCode = code;
        res.json({ success: true, code });
    } catch (err) {
        res.json({ success: false, error: err.message || 'Kod alınamadı' });
    }
});

app.get('/status', (req, res) => res.json({ isReady, pairingCode }));

app.get('/chats', async (req, res) => {
    if (!isReady) return res.json({ success: false, error: 'Oturum aktif değil' });
    await loadAllChats();
    res.json({ success: true, chats: allChats });
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
            await sock.presenceSubscribe(target).catch(() => {});
            await sock.sendPresenceUpdate('composing', target).catch(() => {});

            await new Promise(resolve => setTimeout(resolve, 1500));

            await sock.sendMessage(target, { text: currentMsg });

            await sock.sendPresenceUpdate('paused', target).catch(() => {});

            index++;
        } catch (err) {
            console.error('Mesaj gönderim hatası:', err.message);
        }

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
        .container { max-width:600px; margin:auto; background:#111; padding:20px; border-radius:12px; border:1px solid #222; }
        h1 { text-align:center; color:#25D366; margin-bottom:15px; }
        .pairing { font-size:28px; letter-spacing:6px; background:#1a1a1a; padding:15px; border-radius:8px; text-align:center; margin:15px 0; color:#25D366; font-weight:bold; }
        .status { padding:12px; background:#1a1a1a; border-radius:8px; margin-bottom:15px; text-align:center; font-weight:bold; }
        button { padding:12px; margin:5px 0; border:none; border-radius:6px; cursor:pointer; font-weight:bold; width:100%; }
        .btn-green { background:#25D366; color:black; }
        .btn-red { background:#e53e3e; color:white; }
        .btn-gray { background:#333; color:white; }
        input, textarea { width:100%; padding:10px; background:#1a1a1a; border:1px solid #333; color:#fff; border-radius:6px; margin-bottom:10px; }
        label { font-size:13px; color:#aaa; margin-bottom:4px; display:block; }
    </style>
</head>
<body>
<div class="container">
    <h1>💬 WhatsApp Gönderim Paneli</h1>
    <div class="status" id="status">Durum Bekleniyor...</div>

    <div style="background:#181818; padding:15px; border-radius:8px; margin-bottom:15px;">
        <label>Telefon Numarası (Örn: 905xxxxxxxxx):</label>
        <input type="text" id="phoneInput" placeholder="905xxxxxxxxx">
        <button class="btn-gray" onclick="getCode()">🔑 Eşleşme Kodu Al</button>
        <div class="pairing" id="pairingBox">------</div>
    </div>

    <label>Gönderim Hızı (ms):</label>
    <input type="number" id="speed" value="3000" min="1000">

    <label>Hedef JID / Grup ID:</label>
    <input type="text" id="target" placeholder="Örn: 905xxxxxxxxx@s.whatsapp.net veya xxx@g.us">

    <label>Mesajlar (Satır satır):</label>
    <textarea id="messages" rows="4" placeholder="Merhaba&#10;Test mesajı"></textarea>

    <button class="btn-green" onclick="startSending()">▶ Gönderimi Başlat</button>
    <button class="btn-red" onclick="stopSending()">⏹ Durdur</button>
</div>

<script>
    async function getCode() {
        const phone = document.getElementById('phoneInput').value.trim();
        if(!phone) return alert('Lütfen telefon numarası girin!');
        
        const res = await fetch('/request-code', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({ phoneNumber: phone })
        });
        const d = await res.json();
        if(d.success) {
            document.getElementById('pairingBox').innerText = d.code;
        } else {
            alert('Hata: ' + d.error);
        }
    }

    async function updateUI() {
        try {
            const res = await fetch('/status');
            const d = await res.json();
            document.getElementById('status').innerText = d.isReady ? '✅ Bağlı (Kalıcı Oturum)' : '⏳ Bağlantı Bekleniyor...';
            if (d.isReady) {
                document.getElementById('pairingBox').innerText = 'BAĞLANDI';
            }
        } catch(e) {}
    }

    async function startSending() {
        const speed = parseInt(document.getElementById('speed').value);
        const target = document.getElementById('target').value.trim();
        const messages = document.getElementById('messages').value.split('\\n').filter(m => m.trim());

        if (!target || messages.length === 0) return alert('Lütfen tüm alanları doldurun!');

        const res = await fetch('/start', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({speed, target, messages})
        });

        const data = await res.json();
        if (data.success) {
            alert('Gönderim başlatıldı!');
        } else {
            alert('Hata: ' + data.error);
        }
    }

    async function stopSending() {
        await fetch('/stop', {method: 'POST'});
        alert('Gönderim durduruldu.');
    }

    setInterval(updateUI, 3000);
    updateUI();
</script>
</body>
</html>`);
});

app.listen(PORT, '0.0.0.0', () => {
    console.log('🚀 Sunucu ' + PORT + ' portunda aktif');
    startBot();
});

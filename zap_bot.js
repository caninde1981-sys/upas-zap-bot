const { default: makeWASocket, DisconnectReason, useMultiFileAuthState, fetchLatestBaileysVersion, makeCacheableSignalKeyStore } = require('@whiskeysockets/baileys');
const { MongoClient } = require('mongodb');
const qrcode = require('qrcode');
const express = require('express');
const pino = require('pino');

const MONGO_URL = process.env.MONGO_URL;
const PORT = process.env.PORT || 41337;

const logger = pino({ level: 'silent' });
const app = express();
app.use(express.json());

let sock = null;
let currentQR = null;
let isReady = false;
let statusMsg = "Iniciando motor...";
let mongoConnected = false;

const { BufferJSON, proto } = require('@whiskeysockets/baileys');

async function useMongoDBAuthState(collection) {
    const writeData = (data, id) => collection.replaceOne({ _id: id }, JSON.parse(JSON.stringify(data, BufferJSON.replacer)), { upsert: true });
    const readData = async (id) => {
        const data = await collection.findOne({ _id: id });
        return data ? JSON.parse(JSON.stringify(data), BufferJSON.reviver) : null;
    };
    const removeData = (id) => collection.deleteOne({ _id: id });

    const creds = await readData('creds') || (await useMultiFileAuthState('temp_auth')).creds;

    return {
        state: {
            creds,
            keys: {
                get: async (type, ids) => {
                    const data = {};
                    await Promise.all(ids.map(async id => {
                        let value = await readData(`${type}-${id}`);
                        if (type === 'app-state-sync-key' && value) value = proto.Message.AppStateSyncKeyData.fromObject(value);
                        data[id] = value;
                    }));
                    return data;
                },
                set: async (data) => {
                    for (const category in data) {
                        for (const id in data[category]) {
                            const value = data[category][id];
                            if (value) await writeData(value, `${category}-${id}`);
                            else await removeData(`${category}-${id}`);
                        }
                    }
                }
            }
        },
        saveCreds: () => writeData(creds, 'creds')
    };
}

async function startBot() {
    try {
        statusMsg = "Conectando ao banco de dados MongoDB...";
        const mongoClient = new MongoClient(MONGO_URL);
        await mongoClient.connect();
        mongoConnected = true;
        
        const db = mongoClient.db('upas_zap');
        const collection = db.collection('auth_session');

        statusMsg = "Lendo credenciais do banco...";
        const { state, saveCreds } = await useMongoDBAuthState(collection);
        const { version } = await fetchLatestBaileysVersion();

        statusMsg = "Iniciando sessao WhatsApp...";
        sock = makeWASocket({
            version,
            auth: state,
            printQRInTerminal: false,
            browser: ['UPAS Cloud', 'Chrome', '1.0'],
            logger
        });

        sock.ev.on('creds.update', saveCreds);

        sock.ev.on('connection.update', (update) => {
            const { connection, lastDisconnect, qr } = update;
            if (qr) {
                currentQR = qr;
                isReady = false;
                statusMsg = "Aguardando leitura do QR Code...";
            }
            if (connection === 'open') {
                isReady = true;
                currentQR = null;
                statusMsg = "✅ Conectado e Ativo!";
                console.log('✅ WHATSAPP CONECTADO!');
            }
            if (connection === 'close') {
                isReady = false;
                const code = lastDisconnect?.error?.output?.statusCode;
                statusMsg = `Desconectado (Erro ${code}). Reconectando...`;
                const shouldReconnect = code !== DisconnectReason.loggedOut;
                if (shouldReconnect) setTimeout(startBot, 5000);
            }
        });
    } catch (e) {
        statusMsg = "❌ ERRO CRÍTICO: " + e.message;
        console.error(e);
        setTimeout(startBot, 10000);
    }
}

startBot();

app.get('/qr', async (req, res) => {
    let html = `<body style="font-family:sans-serif; text-align:center; padding-top:50px; background:#f4f4f4;">
                <div style="background:white; display:inline-block; padding:30px; border-radius:15px; box-shadow:0 4px 15px rgba(0,0,0,0.1);">
                <h1 style="color:#333;">🤖 Status do Robô UPAS</h1>
                <p style="font-size:1.2rem; color:${isReady ? 'green' : '#666'};"><strong>Status:</strong> ${statusMsg}</p>`;

    if (isReady) {
        html += `<div style="color:green; font-size:5rem;">✅</div>
                 <p>O sistema está pronto para enviar mensagens.</p>`;
    } else if (currentQR) {
        const img = await qrcode.toDataURL(currentQR, { width: 300 });
        html += `<h3>Escaneie o QR Code abaixo:</h3>
                 <img src="${img}" style="border:1px solid #ccc; border-radius:10px;">
                 <p style="color:#888;">Recarregando automaticamente a cada 20s...</p>
                 <script>setTimeout(()=>location.reload(), 20000)</script>`;
    } else {
        html += `<div style="padding:20px;">
                    <div style="border: 4px solid #f3f3f3; border-top: 4px solid #3498db; border-radius: 50%; width: 40px; height: 40px; animation: spin 2s linear infinite; margin:auto;"></div>
                    <style>@keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }</style>
                    <p>Aguardando resposta do servidor...</p>
                 </div>
                 <script>setTimeout(()=>location.reload(), 3000)</script>`;
    }

    html += `</div></body>`;
    res.send(html);
});

app.post('/send', async (req, res) => {
    if (!isReady) return res.status(503).json({ success: false, erro: 'Bot Offline: ' + statusMsg });
    let { phone, message } = req.body;
    phone = phone.replace(/\D/g, '') + '@s.whatsapp.net';
    try {
        await sock.sendMessage(phone, { text: message });
        return res.json({ success: true });
    } catch (e) {
        return res.status(500).json({ success: false, erro: e.message });
    }
});

app.listen(PORT, '0.0.0.0', () => console.log('Servidor em nuvem ativo na porta ' + PORT));

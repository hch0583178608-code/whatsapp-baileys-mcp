import express from 'express';
import makeWASocketImport, { DisconnectReason, useMultiFileAuthState } from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import pino from 'pino';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const makeWASocket = typeof makeWASocketImport === 'function' ? makeWASocketImport : (makeWASocketImport.default || makeWASocketImport);

const app = express();
const PORT = process.env.PORT || 3000;

let sock;
let qrCodeText = '';
let isConnected = false;
const messageHistory = [];

async function connectToWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
  
  sock = makeWASocket({
    logger: pino({ level: 'silent' }),
    printQRInTerminal: false,
    auth: state,
  });

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;
    if (qr) {
      qrCodeText = qr;
      console.log('--- QR CODE GENERATED ---');
    }
    if (connection === 'close') {
      const shouldReconnect = (lastDisconnect?.error instanceof Boom)?.output?.statusCode !== DisconnectReason.loggedOut;
      isConnected = false;
      if (shouldReconnect) connectToWhatsApp();
    } else if (connection === 'open') {
      isConnected = true;
      qrCodeText = '';
      console.log('WhatsApp Connected Successfully!');
    }
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('messages.upsert', async (m) => {
    const msg = m.messages[0];
    if (!msg.key.fromMe && m.type === 'notify') {
      const text = msg.message?.conversation || msg.message?.extendedTextMessage?.text || '';
      const sender = msg.key.remoteJid;
      const name = msg.pushName || 'Unknown';
      if (text) {
        messageHistory.push({ from: sender, name, text, time: new Date().toISOString() });
        if (messageHistory.length > 50) messageHistory.shift();
      }
    }
  });
}

connectToWhatsApp();

// דף אינטרנט שמציג את קוד ה-QR כתמונה נוחה לסריקה
app.get('/', (req, res) => {
  if (isConnected) {
    res.send(`
      <!DOCTYPE html>
      <html dir="rtl">
      <head><meta charset="utf-8"><title>סטטוס וואטסאפ</title></head>
      <body style="font-family:sans-serif;text-align:center;padding:50px;">
        <h1 style="color:#25D366;">וואטסאפ מחובר בהצלחה! 🎉</h1>
        <p style="font-size:18px;">השרת מוכן כעת לשימוש ב-Gemini Spark.</p>
      </body>
      </html>
    `);
  } else if (qrCodeText) {
    const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=350x350&data=${encodeURIComponent(qrCodeText)}`;
    res.send(`
      <!DOCTYPE html>
      <html dir="rtl">
      <head>
        <meta charset="utf-8">
        <title>סריקת קוד וואטסאפ</title>
        <meta http-equiv="refresh" content="15">
      </head>
      <body style="font-family:sans-serif;text-align:center;padding:40px;">
        <h2>סרוק את קוד ה-QR עם אפליקציית וואטסאפ</h2>
        <p style="color:#555;">פתח את וואטסאפ בטלפון/טאבלט > הגדרות > מכשירים מקושרים > קשר מכשיר</p>
        <div style="margin:20px 0;">
          <img src="${qrUrl}" alt="QR Code" style="border: 4px solid #25D366; border-radius: 12px; padding: 10px;" />
        </div>
        <p style="color:gray;font-size:13px;">העמוד מתרענן אוטומטית כל 15 שניות</p>
      </body>
      </html>
    `);
  } else {
    res.send(`
      <!DOCTYPE html>
      <html dir="rtl">
      <head><meta charset="utf-8"><meta http-equiv="refresh" content="3"><title>טוען...</title></head>
      <body style="font-family:sans-serif;text-align:center;padding:50px;">
        <h2>מייצר קוד QR, אנא המתן מספר שניות...</h2>
      </body>
      </html>
    `);
  }
});

// שרת MCP לחיבור עם Gemini Spark
const mcpServer = new Server({ name: 'whatsapp-mcp', version: '1.0.0' }, { capabilities: { tools: {} } });

mcpServer.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'get_recent_messages',
      description: 'שליפת ההודעות האחרונות שהתקבלו מלקוחות בוואטסאפ',
      inputSchema: {
        type: 'object',
        properties: { count: { type: 'number', description: 'כמות הודעות' } },
      },
    },
  ],
}));

mcpServer.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name === 'get_recent_messages') {
    const count = request.params.arguments?.count || 10;
    const messages = messageHistory.slice(-count);
    return {
      content: [{ type: 'text', text: JSON.stringify({ isConnected, messages }) }],
    };
  }
  throw new Error('Unknown tool');
});

let transport;
app.get('/mcp', async (req, res) => {
  transport = new SSEServerTransport('/messages', res);
  await mcpServer.connect(transport);
});

app.post('/messages', async (req, res) => {
  if (transport) await transport.handlePostMessage(req, res);
});

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});

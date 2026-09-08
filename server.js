import express from 'express';
import makeWASocketImport, { DisconnectReason, useMultiFileAuthState } from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import pino from 'pino';
import qrcode from 'qrcode-terminal';
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

// חיבור לוואטסאפ באמצעות Baileys
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
      console.log('--- QR CODE READY ---');
      qrcode.generate(qr, { small: true });
    }
    if (connection === 'close') {
      const shouldReconnect = (lastDisconnect?.error instanceof Boom)?.output?.statusCode !== DisconnectReason.loggedOut;
      isConnected = false;
      console.log('Connection closed, reconnecting:', shouldReconnect);
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

// שרת MCP עבור Gemini
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

app.get('/', (req, res) => {
  res.send(`Server is running! WhatsApp Status: ${isConnected ? 'Connected' : (qrCodeText ? 'Waiting for QR scan' : 'Connecting...')}`);
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

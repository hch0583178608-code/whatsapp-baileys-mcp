import express from 'express';
import { randomUUID } from 'node:crypto';
import makeWASocketImport, { DisconnectReason, useMultiFileAuthState } from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import pino from 'pino';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { isInitializeRequest, CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const makeWASocket = typeof makeWASocketImport === 'function' ? makeWASocketImport : (makeWASocketImport.default || makeWASocketImport);

const app = express();
const PORT = process.env.PORT || 3000;

// תמיכה ב-CORS עבור שרתי Google ו-Gemini
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, DELETE');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Access-Control-Expose-Headers', '*');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

app.use(express.json());

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

// עמוד הסטטוס / QR
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
      <head><meta charset="utf-8"><title>סריקת קוד וואטסאפ</title><meta http-equiv="refresh" content="15"></head>
      <body style="font-family:sans-serif;text-align:center;padding:40px;">
        <h2>סרוק את קוד ה-QR עם אפליקציית וואטסאפ</h2>
        <div style="margin:20px 0;"><img src="${qrUrl}" alt="QR Code" style="border:4px solid #25D366;border-radius:12px;padding:10px;" /></div>
      </body>
      </html>
    `);
  } else {
    res.send(`<h2 style="text-align:center;margin-top:50px;">מתחבר לוואטסאפ...</h2>`);
  }
});

// יצירת מופע שרת MCP
function createMcpServer() {
  const server = new Server(
    { name: 'whatsapp-mcp', version: '1.0.0' },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: 'get_recent_messages',
        description: 'שליפת ההודעות האחרונות שהתקבלו מלקוחות בוואטסאפ וסיכומן',
        inputSchema: {
          type: 'object',
          properties: { count: { type: 'number', description: 'כמות הודעות' } },
        },
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    if (request.params.name === 'get_recent_messages') {
      const count = request.params.arguments?.count || 10;
      const messages = messageHistory.slice(-count);
      return {
        content: [{ type: 'text', text: JSON.stringify({ isConnected, messages }) }],
      };
    }
    throw new Error('Unknown tool');
  });

  return server;
}

const streamableTransports = {};
const sseTransports = {};

// טיפול בבקשות POST מ-Gemini Spark (Streamable HTTP)
app.post('/mcp', async (req, res) => {
  const sessionId = req.headers['mcp-session-id'];
  let transport;

  if (sessionId && streamableTransports[sessionId]) {
    transport = streamableTransports[sessionId];
  } else if (!sessionId && isInitializeRequest(req.body)) {
    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (sid) => {
        streamableTransports[sid] = transport;
      },
      enableDnsRebindingProtection: false,
    });
    transport.onclose = () => {
      if (transport.sessionId) delete streamableTransports[transport.sessionId];
    };
    const server = createMcpServer();
    await server.connect(transport);
  } else {
    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      enableDnsRebindingProtection: false,
    });
    const server = createMcpServer();
    await server.connect(transport);
  }

  await transport.handleRequest(req, res, req.body);
});

// טיפול בבקשות GET מ-Gemini Spark
app.get('/mcp', async (req, res) => {
  const sessionId = req.headers['mcp-session-id'];
  if (sessionId && streamableTransports[sessionId]) {
    await streamableTransports[sessionId].handleRequest(req, res);
    return;
  }

  const sseTransport = new SSEServerTransport('/mcp/messages', res);
  sseTransports[sseTransport.sessionId] = sseTransport;
  sseTransport.onclose = () => {
    delete sseTransports[sseTransport.sessionId];
  };
  const server = createMcpServer();
  await server.connect(sseTransport);
});

app.post('/mcp/messages', async (req, res) => {
  const sessionId = req.query.sessionId;
  const transport = sseTransports[sessionId];
  if (transport) {
    await transport.handlePostMessage(req, res);
  } else {
    res.status(404).send('Session not found');
  }
});

app.delete('/mcp', async (req, res) => {
  const sessionId = req.headers['mcp-session-id'];
  if (sessionId && streamableTransports[sessionId]) {
    await streamableTransports[sessionId].handleRequest(req, res);
  } else {
    res.status(400).send('Invalid or missing session ID');
  }
});

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});

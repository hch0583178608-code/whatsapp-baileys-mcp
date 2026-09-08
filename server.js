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

// רשימת הקבוצות היחידות שמאושרות לשמירה (כל שאר הקבוצות מסוננות):
const ALLOWED_GROUPS = [
  'תכנה הפעלה חיה',
  'תוכנה הפעלה חיה',
  'מערכי שיעור חוג חיות',
  'פורום לעסקי חיות חרדיים/ דתיים',
  'פורום לעסקי חיות',
];

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, DELETE, HEAD');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Access-Control-Expose-Headers', '*');
  
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  if (req.method === 'HEAD') return res.status(200).end();
  next();
});

app.use(express.json());

let sock;
let qrCodeText = '';
let isConnected = false;
const messageHistory = [];
const groupNameCache = new Map();

// פונקציה לבדיקת שם הקבוצה
async function getGroupName(jid) {
  if (groupNameCache.has(jid)) return groupNameCache.get(jid);
  try {
    const meta = await sock.groupMetadata(jid);
    if (meta?.subject) {
      groupNameCache.set(jid, meta.subject);
      return meta.subject;
    }
  } catch (e) {}
  return '';
}

async function connectToWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
  
  sock = makeWASocket({
    logger: pino({ level: 'silent' }),
    printQRInTerminal: false,
    auth: state,
  });

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;
    if (qr) qrCodeText = qr;
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
      const sender = msg.key.remoteJid;
      const isGroup = sender.endsWith('@g.us');
      const text = msg.message?.conversation || msg.message?.extendedTextMessage?.text || '';
      let chatDisplayName = msg.pushName || 'לקוח';

      // סינון קבוצות:
      if (isGroup) {
        const groupTitle = await getGroupName(sender);
        const isAllowed = ALLOWED_GROUPS.some(allowed => groupTitle.includes(allowed));
        
        // אם זו קבוצה שלא ברשימה המאושרת (כמו קבוצות דרייברים) - זורקים אותה
        if (!isAllowed) {
          return;
        }
        chatDisplayName = `[קבוצה: ${groupTitle}] ${chatDisplayName}`;
      }

      if (text) {
        messageHistory.push({
          from: sender,
          name: chatDisplayName,
          text,
          time: new Date().toISOString(),
        });
        if (messageHistory.length > 50) messageHistory.shift();
      }
    }
  });
}

connectToWhatsApp();

app.get('/qr', (req, res) => {
  if (isConnected) {
    res.send('<h1 style="color:green;text-align:center;">וואטסאפ מחובר בהצלחה! 🎉</h1>');
  } else if (qrCodeText) {
    const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=350x350&data=${encodeURIComponent(qrCodeText)}`;
    res.send(`
      <div style="text-align:center;padding:30px;font-family:sans-serif;">
        <h2>סרוק את הקוד עם וואטסאפ</h2>
        <img src="${qrUrl}" style="border:4px solid #25D366;border-radius:10px;padding:10px;" />
      </div>
    `);
  } else {
    res.send('<h2 style="text-align:center;">טוען...</h2>');
  }
});

function createMcpServer() {
  const server = new Server(
    { name: 'whatsapp-mcp', version: '1.0.0' },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: 'get_recent_messages',
        description: 'שליפת הודעות מלקוחות פרטיים ומהקבוצות המורשות בלבד',
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

async function handleMcpPost(req, res) {
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
}

async function handleMcpGet(req, res) {
  const sessionId = req.headers['mcp-session-id'];
  if (sessionId && streamableTransports[sessionId]) {
    await streamableTransports[sessionId].handleRequest(req, res);
    return;
  }

  const host = req.get('host');
  const protocol = req.protocol;
  const endpointUrl = `${protocol}://${host}/mcp/messages`;

  const sseTransport = new SSEServerTransport(endpointUrl, res);
  sseTransports[sseTransport.sessionId] = sseTransport;
  sseTransport.onclose = () => {
    delete sseTransports[sseTransport.sessionId];
  };
  const server = createMcpServer();
  await server.connect(sseTransport);
}

app.post('/mcp', handleMcpPost);
app.get('/mcp', handleMcpGet);
app.post('/', handleMcpPost);
app.get('/', (req, res) => {
  if (req.headers.accept?.includes('text/event-stream')) {
    return handleMcpGet(req, res);
  }
  res.redirect('/qr');
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

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});

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

// רשימת הקבוצות המאושרות לשמירה ולקריאה בלבד (השליחה פתוחה לכל הקבוצות):
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
const messageHistory = []; // מאגר מוגדל של עד 200 הודעות
const groupNameCache = new Map();

// המרת מספר טלפון ישראלי/בינלאומי ל-JID תקין של וואטסאפ (תומך גם במזהי קבוצה @g.us)
function formatToJid(phone) {
  const trimmed = String(phone || '').trim();
  if (trimmed.endsWith('@g.us') || trimmed.endsWith('@s.whatsapp.net') || trimmed.endsWith('@lid')) {
    return trimmed;
  }
  let clean = trimmed.replace(/[^0-9]/g, '');
  if (clean.startsWith('0')) {
    clean = '972' + clean.slice(1);
  }
  return `${clean}@s.whatsapp.net`;
}

// בדיקת שם קבוצה
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

// שליפת כל הקבוצות (לשליחה ולחיפוש)
async function getAllGroups() {
  if (!sock || !isConnected) {
    throw new Error('וואטסאפ אינו מחובר כרגע. אנא ודא חיבור בשרת.');
  }
  const groupsMap = await sock.groupFetchAllParticipating();
  const result = [];
  for (const [jid, meta] of Object.entries(groupsMap || {})) {
    const subject = meta?.subject || '';
    if (subject) groupNameCache.set(jid, subject);
    result.push({
      jid,
      name: subject,
      participantsCount: Array.isArray(meta?.participants) ? meta.participants.length : undefined,
    });
  }
  return result;
}

// חילוץ תוכן טקסטואלי או סוג מדיה
function extractMessageContent(message) {
  if (!message) return '';
  if (message.conversation) return message.conversation;
  if (message.extendedTextMessage?.text) return message.extendedTextMessage.text;
  if (message.imageMessage) return `[תמונה${message.imageMessage.caption ? ': ' + message.imageMessage.caption : ''}]`;
  if (message.audioMessage) return '[הודעה קולית / הקלטה]';
  if (message.videoMessage) return `[סרטון${message.videoMessage.caption ? ': ' + message.videoMessage.caption : ''}]`;
  if (message.documentMessage) return `[מסמך: ${message.documentMessage.fileName || 'קובץ'}]`;
  if (message.locationMessage) return `[מיקום ששותף]`;
  if (message.contactMessage || message.contactsArrayMessage) return `[שיתוף איש קשר]`;
  if (message.stickerMessage) return `[מדבקה]`;
  return '[הודעה]';
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
    if (m.type === 'notify' && msg.message) {
      const sender = msg.key.remoteJid;
      const isGroup = sender.endsWith('@g.us');
      const isFromMe = msg.key.fromMe;
      let chatDisplayName = isFromMe ? '[אני]' : (msg.pushName || 'לקוח');

      // סינון קבוצות בקריאה ושמירה בלבד
      if (isGroup) {
        const groupTitle = await getGroupName(sender);
        const isAllowed = ALLOWED_GROUPS.some(allowed => groupTitle.includes(allowed));
        if (!isAllowed) return; // התעלמות מקבוצות שלא ברשימה המאושרת
        chatDisplayName = `[קבוצה: ${groupTitle}] ${chatDisplayName}`;
      }

      const content = extractMessageContent(msg.message);

      if (content) {
        messageHistory.push({
          from: sender,
          name: chatDisplayName,
          isFromMe,
          text: content,
          time: new Date().toISOString(),
        });
        if (messageHistory.length > 200) messageHistory.shift();
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

// שרת MCP מורחב עבור Gemini Spark
function createMcpServer() {
  const server = new Server(
    { name: 'whatsapp-mcp', version: '2.1.0' },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: 'get_recent_messages',
        description: 'שליפת הודעות מלקוחות ומהקבוצות המורשות. ניתן לסנן לפי מילת חיפוש או שם לקוח.',
        inputSchema: {
          type: 'object',
          properties: {
            count: { type: 'number', description: 'כמות הודעות לשליפה (ברירת מחדל 15)' },
            search: { type: 'string', description: 'סינון לפי מילת מפתח, שם לקוח או מספר טלפון (אופציונלי)' },
          },
        },
      },
      {
        name: 'send_whatsapp_message',
        description: 'שליחת הודעת וואטסאפ לכל מספר טלפון (חדש או קיים). מתאים גם למספרים שלא שמורים באנשי קשר.',
        inputSchema: {
          type: 'object',
          properties: {
            phone: { type: 'string', description: 'מספר טלפון של הנמען (למשל: 0501234567 או +972...)' },
            message: { type: 'string', description: 'תוכן ההודעה לשליחה' },
          },
          required: ['phone', 'message'],
        },
      },
      {
        name: 'list_active_chats',
        description: 'קבלת רשימה מרוכזת של כל הלקוחות והשיחות האחרונות שפנו אליך, כולל ההודעה האחרונה שלהם.',
        inputSchema: { type: 'object', properties: {} },
      },
      {
        name: 'list_groups',
        description: 'קבלת רשימת כל קבוצות הוואטסאפ, כולל שם הקבוצה והמזהה שלה.',
        inputSchema: { type: 'object', properties: {} },
      },
      {
        name: 'send_group_message',
        description: 'שליחת הודעת וואטסאפ לכל קבוצה (לפי שם קבוצה או מזהה קבוצה).',
        inputSchema: {
          type: 'object',
          properties: {
            group: { type: 'string', description: 'שם הקבוצה (או חלק ממנו) או מזהה הקבוצה (@g.us)' },
            message: { type: 'string', description: 'תוכן ההודעה לשליחה' },
          },
          required: ['group', 'message'],
        },
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    // 1. שליפת הודעות אחרונות
    if (name === 'get_recent_messages') {
      const count = args?.count || 15;
      const search = args?.search?.toLowerCase();
      let filtered = messageHistory;
      if (search) {
        filtered = filtered.filter(m =>
          m.text.toLowerCase().includes(search) ||
          m.name.toLowerCase().includes(search) ||
          m.from.includes(search)
        );
      }
      return {
        content: [{ type: 'text', text: JSON.stringify({ isConnected, messages: filtered.slice(-count) }) }],
      };
    }

    // 2. שליחת הודעה
    if (name === 'send_whatsapp_message') {
      if (!sock || !isConnected) {
        throw new Error('וואטסאפ אינו מחובר כרגע. אנא ודא חיבור בשרת.');
      }
      const targetJid = formatToJid(args.phone);
      await sock.sendMessage(targetJid, { text: args.message });
      return {
        content: [{ type: 'text', text: `ההודעה נשלחה בהצלחה אל ${args.phone}!` }],
      };
    }

    // 3. רשימת לקוחות ושיחות פעילות
    if (name === 'list_active_chats') {
      const chatsMap = new Map();
      for (const m of messageHistory) {
        chatsMap.set(m.from, {
          from: m.from,
          name: m.name,
          lastMessage: m.text,
          lastTime: m.time,
        });
      }
      return {
        content: [{ type: 'text', text: JSON.stringify(Array.from(chatsMap.values())) }],
      };
    }

    // 4. רשימת כל הקבוצות
    if (name === 'list_groups') {
      const groups = await getAllGroups();
      return {
        content: [{ type: 'text', text: JSON.stringify({ isConnected, groups }) }],
      };
    }

    // 5. שליחת הודעה לכל קבוצה
    if (name === 'send_group_message') {
      const groups = await getAllGroups();
      const query = String(args.group || '').trim();
      const target = query.endsWith('@g.us')
        ? groups.find(g => g.jid === query)
        : groups.find(g => g.name.toLowerCase().includes(query.toLowerCase()));

      if (!target) {
        throw new Error(`לא נמצאה קבוצה התואמת ל-"${query}".`);
      }

      await sock.sendMessage(target.jid, { text: args.message });
      return {
        content: [{ type: 'text', text: `ההודעה נשלחה בהצלחה לקבוצה "${target.name}"!` }],
      };
    }

    throw new Error(`כלי לא מוכר: ${name}`);
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

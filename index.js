// index.js (estratto modificato)

const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const twilio = require('twilio');
const admin = require('firebase-admin');
const https = require('https');
require('dotenv').config();

const app = express();
const port = process.env.PORT || 3000;

const serviceAccount = JSON.parse(process.env.FIREBASE_CONFIG);
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: 'https://aste-florio-default-rtdb.europe-west1.firebasedatabase.app'
});
const db = admin.database();

// Gestione client collegati via Server-Sent Events (SSE)
const sseClients = new Set();

function broadcastEvent(payload) {
  if (!payload) return;
  const data = `data: ${JSON.stringify(payload)}\n\n`;
  for (const client of sseClients) {
    try {
      client.res.write(data);
    } catch (err) {
      console.error('❌ Errore invio SSE:', err);
      client.res.end();
      clearInterval(client.heartbeat);
      sseClients.delete(client);
    }
  }
}

const TWILIO_ACCOUNT_SID = process.env.TWILIO_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH;
const TWILIO_MEDIA_REGION = process.env.TWILIO_MEDIA_REGION || 'us1';

function stripWhatsappPrefix(raw) {
  if (!raw) return '';
  let value = String(raw).trim();
  if (value.toLowerCase().startsWith('whatsapp:')) {
    value = value.slice('whatsapp:'.length);
  }
  return value.trim();
}

function normalizePhone(raw) {
  let value = stripWhatsappPrefix(raw);
  if (!value) return '';
  value = value.replace(/\s+/g, '');
  if (!value) return '';
  if (value.startsWith('+')) {
    return '+' + value.slice(1).replace(/[^0-9]/g, '');
  }
  if (value.startsWith('00')) {
    return '+' + value.slice(2).replace(/[^0-9]/g, '');
  }
  const digits = value.replace(/\D/g, '');
  if (!digits) return '';
  if (digits.startsWith('39')) return '+' + digits;
  return '+39' + digits;
}

function buildWhatsappAddress(raw) {
  const normalized = normalizePhone(raw);
  if (!normalized) return '';
  return `whatsapp:${normalized}`;
}

function safeJsonParse(payload, fallback = null) {
  try {
    if (typeof payload === 'string') {
      return JSON.parse(payload);
    }
    return typeof payload === 'object' ? payload : fallback;
  } catch (err) {
    return fallback;
  }
}

function extractMediaInfo(url) {
  if (!url) return { messageSid: null, mediaSid: null };
  try {
    const parsed = new URL(url);
    const match = parsed.pathname.match(/\/Messages\/([^/]+)\/Media\/([^/.]+)/i);
    if (match) {
      return { messageSid: match[1], mediaSid: match[2] };
    }
  } catch (err) {
    return { messageSid: null, mediaSid: null };
  }
  return { messageSid: null, mediaSid: null };
}

function proxyTwilioMedia(url, res) {
  return new Promise((resolve, reject) => {
    if (!url || !TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN) {
      reject(new Error('Twilio credentials mancanti o URL non valido'));
      return;
    }

    const parsed = new URL(url);
    const options = {
      protocol: parsed.protocol,
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      auth: `${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`,
      method: 'GET'
    };

    const request = https.request(options, response => {
      if (response.statusCode >= 400) {
        reject(new Error(`Twilio media response ${response.statusCode}`));
        response.resume();
        return;
      }

      if (response.headers['content-type']) {
        res.setHeader('Content-Type', response.headers['content-type']);
      }
      if (response.headers['content-length']) {
        res.setHeader('Content-Length', response.headers['content-length']);
      }

      response.pipe(res);
      response.on('end', resolve);
    });

    request.on('error', reject);
    request.end();
  });
}

// Trova o crea una conversazione dato un phoneKey (+39...)
async function getOrCreateConversationId(phoneKey) {
  if (!phoneKey) return null;

  const byPhoneRef = db.ref('conversationsByPhone').child(phoneKey);
  let generatedId = null;

  const txnResult = await byPhoneRef.transaction(current => {
    if (current) return current;
    generatedId = db.ref('conversationSummaries').push().key;
    return generatedId;
  });

  const conversationId = txnResult.snapshot?.val();
  if (!conversationId) return null;

  if (txnResult.committed && generatedId) {
    const now = Date.now();
    await db.ref('conversationSummaries').child(conversationId).set({
      phone: phoneKey,
      lastMessageText: '',
      lastMessageAt: now,
      unreadCount: 0
    });
  }

  return conversationId;
}

// Aggiorna il riepilogo di una conversazione restituendo lo stato aggiornato
async function updateConversationSummary(conversationId, { phone, text, timestamp, incrementUnread }) {
  if (!conversationId || !timestamp) return null;
  const summaryRef = db.ref('conversationSummaries').child(conversationId);

  const result = await summaryRef.transaction(current => {
    const curr = current || {};
    const unread = (curr.unreadCount || 0) + (incrementUnread ? 1 : 0);
    return {
      phone: phone || curr.phone || '',
      lastMessageText: text || curr.lastMessageText || '',
      lastMessageAt: timestamp,
      unreadCount: unread
    };
  });

  return result.snapshot?.val() || null;
}

const client = twilio(process.env.TWILIO_SID, process.env.TWILIO_AUTH);

app.use(cors());
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());
app.use(express.static('public'));

// Disabilita header inutili per un micro-backend più "snello"
app.disable('x-powered-by');

async function saveMessageStatus(conversationId, sid, payload = {}) {
  if (!conversationId || !sid) return;
  const statusRef = db.ref('messageStatuses').child(conversationId).child(sid);
  await statusRef.update({
    sid,
    timestamp: Date.now(),
    ...payload
  });
}

async function linkSidToConversation(sid, conversationId, messageId) {
  if (!sid || !conversationId) return;
  await db.ref('sidToConversation').child(sid).set({ conversationId, messageId: messageId || null });
}

// Endpoint SSE per notificare nuovi messaggi alla dashboard
app.get('/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  if (res.flushHeaders) res.flushHeaders();

  res.write('retry: 5000\n\n');

  const client = {
    res,
    heartbeat: setInterval(() => {
      res.write(': ping\n\n');
    }, 25000)
  };

  sseClients.add(client);

  req.on('close', () => {
    clearInterval(client.heartbeat);
    sseClients.delete(client);
  });
});

// Webhook Twilio
app.post('/webhook', async (req, res) => {
  const eventType = req.body.EventType || req.body.eventType || null;
  let from = req.body.From || req.body.from || req.body.Author;
  const to = req.body.To || req.body.to || req.body.Recipient || req.body.ChannelToAddress || 'unknown';
  let body = req.body.Body || req.body.body || '';
  const timestamp = Date.now();
  const inboundSid = req.body.MessageSid || req.body.SmsSid || req.body.SmsMessageSid || null;
  const serviceSid = req.body.ChatServiceSid || req.body.MessagingServiceSid || null;
  const conversationSid = req.body.ConversationSid || null;

  const media = [];
  const parsedNum = parseInt(req.body.NumMedia || '0', 10);

  if (eventType === 'onMessageAdded') {
    from = req.body.Author || from;
    body = req.body.Body || body || '';
    const mediaList = safeJsonParse(req.body.Media, []);
    if (Array.isArray(mediaList)) {
      mediaList.forEach(item => {
        const mediaSid = item.Sid || item.sid || null;
        const proxyPath = mediaSid && serviceSid
          ? `/media/conversations/${serviceSid}/${mediaSid}`
          : null;
        media.push({
          sid: mediaSid,
          filename: item.Filename || null,
          contentType: item.ContentType || null,
          size: item.Size || null,
          serviceSid,
          conversationSid,
          proxyUrl: proxyPath,
          type: 'conversation'
        });
      });
    }
  } else if (parsedNum > 0) {
    for (let i = 0; i < parsedNum; i++) {
      const mediaUrl = req.body[`MediaUrl${i}`];
      const mediaType = req.body[`MediaContentType${i}`];
      if (!mediaUrl) continue;
      const { messageSid: urlMessageSid, mediaSid } = extractMediaInfo(mediaUrl);
      const resolvedMessageSid = urlMessageSid || inboundSid;
      const proxyPath = mediaSid && resolvedMessageSid
        ? `/media/messages/${resolvedMessageSid}/${mediaSid}`
        : null;
      media.push({
        sid: mediaSid || null,
        messageSid: resolvedMessageSid || null,
        originalUrl: mediaUrl,
        proxyUrl: proxyPath || mediaUrl,
        contentType: mediaType || null,
        type: 'message'
      });
    }
  }

  if (!from || (!body && media.length === 0)) {
    console.error('❌ Webhook con dati incompleti:', req.body);
    return res.sendStatus(400);
  }

  console.log('✅ Messaggio ricevuto:', { from, to, body, mediaCount: media.length, eventType });

  const phoneKey = normalizePhone(from);
  if (!phoneKey) {
    console.error('❌ Impossibile normalizzare il numero mittente:', from);
    return res.sendStatus(400);
  }

  const conversationId = await getOrCreateConversationId(phoneKey);
  const msgRef = db.ref('conversationMessages').child(conversationId).push();
  const messageId = msgRef.key;
  const textContent = body || (media.length ? '[media]' : '');

  await msgRef.set({
    text: textContent,
    direction: 'inbound',
    timestamp,
    media,
    sid: inboundSid || null
  });

  const summary = await updateConversationSummary(conversationId, {
    phone: phoneKey,
    text: textContent,
    timestamp,
    incrementUnread: true
  });

  broadcastEvent({
    type: 'message',
    conversationId,
    phone: phoneKey,
    summary,
    message: {
      id: messageId,
      text: textContent,
      direction: 'inbound',
      timestamp,
      media,
      sid: inboundSid || null
    }
  });

  res.sendStatus(200);
});

// ✅ Endpoint per ricevere gli aggiornamenti di stato da Twilio
app.post('/status', async (req, res) => {
  try {
    const {
      MessageSid,
      MessageStatus,
      To,
      ErrorCode,
      ErrorMessage
    } = req.body;

    console.log("📬 Twilio Status Callback:", req.body);

    const sidInfoSnap = await db.ref('sidToConversation').child(MessageSid).once('value');
    const sidInfo = sidInfoSnap.val();

    await db.ref('logs/status').push({
      sid: MessageSid,
      status: MessageStatus,
      to: To,
      errorCode: ErrorCode || null,
      errorMessage: ErrorMessage || null,
      timestamp: Date.now()
    });

    if (sidInfo && sidInfo.conversationId) {
      await saveMessageStatus(sidInfo.conversationId, MessageSid, {
        status: MessageStatus,
        errorCode: ErrorCode || null,
        errorMessage: ErrorMessage || null
      });

      if (sidInfo.messageId) {
        await db.ref('conversationMessages')
          .child(sidInfo.conversationId)
          .child(sidInfo.messageId)
          .child('status')
          .set(MessageStatus);
      }

      broadcastEvent({
        type: 'status',
        conversationId: sidInfo.conversationId,
        sid: MessageSid,
        status: MessageStatus,
        errorCode: ErrorCode || null,
        errorMessage: ErrorMessage || null,
        timestamp: Date.now()
      });
    }

    res.sendStatus(200);
  } catch (err) {
    console.error("❌ Errore nella status callback:", err);
    res.sendStatus(500);
  }
});

// Invia risposta
app.post('/send', async (req, res) => {
  const { to, body, conversationId: clientConversationId } = req.body;

  const normalizedRecipient = normalizePhone(to);
  if (!normalizedRecipient) {
    return res.status(400).json({ error: 'Numero destinatario non valido' });
  }

  const fromEnv = process.env.TWILIO_NUMBER || process.env.TWILIO_FROM || '';
  const fromAddress = fromEnv.startsWith('whatsapp:') ? fromEnv : buildWhatsappAddress(fromEnv);
  const toAddress = buildWhatsappAddress(normalizedRecipient);

  if (!fromAddress || !toAddress) {
    return res.status(500).json({ error: 'Configurazione WhatsApp non valida' });
  }

  try {
    const timestamp = Date.now();
    const phoneKey = normalizedRecipient;
    const conversationId = clientConversationId || await getOrCreateConversationId(phoneKey);

    const twilioMessage = await client.messages.create({
      from: fromAddress,
      to: toAddress,
      body
    });

    const msgRef = db.ref('conversationMessages').child(conversationId).push();
    const messageId = msgRef.key;
    await msgRef.set({
      text: body,
      direction: 'outbound',
      timestamp,
      sid: twilioMessage.sid
    });

    await saveMessageStatus(conversationId, twilioMessage.sid, {
      status: twilioMessage.status || 'queued'
    });
    await linkSidToConversation(twilioMessage.sid, conversationId, messageId);

    const summary = await updateConversationSummary(conversationId, {
      phone: phoneKey,
      text: body,
      timestamp,
      incrementUnread: false
    });

    const responsePayload = {
      conversationId,
      messageId,
      sid: twilioMessage.sid,
      status: twilioMessage.status || 'queued',
      phone: phoneKey
    };

    broadcastEvent({
      type: 'message',
      conversationId,
      phone: phoneKey,
      summary,
      message: {
        id: messageId,
        text: body,
        direction: 'outbound',
        timestamp,
        sid: twilioMessage.sid
      }
    });

    res.json(responsePayload);
  } catch (e) {
    console.error('❌ Errore /send:', e);
    res.status(500).json({ error: e.message || 'Errore invio' });
  }
});

// Ritorna l'elenco delle conversazioni (riepilogo)
app.get('/conversations', async (req, res) => {
  try {
    const snap = await db.ref('conversationSummaries').orderByChild('lastMessageAt').limitToLast(200).once('value');
    const data = snap.val() || {};
    const list = Object.keys(data).map(id => ({ id, ...data[id] }))
      .sort((a, b) => (b.lastMessageAt || 0) - (a.lastMessageAt || 0));
    res.json(list);
  } catch (err) {
    console.error('Errore /conversations:', err);
    res.status(500).send('Errore lettura conversazioni');
  }
});

// Ritorna tutti i messaggi di una singola conversazione
app.get('/conversation-messages', async (req, res) => {
  const conversationId = req.query.id;
  if (!conversationId) return res.sendStatus(400);

  try {
    const snap = await db.ref('conversationMessages').child(conversationId).once('value');
    const data = snap.val() || {};
    const list = Object.keys(data).map(id => ({ id, ...data[id] }))
      .sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
    res.json(list);
  } catch (err) {
    console.error('Errore /conversation-messages:', err);
    res.status(500).send('Errore lettura messaggi');
  }
});

app.get('/message-status', async (req, res) => {
  const conversationId = req.query.conversationId;
  if (!conversationId) return res.sendStatus(400);

  try {
    const snap = await db.ref('messageStatuses').child(conversationId).limitToLast(500).once('value');
    res.json(snap.val() || {});
  } catch (err) {
    console.error('Errore /message-status:', err);
    res.status(500).send('Errore lettura status messaggi');
  }
});

app.get('/message-status-by-sid', async (req, res) => {
  const sid = req.query.sid;
  if (!sid) return res.sendStatus(400);

  try {
    const mappingSnap = await db.ref('sidToConversation').child(sid).once('value');
    const mapping = mappingSnap.val();
    if (!mapping || !mapping.conversationId) {
      return res.json({ status: null, payload: null });
    }

    const statusSnap = await db.ref('messageStatuses').child(mapping.conversationId).child(sid).once('value');
    const payload = statusSnap.val() || null;
    res.json({
      conversationId: mapping.conversationId,
      messageId: mapping.messageId || null,
      status: payload ? payload.status || null : null,
      payload
    });
  } catch (err) {
    console.error('Errore /message-status-by-sid:', err);
    res.status(500).send('Errore lettura status');
  }
});

// Espone i log di stato Twilio per la UI
app.get('/logs/status', async (req, res) => {
  try {
    const snap = await db.ref('logs/status').limitToLast(1000).once('value');
    res.json(snap.val() || {});
  } catch (err) {
    console.error('Errore /logs/status:', err);
    res.status(500).send('Errore lettura status');
  }
});

// Cancella tutti i messaggi di una chat per numero
app.post('/read', async (req, res) => {
  const { conversationId } = req.body;
  if (!conversationId) return res.sendStatus(400);

  await db.ref('conversationSummaries').child(conversationId).child('unreadCount').set(0);
  const summarySnap = await db.ref('conversationSummaries').child(conversationId).once('value');
  broadcastEvent({
    type: 'summary',
    conversationId,
    summary: summarySnap.val() || null
  });
  res.sendStatus(200);
});

app.post('/mark-unread', async (req, res) => {
  const { conversationId, unreadCount } = req.body || {};
  if (!conversationId) return res.sendStatus(400);

  const count = Number.isFinite(unreadCount) ? Math.max(1, unreadCount) : 1;

  try {
    await db.ref('conversationSummaries').child(conversationId).child('unreadCount').set(count);
    const summarySnap = await db.ref('conversationSummaries').child(conversationId).once('value');
    broadcastEvent({
      type: 'summary',
      conversationId,
      summary: summarySnap.val() || null
    });
    res.sendStatus(200);
  } catch (err) {
    console.error('Errore /mark-unread:', err);
    res.status(500).send('Errore aggiornamento stato');
  }
});

app.post('/delete-chat', async (req, res) => {
  const { conversationId } = req.body;
  if (!conversationId) return res.sendStatus(400);

  try {
    const summarySnap = await db.ref('conversationSummaries').child(conversationId).once('value');
    const summary = summarySnap.val();

    if (summary && summary.phone) {
      await db.ref('conversationsByPhone').child(summary.phone).remove();
    }

    await db.ref('conversationMessages').child(conversationId).remove();
    await db.ref('conversationSummaries').child(conversationId).remove();

    res.sendStatus(200);
  } catch (err) {
    console.error('Errore /delete-chat:', err);
    res.status(500).send('Errore cancellazione chat');
  }
});

app.get('/media/messages/:messageSid/:mediaSid', async (req, res) => {
  const { messageSid, mediaSid } = req.params;
  if (!messageSid || !mediaSid) return res.sendStatus(400);

  const mediaUrl = `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Messages/${messageSid}/Media/${mediaSid}`;
  try {
    await proxyTwilioMedia(mediaUrl, res);
  } catch (err) {
    console.error('❌ Errore fetch media messaggio:', err.message);
    if (!res.headersSent) res.sendStatus(502);
  }
});

app.get('/media/conversations/:serviceSid/:mediaSid', async (req, res) => {
  const { serviceSid, mediaSid } = req.params;
  if (!serviceSid || !mediaSid) return res.sendStatus(400);

  const mediaUrl = `https://mcs.${TWILIO_MEDIA_REGION}.twilio.com/v1/Services/${serviceSid}/Media/${mediaSid}/Content`;
  try {
    await proxyTwilioMedia(mediaUrl, res);
  } catch (err) {
    console.error('❌ Errore fetch media conversation:', err.message);
    if (!res.headersSent) res.sendStatus(502);
  }
});

app.listen(port, () => {
  console.log(`🚀 Server online sulla porta ${port}`);
});

// index.js (estratto modificato)

const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const twilio = require('twilio');
const admin = require('firebase-admin');
require('dotenv').config();

const app = express();
const port = process.env.PORT || 3000;

const serviceAccount = JSON.parse(process.env.FIREBASE_CONFIG);
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: 'https://aste-florio-default-rtdb.europe-west1.firebasedatabase.app'
});
const db = admin.database();

// Normalizza il numero in forma +39... togliendo l'eventuale prefisso whatsapp:
function normalizePhone(raw) {
  if (!raw) return '';
  let p = String(raw).trim();
  if (p.startsWith('whatsapp:')) p = p.replace('whatsapp:', '');
  return p;
}

// Trova o crea una conversazione dato un phoneKey (+39...)
async function getOrCreateConversationId(phoneKey) {
  if (!phoneKey) return null;

  const byPhoneRef = db.ref('conversationsByPhone').child(phoneKey);
  const snap = await byPhoneRef.once('value');
  if (snap.exists()) {
    return snap.val();
  }

  const convRef = db.ref('conversationSummaries').push();
  const conversationId = convRef.key;
  const now = Date.now();

  await convRef.set({
    phone: phoneKey,
    lastMessageText: '',
    lastMessageAt: now,
    unreadCount: 0
  });

  await byPhoneRef.set(conversationId);
  return conversationId;
}

// Aggiorna il riepilogo di una conversazione
async function updateConversationSummary(conversationId, { phone, text, timestamp, incrementUnread }) {
  if (!conversationId || !timestamp) return;
  const summaryRef = db.ref('conversationSummaries').child(conversationId);

  await summaryRef.transaction(current => {
    const curr = current || {};
    const unread = (curr.unreadCount || 0) + (incrementUnread ? 1 : 0);
    return {
      phone: phone || curr.phone || '',
      lastMessageText: text || curr.lastMessageText || '',
      lastMessageAt: timestamp,
      unreadCount: unread
    };
  });
}

const client = twilio(process.env.TWILIO_SID, process.env.TWILIO_AUTH);

app.use(cors());
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());
app.use(express.static('public'));

// Disabilita header inutili per un micro-backend più "snello"
app.disable('x-powered-by');

// Webhook Twilio
app.post('/webhook', async (req, res) => {
  const from = req.body.From || req.body.from || req.body.Author;
  const to = req.body.To || req.body.to || req.body.Recipient || 'unknown';
  const body = req.body.Body || req.body.body || '';
  const timestamp = Date.now();

  const numMedia = parseInt(req.body.NumMedia || '0');
  const media = [];

  for (let i = 0; i < numMedia; i++) {
    const mediaUrl = req.body[`MediaUrl${i}`];
    const mediaType = req.body[`MediaContentType${i}`];
    if (mediaUrl && mediaType) {
      media.push({
        url: mediaUrl,
        type: mediaType
      });
    }
  }

  if (!from || (!body && media.length === 0)) {
    console.error('❌ Webhook con dati incompleti:', req.body);
    return res.sendStatus(400);
  }

  console.log('✅ Messaggio ricevuto:', { from, to, body, media });

  const phoneKey = normalizePhone(from);
  const conversationId = await getOrCreateConversationId(phoneKey);

  const msgRef = db.ref('conversationMessages').child(conversationId).push();
  await msgRef.set({
    text: body || (media.length ? '[media]' : ''),
    direction: 'in',
    timestamp,
    media
  });

  await updateConversationSummary(conversationId, {
    phone: phoneKey,
    text: body || (media.length ? '[media]' : ''),
    timestamp,
    incrementUnread: true
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

    await db.ref('logs/status').push({
      sid: MessageSid,
      status: MessageStatus,
      to: To,
      errorCode: ErrorCode || null,
      errorMessage: ErrorMessage || null,
      timestamp: Date.now()
    });

    res.sendStatus(200);
  } catch (err) {
    console.error("❌ Errore nella status callback:", err);
    res.sendStatus(500);
  }
});

// Invia risposta
app.post('/send', async (req, res) => {
  const { to, body, conversationId: clientConversationId } = req.body;
  try {
    const twilioMessage = await client.messages.create({
      from: `whatsapp:${process.env.TWILIO_NUMBER}`,
      to: `whatsapp:${to}`,
      body
    });

    const timestamp = Date.now();
    const phoneKey = normalizePhone(to);
    const conversationId = clientConversationId || await getOrCreateConversationId(phoneKey);

    const msgRef = db.ref('conversationMessages').child(conversationId).push();
    await msgRef.set({
      text: body,
      direction: 'out',
      timestamp,
      sid: twilioMessage.sid
    });

    await updateConversationSummary(conversationId, {
      phone: phoneKey,
      text: body,
      timestamp,
      incrementUnread: false
    });

    res.sendStatus(200);
  } catch (e) {
    res.status(500).send('Errore invio');
  }
});

// Aggiorna stato lettura di una conversazione
app.post('/read', async (req, res) => {
  const { conversationId } = req.body;
  if (!conversationId) return res.sendStatus(400);

  await db.ref('conversationSummaries').child(conversationId).child('unreadCount').set(0);
  res.sendStatus(200);
});

app.listen(port, () => {
  console.log(`🚀 Server online sulla porta ${port}`);
});

// Cancella tutti i messaggi di una conversazione
app.post('/delete-chat', async (req, res) => {
  const { conversationId } = req.body;
  try {
    if (!conversationId) return res.sendStatus(400);

    const summarySnap = await db.ref('conversationSummaries').child(conversationId).once('value');
    const summary = summarySnap.val();

    if (summary && summary.phone) {
      await db.ref('conversationsByPhone').child(summary.phone).remove();
    }

    await db.ref('conversationMessages').child(conversationId).remove();
    await db.ref('conversationSummaries').child(conversationId).remove();
    res.sendStatus(200);
  } catch (err) {
    console.error('Errore durante la cancellazione:', err);
    res.status(500).send('Errore cancellazione');
  }
});

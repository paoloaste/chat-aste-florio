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

const hasTwilioCredentials =
  process.env.TWILIO_SID &&
  process.env.TWILIO_AUTH &&
  String(process.env.TWILIO_SID).startsWith('AC');

const client = hasTwilioCredentials
  ? twilio(process.env.TWILIO_SID, process.env.TWILIO_AUTH)
  : null;

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
    direction: 'inbound',
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
    const timestamp = Date.now();
    const phoneKey = normalizePhone(to);
    const conversationId = clientConversationId || await getOrCreateConversationId(phoneKey);

    let sid = null;

    if (client && hasTwilioCredentials) {
      // Produzione: invio reale tramite Twilio
      const twilioMessage = await client.messages.create({
        from: `whatsapp:${process.env.TWILIO_NUMBER}`,
        to: `whatsapp:${to}`,
        body
      });
      sid = twilioMessage.sid;
    } else {
      // Sviluppo / locale: niente Twilio, ma scriviamo comunque su Firebase
      sid = `local-${Date.now()}`;
      console.log('⚠️ Twilio non configurato: salvo solo su Firebase', { to, body });
    }

    const msgRef = db.ref('conversationMessages').child(conversationId).push();
    await msgRef.set({
      text: body,
      direction: 'outbound',
      timestamp,
      sid
    });

    await updateConversationSummary(conversationId, {
      phone: phoneKey,
      text: body,
      timestamp,
      incrementUnread: false
    });

    res.sendStatus(200);
  } catch (e) {
    console.error('❌ Errore /send:', e);
    res.status(500).send('Errore invio');
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
  res.sendStatus(200);
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

app.listen(port, () => {
  console.log(`🚀 Server online sulla porta ${port}`);
});

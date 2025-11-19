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

// Normalizza il numero togliendo l'eventuale prefisso whatsapp:
function normalizePhone(raw) {
  if (!raw) return '';
  let p = String(raw).trim();
  if (p.startsWith('whatsapp:')) p = p.replace('whatsapp:', '');
  return p;
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

  const msgRef = db.ref('messages').push();
  await msgRef.set({
    body: body || (media.length ? '[media]' : ''),
    direction: 'inbound',
    from: from,
    to: to,
    timestamp,
    media
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
  const { to, body } = req.body;
  try {
    const twilioMessage = await client.messages.create({
      from: `whatsapp:${process.env.TWILIO_NUMBER}`,
      to: `whatsapp:${to}`,
      body
    });

    const timestamp = Date.now();

    const msgRef = db.ref('messages').push();
    await msgRef.set({
      body,
      direction: 'outbound',
      from: 'azienda',
      to: `whatsapp:${to}`,
      timestamp,
      sid: twilioMessage.sid
    });

    res.sendStatus(200);
  } catch (e) {
    res.status(500).send('Errore invio');
  }
});

app.listen(port, () => {
  console.log(`🚀 Server online sulla porta ${port}`);
});

// Ritorna l'elenco delle ultime conversazioni (ultimo messaggio per numero)
app.get('/conversations', async (req, res) => {
  try {
    const snap = await db.ref('messages').orderByChild('timestamp').limitToLast(500).once('value');
    const conversationsMap = {};

    snap.forEach(child => {
      const m = child.val();
      const phoneRaw = m.direction === 'inbound' ? m.from : m.to;
      const phoneKey = normalizePhone(phoneRaw);
      if (!phoneKey) return;

      if (!conversationsMap[phoneKey] || m.timestamp > conversationsMap[phoneKey].lastMessageAt) {
        conversationsMap[phoneKey] = {
          phone: phoneKey,
          lastMessageText: m.body || '[media]',
          lastMessageAt: m.timestamp,
          lastDirection: m.direction
        };
      }
    });

    const list = Object.values(conversationsMap)
      .sort((a, b) => b.lastMessageAt - a.lastMessageAt)
      .slice(0, 50);

    res.json(list);
  } catch (err) {
    console.error('Errore /conversations:', err);
    res.status(500).send('Errore lettura conversazioni');
  }
});

// Ritorna tutti i messaggi di una singola chat (per numero normalizzato)
app.get('/messages-by-number', async (req, res) => {
  const phone = req.query.phone;
  if (!phone) return res.sendStatus(400);

  const phoneKey = normalizePhone(phone);
  try {
    const snap = await db.ref('messages').orderByChild('timestamp').once('value');
    const messages = [];
    snap.forEach(child => {
      const m = child.val();
      const phoneRaw = m.direction === 'inbound' ? m.from : m.to;
      const p = normalizePhone(phoneRaw);
      if (p === phoneKey) {
        messages.push({ id: child.key, ...m });
      }
    });

    messages.sort((a, b) => a.timestamp - b.timestamp);
    res.json(messages);
  } catch (err) {
    console.error('Errore /messages-by-number:', err);
    res.status(500).send('Errore lettura messaggi');
  }
});

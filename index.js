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

const client = twilio(process.env.TWILIO_SID, process.env.TWILIO_AUTH);

app.use(cors());
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());
app.use(express.static('public'));

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

  const ref = db.ref('messages').push();
  await ref.set({
    from,
    to,
    body,
    media, // 🎯 questo deve essere presente!
    direction: 'inbound',
    timestamp
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
    await client.messages.create({
      from: `whatsapp:${process.env.TWILIO_NUMBER}`,
      to: `whatsapp:${to}`,
      body
    });

    await db.ref('messages').push({
      from: 'me', to: `whatsapp:${to}`, body,
      direction: 'outbound', timestamp: Date.now()
    });

    res.sendStatus(200);
  } catch (e) {
    res.status(500).send('Errore invio');
  }
});

// Aggiorna stato lettura
app.post('/read', async (req, res) => {
  const { number } = req.body;
  await db.ref('readStatus/' + number).set(Date.now());
  res.sendStatus(200);
});

app.listen(port, () => {
  console.log(`🚀 Server online sulla porta ${port}`);
});

// Cancella tutti i messaggi di una chat
app.post('/delete-chat', async (req, res) => {
  const { number } = req.body;
  try {
    const snapshot = await db.ref('messages').once('value');
    const messages = snapshot.val();
    const updates = {};

    for (let id in messages) {
      const m = messages[id];
      const phone = m.direction === 'inbound'
        ? m.from.replace('whatsapp:', '')
        : m.to.replace('whatsapp:', '');

      if (phone === number) {
        updates[`/messages/${id}`] = null;
      }
    }

    await db.ref().update(updates);
    await db.ref('readStatus/' + number).remove(); // opzionale: resetta lo stato lettura
    res.sendStatus(200);
  } catch (err) {
    console.error('Errore durante la cancellazione:', err);
    res.status(500).send('Errore cancellazione');
  }
});

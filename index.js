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

  if (!from || !body) {
    console.error('Webhook ricevuto con dati incompleti:', req.body);
    return res.sendStatus(400);
  }

  const ref = db.ref('messages').push();
  await ref.set({ from, to, body, direction: 'inbound', timestamp });

  res.sendStatus(200);
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

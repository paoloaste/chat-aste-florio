// index.js (estratto modificato)

const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const twilio = require('twilio');
const admin = require('firebase-admin');
require('dotenv').config();

const app = express();
const port = process.env.PORT || 3000;

const serviceAccount = require('./firebase-config.json');
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
  const to = req.body.To || req.body.to;
  const body = req.body.Body || req.body.body;
  const timestamp = Date.now();

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

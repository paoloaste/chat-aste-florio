// 📁 index.js
const express = require('express');
const bodyParser = require('body-parser');
const admin = require('firebase-admin');
const cors = require('cors');
const twilio = require('twilio');
require('dotenv').config();

const app = express();
const port = process.env.PORT || 3000;

// Init Firebase
const serviceAccount = require('./firebase-config.json');
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: `https://${serviceAccount.project_id}.firebaseio.com`,
});
const db = admin.database();

// Init Twilio
const client = twilio(process.env.TWILIO_SID, process.env.TWILIO_AUTH);

app.use(cors());
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());
app.use(express.static('public'));

// Webhook Twilio
app.post('/webhook', (req, res) => {
  const from = req.body.From || req.body.from;
  const to = req.body.To || req.body.to;
  const body = req.body.Body || req.body.body;
  const timestamp = Date.now();

  const ref = db.ref('messages').push();
  ref.set({ from, to, body, direction: 'inbound', timestamp });

  res.sendStatus(200);
});

// Invia risposta
app.post('/send', async (req, res) => {
  const { to, body } = req.body;
  try {
    const message = await client.messages.create({
      from: `whatsapp:${process.env.TWILIO_NUMBER}`,
      to: `whatsapp:${to}`,
      body,
    });

    const ref = db.ref('messages').push();
    ref.set({ from: process.env.TWILIO_NUMBER, to, body, direction: 'outbound', timestamp: Date.now() });

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.listen(port, () => console.log(`🚀 Server online sulla porta ${port}`));

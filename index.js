const express = require('express');
const bodyParser = require('body-parser');
const admin = require('firebase-admin');
const cors = require('cors');
const twilio = require('twilio');
require('dotenv').config();

const app = express();
const port = process.env.PORT || 3000;

// Inizializza Firebase da variabile ambiente
const serviceAccount = JSON.parse(process.env.FIREBASE_CONFIG);
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: "https://aste-florio-default-rtdb.europe-west1.firebasedatabase.app"
});
const db = admin.database();

// Twilio
const client = twilio(process.env.TWILIO_SID, process.env.TWILIO_AUTH);

app.use(cors());
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());
app.use(express.static('public'));

// Endpoint test
app.get('/', (req, res) => {
  res.send("✅ Server attivo - Aste Florio");
});

// Webhook per ricezione messaggi
app.post('/webhook', (req, res) => {
  console.log('🔔 Webhook attivato!');
  console.log('📩 Body ricevuto:', req.body);

  const from = req.body.From || req.body.from || req.body.Author || 'whatsapp:undefined';
  const to = req.body.To || req.body.to || 'whatsapp:+393791824301';
  const body = req.body.Body || req.body.body || '';
  const timestamp = Date.now();

  if (!body || !from) {
    console.warn("❗️ Messaggio incompleto, ignorato:", { from, body });
    return res.sendStatus(204);
  }

  const ref = db.ref('messages').push();
  ref.set({ from, to, body, direction: 'inbound', timestamp }, () => {
    console.log('✅ Salvataggio Firebase riuscito');
  });

  res.sendStatus(200);
});

// Invia messaggi WhatsApp
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
    console.error('Errore invio Twilio:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.listen(port, () => console.log(`🚀 Server online sulla porta ${port}`));

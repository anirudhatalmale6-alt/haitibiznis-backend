require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');

const app = express();

app.use(cors({
  origin: function(origin, callback) {
    const allowed = ['https://haitibiznis.com', 'https://www.haitibiznis.com', 'https://msouwout.com', 'https://www.msouwout.com', 'https://myplopplop.com', 'https://www.myplopplop.com', 'http://localhost:3000', 'http://127.0.0.1:5500'];
    if (!origin || allowed.includes(origin) || origin.endsWith('.onrender.com') || origin.endsWith('.trycloudflare.com') || origin.endsWith('.github.io')) {
      callback(null, true);
    } else {
      callback(null, true);
    }
  },
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  // A header the browser has not been told about here is stripped at the
  // preflight, so the request arrives with no credential and the door is told
  // its code is wrong. Nothing in the server logs looks broken.
  allowedHeaders: ['Content-Type', 'x-admin-pin', 'x-door-code']
}));
app.use(express.json({ limit: '15mb' }));

// Escrow release, refunds, driver approval, editing or deleting somebody
// else's event. See middleware/adminOnly.js for the list and for what was
// deliberately left public. Mounted BEFORE the routers so a route added later
// cannot quietly miss it.
const { adminOnly } = require('./middleware/adminOnly');
app.use(adminOnly);

app.use('/api/events', require('./routes/events'));
app.use('/api/ai', require('./routes/ai'));
app.use('/api/payments', require('./routes/payments'));
app.use('/api/rides', require('./routes/rides'));
app.use('/api/whatsapp', require('./routes/whatsapp'));
app.use('/api/admin', require('./routes/admin'));
app.use('/api/orders', require('./routes/orders'));
app.use('/api/verify', require('./routes/verify'));

/* `commit` is here because for months there was no way to tell from outside
 * which code was actually running. Render's push webhook had stopped firing,
 * the dashboard still said auto-deploy was on, and four commits sat on main
 * unnoticed. Render sets RENDER_GIT_COMMIT on every build, so this line is the
 * one honest answer to "is the fix live?". */
app.get('/', (req, res) => {
  res.json({
    service: 'HaitiBiznis API', version: '3.0.1', status: 'running',
    admin: true, verified: true,
    commit: (process.env.RENDER_GIT_COMMIT || 'unknown').slice(0, 7)
  });
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', db: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected', ai: process.env.ANTHROPIC_API_KEY ? 'configured' : 'not configured' });
});

const MONGO_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/haitibiznis';
const PORT = process.env.PORT || 3000;

mongoose.connect(MONGO_URI)
  .then(() => {
    console.log('MongoDB connected');
    app.listen(PORT, () => {
      console.log(`HaitiBiznis API running on port ${PORT}`);
      const extUrl = process.env.RENDER_EXTERNAL_URL || process.env.API_URL;
      if (extUrl) {
        setInterval(() => {
          fetch(`${extUrl}/health`).catch(() => {});
        }, 14 * 60 * 1000);
        console.log('Keep-alive ping enabled');
      }
    });
  })
  .catch(err => {
    console.error('MongoDB connection error:', err.message);
    process.exit(1);
  });

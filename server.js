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
  allowedHeaders: ['Content-Type']
}));
app.use(express.json({ limit: '15mb' }));

app.use('/api/events', require('./routes/events'));
app.use('/api/ai', require('./routes/ai'));
app.use('/api/payments', require('./routes/payments'));
app.use('/api/rides', require('./routes/rides'));
app.use('/api/whatsapp', require('./routes/whatsapp'));

app.get('/', (req, res) => {
  res.json({ service: 'HaitiBiznis API', version: '1.0.0', status: 'running' });
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

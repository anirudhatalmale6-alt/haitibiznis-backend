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
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
  // A header the browser has not been told about here is stripped at the
  // preflight, so the request arrives with no credential and the door is told
  // its code is wrong. Nothing in the server logs looks broken.
  //
  // x-manage-code is the organiser's own code for their own event, and it is
  // on this list for exactly that reason - leaving it off would tell every
  // organiser their correct code was wrong.
  allowedHeaders: ['Content-Type', 'x-admin-pin', 'x-door-code', 'x-manage-code']
}));
app.use(express.json({ limit: '15mb' }));

// Escrow release, refunds, driver approval, editing or deleting somebody
// else's event. See middleware/adminOnly.js for the list and for what was
// deliberately left public. Mounted BEFORE the routers so a route added later
// cannot quietly miss it.
const { adminOnly } = require('./middleware/adminOnly');
app.use(adminOnly);

const paymentsRouter = require('./routes/payments');

const eventsRouter = require('./routes/events');

/* The short share link. See the comment on shareHandler in routes/events.js -
   this is the one the owner circled in red, and it is mounted at the root rather
   than under /api so that what lands in a WhatsApp message reads like a link
   to an event and not like a call to a machine. */
app.get('/e/:id', eventsRouter.shareHandler);

/* What generated links should say. Set SHARE_BASE to a branded subdomain
   pointed at this service and every new link is branded; leave it unset and it
   falls back to wherever this instance is answering from. Old links keep
   working either way. */
app.get('/api/status/share-base', (req, res) => {
  res.json({
    shareBase: process.env.SHARE_BASE || process.env.RENDER_EXTERNAL_URL || '',
    branded: !!process.env.SHARE_BASE
  });
});

app.use('/api/events', eventsRouter);
app.use('/api/ai', require('./routes/ai'));
app.use('/api/payments', paymentsRouter);
app.use('/api/rides', require('./routes/rides'));
app.use('/api/whatsapp', require('./routes/whatsapp'));
app.use('/api/admin', require('./routes/admin'));
app.use('/api/orders', require('./routes/orders'));
app.use('/api/verify', require('./routes/verify'));
app.use('/api/pos', require('./routes/pos'));
app.use('/api/promo', require('./routes/promo'));

/* Paid online classes. Registration, payment and access control only - the
   teaching stays in Google Classroom. See routes/courses.js. */
const coursesRouter = require('./routes/courses');
app.use('/api/courses', coursesRouter);

/* Instructor logins. Each instructor sees only the courses whose
   `instructorId` is their own, and nothing in that router can reach a price
   or a payment. See routes/instructors.js. */
app.use('/api/instructors', require('./routes/instructors'));

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

/* Which outbound channels are actually configured on THIS instance.
 *
 * routes/whatsapp.js sends a real message when the credentials are set and
 * quietly writes [WA-DRY] to the log when they are not, returning as though it
 * had sent either way. That is fine for a chatbot in development and wrong for
 * a ticket somebody paid for, and from outside the two are indistinguishable.
 * Booleans only - never the values. */
app.get('/api/status/channels', (req, res) => {
  const DELIVERY = require('./utils/deliver').channels();
  res.json({
    whatsapp: !!(process.env.WHATSAPP_TOKEN && process.env.WHATSAPP_PHONE_ID),
    whatsappToken: !!process.env.WHATSAPP_TOKEN,
    whatsappPhoneId: !!process.env.WHATSAPP_PHONE_ID,
    /* No SMS supplier anywhere in the ecosystem. Stated as a literal because
       it IS a literal - there is nothing to ask. */
    sms: false,
    /* These used to be the hard-coded literal `false`, which was true at the
       time and would have gone on reading false on the day a mail account was
       connected. Asked of utils/deliver.js now, so the answer stays honest by
       itself. Booleans only - a credential never leaves this process. */
    email: DELIVERY.email,
    emailKey: DELIVERY.emailKey,
    emailFrom: DELIVERY.emailFrom,
    /* A WhatsApp number is not enough on its own: Meta refuses a free-form
       message to anybody who has not written to the business in the last 24
       hours, so without an APPROVED TEMPLATE the channel is configured and
       still cannot reach a buyer. The two are reported separately for that
       reason. */
    whatsappTemplateTicket: DELIVERY.whatsappTemplateTicket,
    whatsappTemplateCourse: DELIVERY.whatsappTemplateCourse,
    /* Whether the link to the agent commission engine is configured. A BOOLEAN
       ONLY - the key itself must never leave this process. Without this there
       is no way to tell a working commission from one that was silently
       skipped, short of buying a ticket to find out. */
    koutyeLink: !!process.env.INTERNAL_SERVICE_KEY,
    /* Whether cards can be taken at all. A BOOLEAN ONLY - the key never leaves
       this process. Without it the only way to find out is to try to buy a
       ticket, which means creating a real transaction to answer a question. */
    stripe: !!process.env.STRIPE_RESTRICTED_KEY,
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

      /* A ticket must not depend on the buyer coming back from MonCash for its
         payment to be noticed. See utils/ticketSweep.js. */
      require('./utils/ticketSweep').startTicketSweep({
        reconcile: paymentsRouter.reconcile
      });

      /* The same sweep, over course registrations. A student who finishes
         paying inside the MonCash app and never returns to the browser must
         still end up with their place in the class. Offset by 45s so the two
         sweeps do not both start calling the gateway on the same tick. */
      require('./utils/ticketSweep').startTicketSweep({
        reconcile: coursesRouter.reconcileReg,
        model: require('./models/CourseRegistration'),
        label: 'course',
        firstDelayMs: 75 * 1000
      });
    });
  })
  .catch(err => {
    console.error('MongoDB connection error:', err.message);
    process.exit(1);
  });

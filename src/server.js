require('dotenv').config();
require('express-async-errors');

const express     = require('express');
const cors        = require('cors');
const helmet      = require('helmet');
const morgan      = require('morgan');
const compression = require('compression');
const rateLimit   = require('express-rate-limit');

const { connectDB, connectRedis } = require('./config/db');
const logger = require('./utils/logger');
const { startJobs } = require('./jobs/cronJobs');

const app = express();

app.set('trust proxy', 1);

/* ── Security ── */
app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
app.use(compression());

/* ── CORS ── */
const allowedOrigins = [
  process.env.CLIENT_URL,
  process.env.ADMIN_URL,
  'http://localhost:3000',
  'http://localhost:3001',
];
app.use(cors({
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
    callback(new Error('Not allowed by CORS'));
  },
  credentials: true,
  methods: ['GET','POST','PUT','PATCH','DELETE','OPTIONS'],
  allowedHeaders: ['Content-Type','Authorization'],
}));

/* ── Body parsing ── */
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

/* ── HTTP logging ── */
if (process.env.NODE_ENV !== 'test') {
  app.use(morgan('combined', { stream: { write: (msg) => logger.info(msg.trim()) } }));
}

/* ── Rate limiting ──
   General limiter: all /api/ routes — 100 req / 15 min
   Auth limiter: only mutation auth endpoints (login, register, OTP sends)
                 NOT /auth/me — that is called on every page load
── */
const generalLimiter = rateLimit({
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS || '900000'),
  max:      parseInt(process.env.RATE_LIMIT_MAX || '200'),
  standardHeaders: true,
  legacyHeaders:   false,
  message: { success: false, message: 'Too many requests. Please try again later.' },
  skip: (req) => {
    // Never rate-limit the /auth/me hydration endpoint — it is called on every page load
    return req.path === '/me';
  },
});
app.use('/api/', generalLimiter);

/* Strict limiter ONLY for OTP sends, login attempts, password resets */
const authMutationLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max:      30,              // 30 mutation requests per 15 min (generous — supports OTP retries)
  standardHeaders: true,
  legacyHeaders:   false,
  message: { success: false, message: 'Too many attempts. Please try again in 15 minutes.' },
});
// Only apply strict limiter to auth mutation endpoints, explicitly NOT /me
app.use('/api/auth/login',                   authMutationLimiter);
app.use('/api/auth/forgot-password',         authMutationLimiter);
app.use('/api/auth/reset-password',          authMutationLimiter);
app.use('/api/auth/registration/send-otp',   authMutationLimiter);
app.use('/api/auth/registration/verify-otp', authMutationLimiter);
app.use('/api/auth/registration/submit',     authMutationLimiter);

/* ── Routes ── */
app.use('/api/auth',     require('./routes/auth'));
app.use('/api/kyc',      require('./routes/kyc'));
app.use('/api/rates',    require('./routes/rates'));
app.use('/api/bookings', require('./routes/bookings'));
app.use('/api/admin',    require('./routes/admin'));

/* ── Health ── */
app.get('/health', (req, res) =>
  res.json({ success: true, status: 'healthy', timestamp: new Date().toISOString() })
);

/* ── 404 ── */
app.use('*', (req, res) =>
  res.status(404).json({ success: false, message: `Route ${req.originalUrl} not found` })
);

/* ── Global error handler ── */
app.use((err, req, res, next) => {
  logger.error(`${err.message} — ${req.method} ${req.originalUrl}`);

  if (err.name === 'ValidationError') {
    const errors = Object.values(err.errors).map(e => ({ field: e.path, message: e.message }));
    return res.status(422).json({ success: false, message: 'Validation error', errors });
  }
  if (err.code === 11000) {
    const field = Object.keys(err.keyValue)[0];
    return res.status(409).json({ success: false, message: `${field} already exists` });
  }
  if (err.name === 'CastError') {
    return res.status(400).json({ success: false, message: 'Invalid ID format' });
  }

  res.status(err.statusCode || 500).json({
    success: false,
    message: process.env.NODE_ENV === 'production' ? 'Something went wrong' : err.message,
  });
});

/* ── Start ── */
const PORT = process.env.PORT || 5000;
const start = async () => {
  await connectDB();
  await connectRedis();
  startJobs();
  app.listen(PORT, () =>
    logger.info(`Next Gen Rates API on port ${PORT} [${process.env.NODE_ENV}]`)
  );
};

start();
module.exports = app;

const mongoose = require('mongoose');
const { createClient } = require('redis');
const logger = require('../utils/logger');

// ─── MongoDB ──────────────────────────────────────────────────
const connectDB = async () => {
  try {
    const conn = await mongoose.connect(process.env.MONGO_URI, {
      maxPoolSize: 10,
      serverSelectionTimeoutMS: 5000,
      socketTimeoutMS: 45000,
    });
    logger.info(`MongoDB connected: ${conn.connection.host}`);
  } catch (err) {
    logger.error(`MongoDB connection error: ${err.message}`);
    process.exit(1);
  }
};

// ─── Redis ────────────────────────────────────────────────────
let redisClient = null;

const connectRedis = async () => {
  try {
    redisClient = createClient({ url: process.env.REDIS_URL });
    redisClient.on('error', (err) => logger.error(`Redis error: ${err.message}`));
    redisClient.on('connect', () => logger.info('Redis connected'));
    await redisClient.connect();
  } catch (err) {
    logger.warn(`Redis unavailable, running without cache: ${err.message}`);
    redisClient = null;
  }
};

const getRedis = () => redisClient;

// ─── Cache helpers ────────────────────────────────────────────
const cache = {
  async get(key) {
    if (!redisClient) return null;
    try {
      const val = await redisClient.get(key);
      return val ? JSON.parse(val) : null;
    } catch { return null; }
  },
  async set(key, value, ttlSeconds = 300) {
    if (!redisClient) return;
    try {
      await redisClient.setEx(key, ttlSeconds, JSON.stringify(value));
    } catch {}
  },
  async del(key) {
    if (!redisClient) return;
    try { await redisClient.del(key); } catch {}
  },
  async delPattern(pattern) {
    if (!redisClient) return;
    try {
      const keys = await redisClient.keys(pattern);
      if (keys.length) await redisClient.del(keys);
    } catch {}
  },
};

module.exports = { connectDB, connectRedis, getRedis, cache };

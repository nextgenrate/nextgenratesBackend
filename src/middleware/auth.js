const jwt = require('jsonwebtoken');
const { User, Admin } = require('../models');
const { cache } = require('../config/db');

// ─── Token generation ─────────────────────────────────────────
const generateTokens = (payload, isAdmin = false) => {
  const secret = isAdmin ? process.env.JWT_SECRET + '_admin' : process.env.JWT_SECRET;
  const access = jwt.sign(payload, secret, { expiresIn: process.env.JWT_EXPIRES_IN || '7d' });
  const refresh = jwt.sign(payload, process.env.JWT_REFRESH_SECRET, { expiresIn: process.env.JWT_REFRESH_EXPIRES_IN || '30d' });
  return { access, refresh };
};

// ─── OTP generator ────────────────────────────────────────────
const generateOtp = () => Math.floor(100000 + Math.random() * 900000).toString();

// ─── User auth middleware ─────────────────────────────────────
const protect = async (req, res, next) => {
  try {
    const auth = req.headers.authorization;
    if (!auth?.startsWith('Bearer ')) return res.status(401).json({ success: false, message: 'Unauthorized' });
    const token = auth.split(' ')[1];

    // Check if token is blacklisted
    const blacklisted = await cache.get(`blacklist:${token}`);
    if (blacklisted) return res.status(401).json({ success: false, message: 'Token revoked' });

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const user = await User.findById(decoded.id).select('-password -otp');
    if (!user) return res.status(401).json({ success: false, message: 'User not found' });
    if (user.status === 'suspended') return res.status(403).json({ success: false, message: 'Account suspended' });

    req.user = user;
    req.token = token;
    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') return res.status(401).json({ success: false, message: 'Token expired' });
    return res.status(401).json({ success: false, message: 'Invalid token' });
  }
};

// Require KYC to be approved
const requireKyc = (req, res, next) => {
  if (req.user.kyc?.status !== 'approved') {
    return res.status(403).json({ success: false, message: 'KYC verification required', kycStatus: req.user.kyc?.status });
  }
  next();
};

// ─── Admin auth middleware ────────────────────────────────────
const adminProtect = async (req, res, next) => {
  try {
    const auth = req.headers.authorization;
    if (!auth?.startsWith('Bearer ')) return res.status(401).json({ success: false, message: 'Unauthorized' });
    const token = auth.split(' ')[1];

    const blacklisted = await cache.get(`blacklist:${token}`);
    if (blacklisted) return res.status(401).json({ success: false, message: 'Token revoked' });

    const decoded = jwt.verify(token, process.env.JWT_SECRET + '_admin');
    const admin = await Admin.findById(decoded.id).select('-password');
    if (!admin || !admin.isActive) return res.status(401).json({ success: false, message: 'Admin not found or inactive' });

    req.admin = admin;
    req.token = token;
    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') return res.status(401).json({ success: false, message: 'Token expired' });
    return res.status(401).json({ success: false, message: 'Invalid admin token' });
  }
};

const requireSuperAdmin = (req, res, next) => {
  if (req.admin.role !== 'super_admin') return res.status(403).json({ success: false, message: 'Super admin access required' });
  next();
};

// ─── Validation middleware (Joi) ──────────────────────────────
const validate = (schema) => (req, res, next) => {
  const { error } = schema.validate(req.body, { abortEarly: false });
  if (error) {
    const details = error.details.map(d => ({ field: d.path.join('.'), message: d.message }));
    return res.status(422).json({ success: false, message: 'Validation failed', errors: details });
  }
  next();
};

module.exports = { protect, requireKyc, adminProtect, requireSuperAdmin, validate, generateTokens, generateOtp };

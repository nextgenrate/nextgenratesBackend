const express  = require('express');
const Joi      = require('joi');
const router   = express.Router();
const { User } = require('../models');
const { generateTokens, generateOtp, protect, validate } = require('../middleware/auth');
const emailService = require('../services/emailService');
const { uploadToS3 } = require('../services/s3Service');
const { cache }    = require('../config/db');
const multer       = require('multer');
const path         = require('path');

/* ── blocked personal email domains ── */
const BLOCKED = [
  'gmail.com','yahoo.com','yahoo.in','yahoo.co.uk','yahoo.co.in',
  'hotmail.com','hotmail.in','outlook.com','outlook.in','live.com',
  'rediffmail.com','icloud.com','aol.com','mail.com','protonmail.com',
  'tutanota.com','yandex.com','zoho.com','inbox.com','gmx.com','msn.com',
];
const isBlocked = (email) => BLOCKED.includes((email.split('@')[1]||'').toLowerCase().trim());

/* ── multer (memory → S3) ── */
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = ['.pdf','.jpg','.jpeg','.png'].includes(path.extname(file.originalname).toLowerCase());
    cb(ok ? null : new Error('Only PDF, JPG, PNG allowed'), ok);
  },
});
/* Registration company docs (document_0 … document_4) */
const docFields = [
  ...Array.from({ length: 5 }, (_, i) => ({ name: `document_${i}`, maxCount: 1 })),
  /* KYC identity docs — all possible field keys from KYC_CONFIGS in RegisterPage */
  { name: 'aadhaar',       maxCount: 1 },
  { name: 'pan',           maxCount: 1 },
  { name: 'gst',           maxCount: 1 },
  { name: 'national_id',   maxCount: 1 },
  { name: 'trade_license', maxCount: 1 },
  { name: 'business_reg',  maxCount: 1 },
  { name: 'address_proof', maxCount: 1 },
  { name: 'other',         maxCount: 1 },
  { name: 'vat_cert',      maxCount: 1 },
  { name: 'incorporation', maxCount: 1 },
];

/* ══════════════════════════════════════════════════════════════
   COMPANY REGISTRATION  (3-step: send OTP → verify OTP → submit)
══════════════════════════════════════════════════════════════ */

/* STEP 1 — Send OTP to email or mobile */
router.post('/registration/send-otp', async (req, res) => {
  const { type, value } = req.body;
  if (!type || !value) return res.status(400).json({ success: false, message: 'type and value required' });
  if (!['email','mobile'].includes(type)) return res.status(400).json({ success: false, message: 'type must be email or mobile' });

  if (type === 'email') {
    if (!/\S+@\S+\.\S+/.test(value)) return res.status(400).json({ success: false, message: 'Invalid email address' });
    if (isBlocked(value)) return res.status(400).json({ success: false, message: 'Personal email providers (Gmail, Yahoo etc.) are not accepted. Please use your official company email.' });
    const existing = await User.findOne({ officialEmail: value.toLowerCase().trim() }).lean();
    if (existing) return res.status(409).json({ success: false, message: 'This email is already registered. Please sign in.' });
  }

  const otp = generateOtp();
  const key = `reg_otp:${type}:${value}`;
  await cache.set(key, otp, 600); // 10 minutes

  try {
    if (type === 'email') {
      await emailService.sendRegistrationOtp(value, otp);
    } else {
      const sms = require('../services/smsService');
      await sms.sendOtp(value, otp);
    }
    res.json({ success: true, message: `OTP sent to ${type === 'email' ? value : 'your mobile'}. Valid for 10 minutes.` });
  } catch (err) {
    await cache.del(key).catch(() => {});
    res.status(500).json({ success: false, message: 'Failed to send OTP. Please try again.' });
  }
});

/* STEP 2 — Verify OTP */
router.post('/registration/verify-otp', async (req, res) => {
  const { type, value, otp } = req.body;
  if (!type || !value || !otp) return res.status(400).json({ success: false, message: 'type, value and otp are required' });

  const key    = `reg_otp:${type}:${value}`;
  const stored = await cache.get(key);
  if (!stored)              return res.status(400).json({ success: false, message: 'OTP has expired. Please request a new OTP.' });
  if (stored !== String(otp).trim()) return res.status(400).json({ success: false, message: 'Incorrect OTP. Please check and try again.' });

  /* Store verified flag for 30 min so user can complete the form */
  await cache.set(`reg_verified:${type}:${value}`, '1', 1800);
  await cache.del(key);
  res.json({ success: true, message: `${type === 'email' ? 'Email' : 'Mobile'} verified successfully.` });
});

/* STEP 3 — Full registration submission (multipart with up to 5 docs + password) */
router.post('/registration/submit', upload.fields(docFields), async (req, res) => {
  const b = req.body;

  /* ── required field check ── */
  const required = ['companyName','companyType','companyAddress','zipCode','country',
                    'contactName','officialEmail','mobileNumber','mobile',
                    'directorName','directorEmail','directorMobile','password'];
  const missing = required.filter(f => !b[f]?.trim());
  if (missing.length) return res.status(400).json({ success: false, message: `Missing required fields: ${missing.join(', ')}` });

  const email = b.officialEmail.toLowerCase().trim();
  if (isBlocked(email)) return res.status(400).json({ success: false, message: 'Personal email not accepted' });

  /* ── confirm OTP verifications are done ── */
  const emailVer  = await cache.get(`reg_verified:email:${email}`);
  const mobileVer = await cache.get(`reg_verified:mobile:${b.mobile}`);
  if (!emailVer)  return res.status(400).json({ success: false, message: 'Email OTP verification is required. Please go back and verify your email.' });
  if (!mobileVer) return res.status(400).json({ success: false, message: 'Mobile OTP verification is required. Please go back and verify your mobile.' });

  /* ── password strength check ── */
  if (b.password.length < 8) return res.status(400).json({ success: false, message: 'Password must be at least 8 characters' });
  if (!/(?=.*[a-z])(?=.*[A-Z])(?=.*\d)/.test(b.password)) {
    return res.status(400).json({ success: false, message: 'Password must contain uppercase, lowercase and a number' });
  }

  /* ── duplicate check ── */
  const existing = await User.findOne({ officialEmail: email }).lean();
  if (existing) return res.status(409).json({ success: false, message: 'This email is already registered. Please sign in.' });

  /* ── Upload documents to S3 ── */
  const registrationDocuments = [];  // company reg docs (document_0…4)
  const kycDocuments          = [];  // KYC identity docs (aadhaar, pan, etc.)

  const KYC_DOC_KEYS = new Set([
    'aadhaar','pan','gst','national_id','trade_license',
    'business_reg','address_proof','other','vat_cert','incorporation',
  ]);

  for (const [key, fileArr] of Object.entries(req.files || {})) {
    const file = fileArr[0];
    const isKycDoc = KYC_DOC_KEYS.has(key);
    const folder   = isKycDoc ? `kyc/registration` : 'registrations';
    try {
      const result = await uploadToS3(file, folder);
      const entry = {
        fieldKey:          key,
        originalName:      file.originalname,
        mimeType:          file.mimetype,
        s3Key:             result.key,
        s3Url:             result.url,
        scheduledDeleteAt: result.scheduledDeleteAt,
        uploadedAt:        new Date(),
      };
      if (isKycDoc) {
  kycDocuments.push({ ...entry, type: key });
} else {
  registrationDocuments.push({
    ...entry,
    type: key || 'company_document', // ✅ FIX
  });
}
    } catch (s3Err) {
      console.error(`S3 upload error [${key}]:`, s3Err.message);
      // Non-fatal — continue
    }
  }

  /* ── Create User ── */
  const user = await User.create({
    name:            b.contactName,
    officialEmail:   email,
    password:        b.password,          // hashed by pre-save hook
    mustChangePassword: false,
    isEmailVerified: true,                // verified via OTP above
    status:          'pending_approval',  // admin must approve before login is allowed

    company: {
      name:              b.companyName,
      type:              b.companyType,
      address:           b.companyAddress,
      zipCode:           b.zipCode,
      country:           b.country,
      website:           b.website || '',
      incorporationDate: b.incorporationDate ? new Date(b.incorporationDate) : null,
      vatGstTaxNo:       b.vatGstTaxNo || '',
      billingAddress:    b.billingAddressSame === 'true' ? b.companyAddress : (b.billingAddress || b.companyAddress),
      billingAddressSame:b.billingAddressSame === 'true',
    },

    phone:              b.mobileNumber,
    phoneCountryCode:   b.mobileCountryCode || '+91',
    mobile:             b.mobile,
    landline:           b.landline || '',
    landlineCountryCode:b.landlineCountryCode || '',

    director: {
      name:   b.directorName,
      email:  b.directorEmail,
      mobile: b.directorMobile,
    },

    registrationDocuments,
    registrationDate: new Date(),
    kyc: {
      status:        'pending',
      submittedAt:   new Date(),
      country:       b.kycCountry    || '',
      gstNumber:     b.kycGstNumber  || '',
      panNumber:     b.panNumber     || '',
      aadhaarNumber: b.aadhaarNumber || '',
      nationalId:    b.nationalId    || '',
      taxId:         b.taxId         || '',
      documents:     kycDocuments,   // KYC files uploaded in registration step 3
    },
  });

  /* ── Cleanup Redis verified flags ── */
  await Promise.all([
    cache.del(`reg_verified:email:${email}`),
    cache.del(`reg_verified:mobile:${b.mobile}`),
  ]).catch(() => {});

  /* ── Send notifications ── */
  await emailService.sendRegistrationReceived(email, b.contactName, b.companyName, user._id.toString()).catch(() => {});
  await emailService.sendAdminRegistrationAlert(user).catch(() => {});

  res.status(201).json({
    success:       true,
    message:       'Registration submitted successfully. Our team will review your documents and activate your account within 24–48 hours.',
    registrationId:user._id,
    applicationId: `NGR-${user._id.toString().slice(-8).toUpperCase()}`,
  });
});

/* ══════════════════════════════════════════════════════════════
   LOGIN  (blocks pending_approval accounts with friendly message)
══════════════════════════════════════════════════════════════ */
router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ success: false, message: 'Email and password are required' });

  const user = await User.findOne({
    $or: [{ officialEmail: email.toLowerCase() }, { email: email.toLowerCase() }],
  }).select('+password');

  if (!user) return res.status(401).json({ success: false, message: 'Invalid email or password' });
  if (user.isLocked?.()) return res.status(423).json({ success: false, message: 'Account locked due to too many failed attempts. Try again in 15 minutes.' });

  /* Block pending_approval users with a clear message */
  if (user.status === 'pending_approval') {
    return res.status(403).json({
      success: false,
      message: 'Your account is under review. Our team will verify your documents and activate your account within 24–48 business hours. You will receive a confirmation email.',
      status:  'pending_approval',
    });
  }
  if (user.status === 'suspended') {
    return res.status(403).json({ success: false, message: 'Your account has been suspended. Please contact support.' });
  }

  const ok = await user.comparePassword(password);
  if (!ok) {
    user.loginAttempts = (user.loginAttempts || 0) + 1;
    if (user.loginAttempts >= 5) { user.lockUntil = new Date(Date.now() + 15 * 60000); user.loginAttempts = 0; }
    await user.save();
    return res.status(401).json({ success: false, message: 'Invalid email or password' });
  }

  user.loginAttempts = 0;
  user.lockUntil     = undefined;
  user.lastLoginAt   = new Date();
  await user.save();

  const tokens = generateTokens({ id: user._id }, false);
  const { password: _, otp: __, ...safe } = user.toObject();
  res.json({ success: true, tokens, user: safe });
});

/* ── Logout ── */
router.post('/logout', protect, async (req, res) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (token) await cache.set(`blacklist:${token}`, '1', 86400).catch(() => {});
  res.json({ success: true });
});

/* ── Me ── */
router.get('/me', protect, async (req, res) => {
  const user = await User.findById(req.user._id).lean();
  if (!user) return res.status(404).json({ success: false, message: 'User not found' });
  res.json({ success: true, user });
});

/* ── Forgot password ── */
router.post('/forgot-password', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ success: false, message: 'Email required' });
  const user = await User.findOne({ $or: [{ officialEmail: email.toLowerCase() }, { email: email.toLowerCase() }] }).lean();
  if (user) {
    const otp = generateOtp();
    await cache.set(`pw_reset:${email}`, otp, 600);
    await emailService.sendRegistrationOtp(email, otp, 'password_reset').catch(() => {});
  }
  res.json({ success: true, message: 'If this email is registered, you will receive a password reset OTP shortly.' });
});

/* ── Reset password ── */
router.post('/reset-password', async (req, res) => {
  const { email, otp, newPassword } = req.body;
  if (!email || !otp || !newPassword) return res.status(400).json({ success: false, message: 'email, otp and newPassword required' });
  const stored = await cache.get(`pw_reset:${email}`);
  if (!stored || stored !== String(otp)) return res.status(400).json({ success: false, message: 'Invalid or expired OTP' });
  const user = await User.findOne({ $or: [{ officialEmail: email.toLowerCase() }, { email: email.toLowerCase() }] });
  if (!user) return res.status(404).json({ success: false, message: 'User not found' });
  user.password = newPassword;
  user.mustChangePassword = false;
  await user.save();
  await cache.del(`pw_reset:${email}`);
  res.json({ success: true, message: 'Password reset successfully. You can now sign in.' });
});

/* ── Set / change password ── */
router.post('/set-password', protect, async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  if (!newPassword || newPassword.length < 8) return res.status(400).json({ success: false, message: 'Password must be at least 8 characters' });
  const user = await User.findById(req.user._id).select('+password');
  if (!user.mustChangePassword && currentPassword) {
    const ok = await user.comparePassword(currentPassword);
    if (!ok) return res.status(401).json({ success: false, message: 'Current password is incorrect' });
  }
  user.password = newPassword;
  user.mustChangePassword = false;
  await user.save();
  res.json({ success: true, message: 'Password updated successfully' });
});

/* ── Verify email OTP (legacy flow) ── */
router.post('/verify-email', async (req, res) => {
  const { userId, otp } = req.body;
  if (!userId || !otp) return res.status(400).json({ success: false, message: 'userId and otp required' });
  const user = await User.findById(userId);
  if (!user) return res.status(404).json({ success: false, message: 'User not found' });
  if (user.isEmailVerified) return res.json({ success: true, message: 'Already verified' });
  if (!user.otp?.code || user.otp.code !== otp) return res.status(400).json({ success: false, message: 'Invalid OTP' });
  if (user.otp.expires < new Date()) return res.status(400).json({ success: false, message: 'OTP expired' });
  user.isEmailVerified = true; user.otp = undefined;
  await user.save();
  res.json({ success: true, message: 'Email verified' });
});

/* ── Resend OTP (legacy) ── */
router.post('/resend-otp', async (req, res) => {
  const { email, purpose } = req.body;
  if (!email) return res.status(400).json({ success: false, message: 'email required' });
  const user = await User.findOne({ $or: [{ email }, { officialEmail: email }] });
  if (!user) return res.status(404).json({ success: false, message: 'User not found' });
  const otp = generateOtp();
  user.otp = { code: otp, expires: new Date(Date.now() + 10 * 60000), attempts: 0 };
  await user.save();
  await emailService.sendOtp(email, user.name || 'User', otp, purpose || 'verification');
  res.json({ success: true });
});

/* ── Profile update ── */
router.put('/profile', protect, async (req, res) => {
  const allowed = ['name','phone','phoneCountryCode'];
  const updates = {};
  allowed.forEach(k => { if (req.body[k] !== undefined) updates[k] = req.body[k]; });
  const user = await User.findByIdAndUpdate(req.user._id, updates, { new: true }).lean();
  res.json({ success: true, user });
});

module.exports = router;

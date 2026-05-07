const express = require('express');
const router = express.Router();
const XLSX = require('xlsx');
const { User, Admin, Rate, Port, Booking, Enquiry, SearchLog, ActivityLog } = require('../models');
const { adminProtect, requireSuperAdmin, generateTokens, validate } = require('../middleware/auth');
const emailService = require('../services/emailService');
const { cache } = require('../config/db');
const bcrypt = require('bcryptjs');
const Joi = require('joi');

// ─── Admin login ──────────────────────────────────────────────
router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  const admin = await Admin.findOne({ email }).select('+password');
  if (!admin || !admin.isActive) return res.status(401).json({ success: false, message: 'Invalid credentials' });

  const match = await admin.comparePassword(password);
  if (!match) return res.status(401).json({ success: false, message: 'Invalid credentials' });

  admin.lastLoginAt = new Date();
  await admin.save();

  const tokens = generateTokens({ id: admin._id, email: admin.email, role: admin.role }, true);
  res.json({ success: true, tokens, admin: { _id: admin._id, name: admin.name, email: admin.email, role: admin.role } });
});

// ─── All routes below require admin auth ──────────────────────
router.use(adminProtect);

// ─── Dashboard stats ──────────────────────────────────────────
router.get('/dashboard', async (req, res) => {
  const { from, to } = req.query;
  const start = from ? new Date(from) : new Date(Date.now() - 30 * 86400000);
  const end = to ? new Date(to) : new Date();

  const [
    totalUsers, newUsers, kycPending, kycApproved, pendingRegistrations,
    totalBookings, pendingBookings, approvedBookings,
    totalEnquiries, pendingEnquiries,
    totalSearches,
    recentBookings, recentSearches,
  ] = await Promise.all([
    User.countDocuments(),
    User.countDocuments({ createdAt: { $gte: start, $lte: end } }),
    User.countDocuments({ 'kyc.status': 'pending' }),
    User.countDocuments({ status: 'pending_approval' }),
    User.countDocuments({ 'kyc.status': 'approved' }),
    Booking.countDocuments({ createdAt: { $gte: start, $lte: end } }),
    Booking.countDocuments({ status: 'pending' }),
    Booking.countDocuments({ status: { $in: ['approved', 'confirmed'] }, createdAt: { $gte: start, $lte: end } }),
    Enquiry.countDocuments({ createdAt: { $gte: start, $lte: end } }),
    Enquiry.countDocuments({ status: 'pending' }),
    SearchLog.countDocuments({ createdAt: { $gte: start, $lte: end } }),
    Booking.find({ status: 'pending' }).sort({ createdAt: -1 }).limit(5).populate('user', 'name email company').lean(),
    SearchLog.find({ createdAt: { $gte: start, $lte: end } }).sort({ createdAt: -1 }).limit(10).populate('user', 'name email').lean(),
  ]);

  // Revenue by day (aggregation)
  const revenueByDay = await Booking.aggregate([
    { $match: { status: { $in: ['approved', 'confirmed'] }, createdAt: { $gte: start, $lte: end } } },
    { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } }, revenue: { $sum: '$totalAmount' }, count: { $sum: 1 } } },
    { $sort: { _id: 1 } },
  ]);

  // Top routes
  const topRoutes = await SearchLog.aggregate([
    { $match: { createdAt: { $gte: start, $lte: end } } },
    { $group: { _id: { origin: '$originPort', dest: '$destinationPort' }, count: { $sum: 1 } } },
    { $sort: { count: -1 } },
    { $limit: 5 },
  ]);

  // Bookings by mode
  const bookingsByMode = await Booking.aggregate([
    { $match: { createdAt: { $gte: start, $lte: end } } },
    { $group: { _id: '$mode', count: { $sum: 1 } } },
  ]);

  res.json({
    success: true,
    data: {
      overview: { totalUsers, newUsers, kycPending, kycApproved, pendingRegistrations, totalBookings, pendingBookings, approvedBookings, totalEnquiries, pendingEnquiries, totalSearches },
      charts: { revenueByDay, topRoutes, bookingsByMode },
      recent: { bookings: recentBookings, searches: recentSearches },
    },
  });
});

// ─── Export CSV ───────────────────────────────────────────────
router.get('/export/:resource', async (req, res) => {
  const { resource } = req.params;
  const { from, to, status } = req.query;
  const start = from ? new Date(from) : new Date(Date.now() - 30 * 86400000);
  const end = to ? new Date(to) : new Date();

  let data = [], filename = 'export';

  if (resource === 'bookings') {
    const q = { createdAt: { $gte: start, $lte: end } };
    if (status) q.status = status;
    const bookings = await Booking.find(q).populate('user', 'name email company').lean();
    data = bookings.map(b => ({
      'Booking Ref': b.bookingRef,
      'Customer': b.user?.name,
      'Email': b.user?.email,
      'Company': b.user?.company?.name,
      'Mode': b.mode,
      'Origin': b.originPort,
      'Destination': b.destinationPort,
      'Carrier': b.carrier,
      'Container': b.containerType,
      'Total': `${b.currency} ${b.totalAmount}`,
      'Status': b.status,
      'Created': b.createdAt?.toLocaleDateString(),
    }));
    filename = 'bookings';
  } else if (resource === 'users') {
    const users = await User.find({ createdAt: { $gte: start, $lte: end } }).lean();
    data = users.map(u => ({
      'Name': u.name,
      'Email': u.email,
      'Phone': `${u.phoneCountryCode}${u.phone}`,
      'Company': u.company?.name,
      'KYC Status': u.kyc?.status,
      'GST': u.kyc?.gstNumber,
      'Status': u.status,
      'Registered': u.createdAt?.toLocaleDateString(),
    }));
    filename = 'users';
  } else if (resource === 'searches') {
    const searches = await SearchLog.find({ createdAt: { $gte: start, $lte: end } }).populate('user', 'name email').lean();
    data = searches.map(s => ({
      'User': s.user?.name,
      'Email': s.user?.email,
      'Mode': s.mode,
      'Origin': s.originPort,
      'Destination': s.destinationPort,
      'Container': s.containerType,
      'Results': s.resultsCount,
      'Date': s.createdAt?.toLocaleDateString(),
    }));
    filename = 'search_activity';
  }

  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.json_to_sheet(data);
  XLSX.utils.book_append_sheet(wb, ws, filename);
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}_${Date.now()}.xlsx"`);
  res.send(buf);
});

// ─── KYC management ──────────────────────────────────────────
router.get('/kyc', async (req, res) => {
  const { status = 'pending', page = 1, limit = 20, search } = req.query;
  const query = { 'kyc.status': status };
  if (search) query.$or = [{ name: new RegExp(search, 'i') }, { email: new RegExp(search, 'i') }];

  const [users, total] = await Promise.all([
    User.find(query).select('name email phone company kyc createdAt').sort({ 'kyc.submittedAt': -1 }).skip((page-1)*limit).limit(parseInt(limit)).lean(),
    User.countDocuments(query),
  ]);

  // Get presigned URLs for documents
  const { getPresignedUrl } = require('../services/s3Service');
  const usersWithUrls = await Promise.all(users.map(async u => ({
    ...u,
    kyc: {
      ...u.kyc,
      documents: await Promise.all((u.kyc?.documents || []).filter(d => !d.deleted).map(async d => ({
        ...d,
        viewUrl: d.s3Key ? await getPresignedUrl(d.s3Key, 3600) : null,
      }))),
    },
  })));

  res.json({ success: true, data: { users: usersWithUrls, pagination: { total, page: parseInt(page), pages: Math.ceil(total/limit) } } });
});

router.patch('/kyc/:userId', async (req, res) => {
  const { status, rejectionReason } = req.body;
  if (!['approved', 'rejected', 'resubmit_required'].includes(status)) {
    return res.status(400).json({ success: false, message: 'Invalid status' });
  }

  const user = await User.findById(req.params.userId);
  if (!user) return res.status(404).json({ success: false, message: 'User not found' });

  user.kyc.status = status;
  user.kyc.reviewedAt = new Date();
  user.kyc.reviewedBy = req.admin._id;

  if (status === 'approved') {
    user.status = 'active';
    await emailService.sendKycApproved(user.officialEmail || user.email, user.name, process.env.CLIENT_URL);
  } else if (status === 'rejected' || status === 'resubmit_required') {
    user.kyc.rejectionReason = rejectionReason;
    await emailService.sendKycRejected(user.officialEmail || user.email, user.name, rejectionReason, process.env.CLIENT_URL);
  }

  await user.save();
  await cache.del(`user:${user._id}`);

  await ActivityLog.create({ actor: req.admin._id, actorModel: 'Admin', action: `kyc_${status}`, resource: 'User', resourceId: user._id, meta: { rejectionReason } });

  res.json({ success: true, message: `KYC ${status} for ${user.name}` });
});

// ─── GST verification (admin-side for manual check) ──────────
router.post('/kyc/verify-gst/:userId', async (req, res) => {
  const { gstNumber } = req.body;
  // Same logic as user-side verify-gst but admin-triggered
  const user = await User.findById(req.params.userId);
  if (!user) return res.status(404).json({ success: false, message: 'User not found' });

  // TODO: call GST API
  user.kyc.gstNumber = gstNumber;
  user.kyc.gstVerified = true;
  user.kyc.gstVerifiedAt = new Date();
  await user.save();

  res.json({ success: true, message: 'GST marked as verified' });
});

// ─── User management ─────────────────────────────────────────
router.get('/users', async (req, res) => {
  const { status, kyc, search, page = 1, limit = 20 } = req.query;
  const query = {};
  if (status) query.status = status;
  if (kyc) query['kyc.status'] = kyc;
  if (search) query.$or = [{ name: new RegExp(search, 'i') }, { email: new RegExp(search, 'i') }, { 'company.name': new RegExp(search, 'i') }];

  const [users, total] = await Promise.all([
    User.find(query).select('-otp -emailVerifyToken -passwordResetToken').sort({ createdAt: -1 }).skip((page-1)*limit).limit(parseInt(limit)).lean(),
    User.countDocuments(query),
  ]);

  res.json({ success: true, data: { users, pagination: { total, page: parseInt(page), pages: Math.ceil(total/limit) } } });
});

// ─── Create user (admin-initiated) ───────────────────────────
router.post('/users', async (req, res) => {
  const { name, email, companyName } = req.body;
  if (!name || !email) return res.status(400).json({ success: false, message: 'name and email required' });

  const exists = await User.findOne({ email });
  if (exists) return res.status(409).json({ success: false, message: 'Email already registered' });

  const tempPassword = `FF@${Math.random().toString(36).slice(2,8)}${Math.floor(Math.random()*100)}`.slice(0, 12);
  const user = await User.create({
    name, email, password: tempPassword,
    company: companyName ? { name: companyName } : undefined,
    isEmailVerified: true,
    mustChangePassword: true,
    createdByAdmin: true,
    status: 'pending_kyc',
  });

  await emailService.sendAdminCreatedAccount(email, name, email, tempPassword, process.env.CLIENT_URL);

  res.status(201).json({ success: true, message: `Account created for ${email}. Credentials sent by email.`, userId: user._id });
});

// ─── User search activity ─────────────────────────────────────
router.get('/users/:userId/searches', async (req, res) => {
  const searches = await SearchLog.find({ user: req.params.userId }).sort({ createdAt: -1 }).limit(50).lean();
  res.json({ success: true, data: searches });
});

// ─── Rate management ──────────────────────────────────────────
router.get('/rates', async (req, res) => {
  const { mode, active, page = 1, limit = 20 } = req.query;
  const query = {};
  if (mode) query.mode = mode;
  if (active !== undefined) query.isActive = active === 'true';

  const [rates, total] = await Promise.all([
    Rate.find(query).sort({ createdAt: -1 }).skip((page-1)*limit).limit(parseInt(limit)).populate('createdBy', 'name').lean(),
    Rate.countDocuments(query),
  ]);
  res.json({ success: true, data: { rates, pagination: { total, page: parseInt(page), pages: Math.ceil(total/limit) } } });
});

router.post('/rates', async (req, res) => {
  const rate = await Rate.create({ ...req.body, createdBy: req.admin._id });
  await cache.delPattern('rates:*');
  res.status(201).json({ success: true, data: rate });
});

router.put('/rates/:id', async (req, res) => {
  const rate = await Rate.findByIdAndUpdate(req.params.id, req.body, { new: true, runValidators: true });
  if (!rate) return res.status(404).json({ success: false, message: 'Rate not found' });
  await cache.delPattern('rates:*');
  res.json({ success: true, data: rate });
});

router.delete('/rates/:id', async (req, res) => {
  await Rate.findByIdAndUpdate(req.params.id, { isActive: false });
  await cache.delPattern('rates:*');
  res.json({ success: true, message: 'Rate deactivated' });
});

// ─── Bulk rate upload & template download ─────────────────────
const multer = require('multer');
const uploadXlsx = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

/* Helper — parse a charge block (up to maxN items) from flat row object.
   prefix = 'FC' | 'OC' | 'DC', maxN = 6 | 9 | 9
   Columns: {prefix}{n} Name / Code / Basis / Currency / Amount  */
function parseCharges(row, prefix, maxN) {
  const charges = [];
  for (let n = 1; n <= maxN; n++) {
    const name   = (row[`${prefix}${n} Name`]     || '').toString().trim();
    const amount = parseFloat(row[`${prefix}${n} Amount`]);
    if (!name || isNaN(amount)) continue;
    charges.push({
      name,
      code:     (row[`${prefix}${n} Code`]     || '').toString().trim().toUpperCase() || undefined,
      basis:    (row[`${prefix}${n} Basis`]    || 'per equipment').toString().trim(),
      currency: (row[`${prefix}${n} Currency`] || 'USD').toString().trim().toUpperCase(),
      amount,
    });
  }
  return charges;
}

/* Parse date flexibly — Excel serial numbers and ISO strings both work */
function parseDate(val) {
  if (!val) return null;
  if (typeof val === 'number') {
    // Excel date serial
    const d = XLSX.SSF.parse_date_code(val);
    if (d) return new Date(d.y, d.m - 1, d.d);
  }
  const d = new Date(val);
  return isNaN(d.getTime()) ? null : d;
}

/* ── Template download ── */
router.get('/rates/bulk-template', async (req, res) => {
  /* Build header row exactly matching the parser column names */
  const fcHeaders = [];
  for (let n = 1; n <= 6; n++) ['Name','Code','Basis','Currency','Amount'].forEach(f => fcHeaders.push(`FC${n} ${f}`));
  const ocHeaders = [];
  for (let n = 1; n <= 9; n++) ['Name','Code','Basis','Currency','Amount'].forEach(f => ocHeaders.push(`OC${n} ${f}`));
  const dcHeaders = [];
  for (let n = 1; n <= 9; n++) ['Name','Code','Basis','Currency','Amount'].forEach(f => dcHeaders.push(`DC${n} ${f}`));

  const headers = [
    'Mode','Rate Type','Shipping Line','Shipping Line Code',
    'Container Type','Service Mode','Service Name',
    'POL Code','POL Name','Origin Terminal',
    'POD Code','POD Name','Destination Terminal',
    'Via Codes','Via Names',
    'Sailing Date','Transit Days','Free Days',
    'Cargo Type','Cargo Description',
    'Valid From','Valid To',
    ...fcHeaders, ...ocHeaders, ...dcHeaders,
    'Inclusions','Remarks',
  ];

  /* One sample row */
  const sample = {
    'Mode':                'SEA-FCL',
    'Rate Type':           'SPOT RATE',
    'Shipping Line':       'OOCL',
    'Shipping Line Code':  'OOCL',
    'Container Type':      '40GP',
    'Service Mode':        'CY/CY',
    'Service Name':        '',
    'POL Code':            'INNSA',
    'POL Name':            'Nhava Sheva (Mumbai)',
    'Origin Terminal':     '',
    'POD Code':            'USNYC',
    'POD Name':            'New York',
    'Destination Terminal':'',
    'Via Codes':           '',
    'Via Names':           '',
    'Sailing Date':        '2026-05-05',
    'Transit Days':        33,
    'Free Days':           7,
    'Cargo Type':          'FAK',
    'Cargo Description':   '',
    'Valid From':          '2026-04-01',
    'Valid To':            '2026-06-30',
    'FC1 Name':   'Basic Ocean Freight', 'FC1 Code': 'BOF', 'FC1 Basis': 'per equipment', 'FC1 Currency': 'USD', 'FC1 Amount': 1487,
    'FC2 Name':   'Carrier Security Surcharge', 'FC2 Code': 'CSS', 'FC2 Basis': 'per equipment', 'FC2 Currency': 'USD', 'FC2 Amount': 13,
    'FC3 Name':   'Marine Fuel Recovery', 'FC3 Code': 'MFR', 'FC3 Basis': 'per equipment', 'FC3 Currency': 'USD', 'FC3 Amount': 323,
    'FC4 Name':   'Emergency Fuel Surcharge', 'FC4 Code': 'EFS', 'FC4 Basis': 'per equipment', 'FC4 Currency': 'USD', 'FC4 Amount': 160,
    'OC1 Name':   'Origin Terminal Handling Charge', 'OC1 Code': 'OTHC', 'OC1 Basis': 'per equipment', 'OC1 Currency': 'INR', 'OC1 Amount': 11033,
    'OC2 Name':   'Export Service Fee', 'OC2 Code': 'ESF', 'OC2 Basis': 'per B/L', 'OC2 Currency': 'INR', 'OC2 Amount': 1599,
    'OC3 Name':   'Security Manifest Document Fee', 'OC3 Code': 'SMDF', 'OC3 Basis': 'per B/L', 'OC3 Currency': 'INR', 'OC3 Amount': 3750,
    'OC4 Name':   'Document Charge', 'OC4 Code': 'DOC', 'OC4 Basis': 'per B/L', 'OC4 Currency': 'INR', 'OC4 Amount': 5300,
    'DC1 Name':   'Terminal Security Charges', 'DC1 Code': 'TSC', 'DC1 Basis': 'per equipment', 'DC1 Currency': 'USD', 'DC1 Amount': 12,
    'DC2 Name':   'Equipment Maintenance Fee', 'DC2 Code': 'EMF', 'DC2 Basis': 'per equipment', 'DC2 Currency': 'USD', 'DC2 Amount': 20,
    'DC3 Name':   'NY Pass Through Charge', 'DC3 Code': 'NYPT', 'DC3 Basis': 'per equipment', 'DC3 Currency': 'USD', 'DC3 Amount': 14.52,
    'Inclusions':  '',
    'Remarks':     '',
  };

  const wb2 = XLSX.utils.book_new();
  const ws2 = XLSX.utils.json_to_sheet([sample], { header: headers });

  /* Column widths */
  ws2['!cols'] = headers.map(h => ({ wch: Math.max(h.length + 2, 14) }));

  XLSX.utils.book_append_sheet(wb2, ws2, 'Rates');
  const buf = XLSX.write(wb2, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename="NGR_Rate_Upload_Template.xlsx"');
  res.send(buf);
});

/* ── Bulk upload — flat row format ── */
router.post('/rates/bulk', uploadXlsx.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ success: false, message: 'No file uploaded' });

  const wb = XLSX.read(req.file.buffer, { type: 'buffer', cellDates: true });
  const ws = wb.Sheets[wb.SheetNames[0]];
  /* Auto-detect header row: check if row 0 or row 1 contains 'Shipping Line'.
     Our template has group-label row 0 + header row 1, so we need range:1.
     Simple single-header templates (row 0 = headers) also work with range:0. */
  const firstRow = XLSX.utils.sheet_to_json(ws, { header: 1, range: 0 })[0] || [];
  const headerRange = firstRow.includes('Shipping Line') ? 0 : 1;
  const rows = XLSX.utils.sheet_to_json(ws, { defval: '', range: headerRange });

  if (!rows.length) return res.status(400).json({ success: false, message: 'File is empty or has no data rows' });

  const errors = [], created = [];

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const rowNum = i + 2; // Excel row number (1-indexed header + 1)

    try {
      /* ── Required fields ── */
      const shippingLine = (row['Shipping Line'] || '').toString().trim();
      const originPort   = (row['POL Code']      || '').toString().trim().toUpperCase();
      const destPort     = (row['POD Code']      || '').toString().trim().toUpperCase();
      const validFromRaw = row['Valid From'];

      const missing = [];
      if (!shippingLine) missing.push('Shipping Line');
      if (!originPort)   missing.push('POL Code');
      if (!destPort)     missing.push('POD Code');
      if (!validFromRaw) missing.push('Valid From');
      if (missing.length) {
        errors.push({ row: rowNum, error: `Missing required fields: ${missing.join(', ')}` });
        continue;
      }

      /* ── Parse charges ── */
      const freightCharges     = parseCharges(row, 'FC', 6);
      const originCharges      = parseCharges(row, 'OC', 9);
      const destinationCharges = parseCharges(row, 'DC', 9);

      /* ── Compute totals (USD only for freightRateUsd; all charges for display) ── */
      const freightRateUsd = freightCharges
        .filter(c => c.currency === 'USD')
        .reduce((s, c) => s + c.amount, 0);
      const totalUsd = [...freightCharges, ...destinationCharges]
        .filter(c => c.currency === 'USD')
        .reduce((s, c) => s + c.amount, 0);

      /* ── Via ports ── */
      const viaCodes = (row['Via Codes'] || '').toString().trim();
      const viaNames = (row['Via Names'] || '').toString().trim();

      /* ── Mode validation ── */
      const modeRaw = (row['Mode'] || 'SEA-FCL').toString().trim().toUpperCase();
      const mode = ['SEA-FCL','SEA-LCL','AIR'].includes(modeRaw) ? modeRaw : 'SEA-FCL';

      /* ── Rate type validation ── */
      const rateTypeRaw = (row['Rate Type'] || 'SPOT RATE').toString().trim().toUpperCase();
      const rateType = ['SPOT RATE','CONTRACT','LIVE RATE'].includes(rateTypeRaw) ? rateTypeRaw : 'SPOT RATE';

      const rate = await Rate.create({
        mode,
        rateType,
        shippingLine,
        shippingLineCode:   (row['Shipping Line Code'] || '').toString().trim().toUpperCase() || shippingLine.slice(0,6).toUpperCase(),
        originPort,
        originPortName:     (row['POL Name']           || '').toString().trim(),
        originTerminal:     (row['Origin Terminal']    || '').toString().trim(),
        destinationPort:    destPort,
        destinationPortName:(row['POD Name']           || '').toString().trim(),
        destinationTerminal:(row['Destination Terminal']|| '').toString().trim(),
        viaPort:     viaCodes ? viaCodes.split(',').map(s => s.trim().toUpperCase()).filter(Boolean) : [],
        viaPortNames:viaNames ? viaNames.split(',').map(s => s.trim()).filter(Boolean) : [],
        serviceMode:        (row['Service Mode']       || 'CY/CY').toString().trim(),
        serviceName:        (row['Service Name']       || '').toString().trim(),
        containerType:      (row['Container Type']     || '').toString().trim(),
        sailingDate:        parseDate(row['Sailing Date']),
        transitTimeDays:    parseInt(row['Transit Days']) || undefined,
        freeDays:           parseInt(row['Free Days'])    || 4,
        cargoType:          (row['Cargo Type']         || 'FAK').toString().trim(),
        cargoDescription:   (row['Cargo Description']  || '').toString().trim(),
        validFrom:          parseDate(validFromRaw) || new Date(),
        validTo:            parseDate(row['Valid To'])  || undefined,
        freightCharges,
        originCharges,
        destinationCharges,
        freightRateUsd:     freightRateUsd || undefined,
        totalUsd:           totalUsd || undefined,
        inclusions:         (row['Inclusions'] || '').toString().trim(),
        remarks:            (row['Remarks']    || '').toString().trim(),
        isActive:           true,
        createdBy:          req.admin._id,
      });

      created.push(rate._id);
    } catch (err) {
      errors.push({ row: rowNum, error: err.message.replace(/\r?\n/g, ' ').slice(0, 300) });
    }
  }

  await cache.delPattern('rates:*');
  res.json({
    success: true,
    message: `${created.length} rate(s) imported, ${errors.length} error(s)`,
    created: created.length,
    total:   rows.length,
    errors,
  });
});

// ─── Booking management ───────────────────────────────────────
router.get('/bookings', async (req, res) => {
  const { status, page = 1, limit = 20, search } = req.query;
  const query = {};
  if (status) query.status = status;

  const [bookings, total] = await Promise.all([
    Booking.find(query).sort({ createdAt: -1 }).skip((page-1)*limit).limit(parseInt(limit))
      .populate('user', 'name email phone company').lean(),
    Booking.countDocuments(query),
  ]);
  res.json({ success: true, data: { bookings, pagination: { total, page: parseInt(page), pages: Math.ceil(total/limit) } } });
});

router.patch('/bookings/:id', async (req, res) => {
  const { status, adminNotes } = req.body;
  if (!['approved', 'rejected', 'confirmed', 'cancelled', 'under_review'].includes(status)) {
    return res.status(400).json({ success: false, message: 'Invalid status' });
  }

  const booking = await Booking.findByIdAndUpdate(req.params.id, {
    status, adminNotes, reviewedBy: req.admin._id, reviewedAt: new Date(),
    ...(status === 'confirmed' ? { confirmedAt: new Date() } : {}),
  }, { new: true }).populate('user', 'name email');

  if (!booking) return res.status(404).json({ success: false, message: 'Booking not found' });

  // Notify user
  await emailService.sendBookingStatusUpdate(booking.user?.officialEmail || booking.user?.email, booking.user?.name, booking).catch(() => {});

  await ActivityLog.create({ actor: req.admin._id, actorModel: 'Admin', action: `booking_${status}`, resource: 'Booking', resourceId: booking._id });

  res.json({ success: true, data: booking });
});

// ─── Enquiry management ───────────────────────────────────────
router.get('/enquiries', async (req, res) => {
  const { status, page = 1, limit = 20 } = req.query;
  const query = status ? { status } : {};
  const [enquiries, total] = await Promise.all([
    Enquiry.find(query).sort({ createdAt: -1 }).skip((page-1)*limit).limit(parseInt(limit)).populate('user', 'name email company').lean(),
    Enquiry.countDocuments(query),
  ]);
  res.json({ success: true, data: { enquiries, pagination: { total, page: parseInt(page), pages: Math.ceil(total/limit) } } });
});

router.patch('/enquiries/:id', async (req, res) => {
  const { status, adminResponse } = req.body;
  const enquiry = await Enquiry.findByIdAndUpdate(req.params.id, {
    status, adminResponse, respondedBy: req.admin._id, respondedAt: new Date(),
  }, { new: true }).populate('user', 'name email');

  if (!enquiry) return res.status(404).json({ success: false, message: 'Enquiry not found' });

  // Email user with response
  if (adminResponse && enquiry.user?.email) {
    await emailService.send?.({ to: enquiry.user?.officialEmail || enquiry.user?.email, subject: `Response to your enquiry ${enquiry.enquiryRef}`, html: `<p>Hi ${enquiry.user?.name || 'Customer'},</p><p>${adminResponse}</p>` }).catch(() => {});
  }

  res.json({ success: true, data: enquiry });
});

// ─── Port management ──────────────────────────────────────────
router.post('/ports', async (req, res) => {
  const port = await Port.create(req.body);
  await cache.delPattern('ports:*');
  res.status(201).json({ success: true, data: port });
});

router.put('/ports/:id', async (req, res) => {
  const port = await Port.findByIdAndUpdate(req.params.id, req.body, { new: true });
  await cache.delPattern('ports:*');
  res.json({ success: true, data: port });
});

// ─── Search activity tracking ─────────────────────────────────
router.get('/search-activity', async (req, res) => {
  const { page = 1, limit = 50, userId } = req.query;
  const query = userId ? { user: userId } : {};
  const [logs, total] = await Promise.all([
    SearchLog.find(query).sort({ createdAt: -1 }).skip((page-1)*limit).limit(parseInt(limit)).populate('user', 'name email company').lean(),
    SearchLog.countDocuments(query),
  ]);
  res.json({ success: true, data: { logs, pagination: { total, page: parseInt(page), pages: Math.ceil(total/limit) } } });
});

// ─── Admin management (super admin only) ─────────────────────
router.post('/admins', requireSuperAdmin, async (req, res) => {
  const { name, email, role = 'admin' } = req.body;
  const tempPw = `Admin@${Math.random().toString(36).slice(2, 8)}${Math.floor(Math.random() * 100)}`;
  const admin = await Admin.create({ name, email, password: tempPw, role });
  res.status(201).json({ success: true, message: 'Admin created', admin: { _id: admin._id, name, email, role }, tempPassword: tempPw });
});

// ─── Registration Management ──────────────────────────────────
// List all company registration applications (status filter)
router.get('/registrations', async (req, res) => {
  const { status = 'pending_approval', page = 1, limit = 20, search } = req.query;
  const query = {};
  if (status !== 'all') query.status = status;
  if (search) {
    query.$or = [
      { 'company.name': new RegExp(search, 'i') },
      { officialEmail: new RegExp(search, 'i') },
      { name: new RegExp(search, 'i') },
      { 'company.country': new RegExp(search, 'i') },
    ];
  }
  const [users, total] = await Promise.all([
    User.find(query)
      .select('name officialEmail mobile company director registrationDocuments registrationDate status kyc createdAt')
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(parseInt(limit))
      .lean(),
    User.countDocuments(query),
  ]);

  // Generate presigned URLs for each doc
  const { getPresignedUrl } = require('../services/s3Service');
  const results = await Promise.all(users.map(async (u) => ({
    ...u,
    registrationDocuments: await Promise.all(
      (u.registrationDocuments || []).map(async (doc) => ({
        ...doc,
        viewUrl: doc.s3Key ? await getPresignedUrl(doc.s3Key, 3600) : null,
      }))
    ),
  })));

  res.json({
    success: true,
    data: { registrations: results, pagination: { total, page: parseInt(page), pages: Math.ceil(total / limit) } },
    counts: {
      pending_approval: await User.countDocuments({ status: 'pending_approval' }),
      active:           await User.countDocuments({ status: 'active' }),
      suspended:        await User.countDocuments({ status: 'suspended' }),
    },
  });
});

// Approve a registration — activate the account
router.patch('/registrations/:userId/approve', async (req, res) => {
  const { adminNote } = req.body;
  const user = await User.findById(req.params.userId);
  if (!user) return res.status(404).json({ success: false, message: 'User not found' });
  if (user.status !== 'pending_approval') {
    return res.status(400).json({ success: false, message: `Cannot approve — current status is '${user.status}'` });
  }
  // Activate account only — KYC is a SEPARATE step the user must complete after login
  user.status = 'active';
  // Reset KYC to not_submitted so user is prompted to upload KYC documents after login
  user.kyc.status = 'not_submitted';
  user.kyc.submittedAt = undefined;
  user.kyc.reviewedAt = undefined;
  user.kyc.reviewedBy = undefined;
  await user.save();
  await ActivityLog.create({ actor: req.admin._id, actorModel: 'Admin', action: 'registration_approved', resource: 'User', resourceId: user._id });
  // Notify user — tell them to login and complete KYC
  await emailService.sendAccountActivated(user.officialEmail, user.name, process.env.CLIENT_URL + '/login').catch(() => {});
  res.json({ success: true, message: 'Registration approved — account activated. User must now upload KYC documents after login.' });
});

// Reject a registration
router.patch('/registrations/:userId/reject', async (req, res) => {
  const { reason } = req.body;
  if (!reason) return res.status(400).json({ success: false, message: 'rejection reason is required' });
  const user = await User.findById(req.params.userId);
  if (!user) return res.status(404).json({ success: false, message: 'User not found' });
  user.status = 'suspended';
  user.kyc.status = 'rejected';
  user.kyc.rejectionReason = reason;
  user.kyc.reviewedAt = new Date();
  user.kyc.reviewedBy = req.admin._id;
  await user.save();
  await ActivityLog.create({ actor: req.admin._id, actorModel: 'Admin', action: 'registration_rejected', resource: 'User', resourceId: user._id, meta: { reason } });
  // Notify applicant
  const emailService = require('../services/emailService');
  await emailService.sendOtp(user.officialEmail, user.name, '—', 'rejection').catch(() => {});
  res.json({ success: true, message: 'Registration rejected.' });
});

// Reset a user's KYC status back to not_submitted (for fixing incorrect auto-approvals)
router.patch('/registrations/:userId/reset-kyc', requireSuperAdmin, async (req, res) => {
  const user = await User.findById(req.params.userId);
  if (!user) return res.status(404).json({ success: false, message: 'User not found' });
  user.kyc.status = 'not_submitted';
  user.kyc.reviewedAt  = undefined;
  user.kyc.reviewedBy  = undefined;
  user.kyc.submittedAt = undefined;
  user.kyc.documents   = [];
  await user.save();
  res.json({ success: true, message: `KYC reset to not_submitted for ${user.name}. User will be prompted to upload KYC on next login.` });
});

// Admin management (super admin only)
router.post('/admins', requireSuperAdmin, async (req, res) => {
  const { name, email, role = 'admin' } = req.body;
  const tempPw = `Admin@${Math.random().toString(36).slice(2, 8)}${Math.floor(Math.random() * 100)}`;
  const admin = await Admin.create({ name, email, password: tempPw, role });
  res.status(201).json({ success: true, message: 'Admin created', admin: { _id: admin._id, name, email, role }, tempPassword: tempPw });
});

module.exports = router;

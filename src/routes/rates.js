const express = require('express');
const router = express.Router();
const { Rate, Port, SearchLog } = require('../models');
const { protect, requireKyc } = require('../middleware/auth');
const { cache } = require('../config/db');

// ─── Search rates (full spec) ─────────────────────────────────
router.post('/search', protect, requireKyc, async (req, res) => {
  const {
    mode = 'SEA-FCL',
    originPort, destinationPort,
    containerType,
    sailingDate,
    sortBy = 'freightRateUsd', // freightRateUsd | totalUsd | transitTimeDays | sailingDate
    filterCarrier,
    filterDirect,
    filterCargo,
    page = 1, limit = 20,
  } = req.body;

  if (!originPort || !destinationPort) {
    return res.status(400).json({ success: false, message: 'originPort and destinationPort required' });
  }

  const orig = originPort.toUpperCase();
  const dest = destinationPort.toUpperCase();
  const cacheKey = `rates:${mode}:${orig}:${dest}:${containerType || 'all'}`;
  let rates = await cache.get(cacheKey);

  if (!rates) {
    const query = {
      mode,
      originPort: orig,
      destinationPort: dest,
      isActive: true,
      validFrom: { $lte: new Date() },
      $or: [{ validTo: null }, { validTo: { $gte: new Date() } }],
    };
    if (containerType) query.containerType = containerType;

    rates = await Rate.find(query).lean();
    await cache.set(cacheKey, rates, 300);
  }

  // Filters
  let filtered = [...rates];
  if (filterCarrier) filtered = filtered.filter(r => r.shippingLine?.toLowerCase().includes(filterCarrier.toLowerCase()));
  if (filterDirect === 'direct') filtered = filtered.filter(r => !r.viaPort?.length);
  if (filterDirect === 'indirect') filtered = filtered.filter(r => r.viaPort?.length > 0);
  if (filterCargo && filterCargo !== 'All') filtered = filtered.filter(r => r.cargoType === filterCargo);

  // Filter by sailing date
  if (sailingDate) {
    const sd = new Date(sailingDate);
    filtered = filtered.filter(r => !r.sailingDate || new Date(r.sailingDate) >= sd);
  }

  // Sort
  const sortMap = {
    freightRateUsd: (a, b) => (a.freightRateUsd || 0) - (b.freightRateUsd || 0),
    totalUsd: (a, b) => (a.totalUsd || 0) - (b.totalUsd || 0),
    transitTimeDays: (a, b) => (a.transitTimeDays || 999) - (b.transitTimeDays || 999),
    sailingDate: (a, b) => new Date(a.sailingDate || 0) - new Date(b.sailingDate || 0),
    carrier: (a, b) => (a.shippingLine || '').localeCompare(b.shippingLine || ''),
  };
  filtered.sort(sortMap[sortBy] || sortMap.freightRateUsd);

  const total = filtered.length;
  const paginated = filtered.slice((page - 1) * limit, page * limit);

  // Aggregate filter options for sidebar
  const carriers = [...new Set(rates.map(r => r.shippingLine).filter(Boolean))];
  const cargoTypes = [...new Set(rates.map(r => r.cargoType).filter(Boolean))];
  const containerTypes = [...new Set(rates.map(r => r.containerType).filter(Boolean))];

  // Log search
  SearchLog.create({
    user: req.user._id,
    mode, originPort: orig, destinationPort: dest, containerType,
    sailingDate: sailingDate ? new Date(sailingDate) : null,
    resultsCount: total,
    ip: req.ip,
    userAgent: req.get('user-agent'),
  }).catch(() => {});

  res.json({
    success: true,
    data: {
      rates: paginated,
      pagination: { total, page, limit, pages: Math.ceil(total / limit) },
      filters: { carriers, cargoTypes, containerTypes },
      originPort: orig,
      destinationPort: dest,
      mode,
    },
  });
});

// ─── Single rate detail ───────────────────────────────────────
router.get('/:id', protect, requireKyc, async (req, res) => {
  const rate = await Rate.findById(req.params.id).lean();
  if (!rate) return res.status(404).json({ success: false, message: 'Rate not found' });
  res.json({ success: true, data: rate });
});

// ─── Port autocomplete ────────────────────────────────────────
router.get('/ports/search', protect, async (req, res) => {
  const { q = '', type = 'sea', limit = 10 } = req.query;
  if (q.length < 1) return res.json({ success: true, data: [] });

  const cacheKey = `ports:${type}:${q.slice(0, 3).toLowerCase()}`;
  let ports = await cache.get(cacheKey);

  if (!ports) {
    ports = await Port.find({
      type,
      isActive: true,
      $or: [
        { name: new RegExp(q, 'i') },
        { code: new RegExp(q, 'i') },
        { country: new RegExp(q, 'i') },
      ],
    }).select('code name country countryCode region').limit(20).lean();
    await cache.set(cacheKey, ports, 3600);
  }

  const filtered = ports.filter(p =>
    p.name.toLowerCase().includes(q.toLowerCase()) ||
    p.code.toLowerCase().includes(q.toLowerCase()) ||
    p.country?.toLowerCase().includes(q.toLowerCase())
  ).slice(0, parseInt(limit));

  res.json({ success: true, data: filtered });
});

// ─── Container/load types ─────────────────────────────────────
router.get('/meta/load-types', async (req, res) => {
  const types = [
    { id: 1, loadCode: '20GP', loadDescription: "20' General Purpose", cbm: 33.0, kgs: 99999, teu: 1 },
    { id: 2, loadCode: '40GP', loadDescription: "40' General Purpose", cbm: 67.4, kgs: 99999, teu: 2 },
    { id: 3, loadCode: '40HC', loadDescription: "40' High Cube", cbm: 76.2, kgs: 99999, teu: 2 },
    { id: 4, loadCode: '45HC', loadDescription: "45' High Cube", cbm: 86.0, kgs: 32500, teu: 2.25 },
    { id: 5, loadCode: '20RE', loadDescription: "20' Reefer", cbm: 28.2, kgs: 30480, teu: 1 },
    { id: 6, loadCode: '40RE', loadDescription: "40' Reefer", cbm: 64.9, kgs: 99999, teu: 2 },
    { id: 7, loadCode: '20OT', loadDescription: "20' Open Top", cbm: 32.4, kgs: 30480, teu: 1 },
    { id: 8, loadCode: '40OT', loadDescription: "40' Open Top", cbm: 66.2, kgs: 35000, teu: 2 },
    { id: 9, loadCode: '20FR', loadDescription: "20' Flat Rack", cbm: 28.4, kgs: 30480, teu: 1 },
    { id: 10, loadCode: '40FR', loadDescription: "40' Flat Rack", cbm: 53.2, kgs: 35000, teu: 2 },
    { id: 11, loadCode: 'LCL', loadDescription: "Less Container Load", cbm: null, kgs: null, teu: null },
  ];
  res.json({ success: true, data: types });
});

// ─── Send rate by email ───────────────────────────────────────
router.post('/send-email', protect, requireKyc, async (req, res) => {
  const { rateId, recipientEmail, note } = req.body;
  if (!rateId || !recipientEmail) return res.status(400).json({ success: false, message: 'rateId and recipientEmail required' });

  const rate = await Rate.findById(rateId).lean();
  if (!rate) return res.status(404).json({ success: false, message: 'Rate not found' });

  const emailService = require('../services/emailService');
  const totalFreight = (rate.freightCharges || []).reduce((s, c) => s + (c.amount || 0), 0);
  const totalOrigin = (rate.originCharges || []).reduce((s, c) => s + (c.amount || 0), 0);
  const totalDest = (rate.destinationCharges || []).reduce((s, c) => s + (c.amount || 0), 0);

  await emailService.sendRateEmail(recipientEmail, {
    carrier: rate.shippingLine,
    originPort: rate.originPort,
    destinationPort: rate.destinationPort,
    mode: rate.mode,
    containerType: rate.containerType,
    transitTime: `${rate.transitTimeDays} Days`,
    sailingDate: rate.sailingDate,
    currency: 'USD',
    freightRate: totalFreight,
    totalRate: rate.totalUsd || (totalFreight + totalOrigin + totalDest),
    charges: {
      freight: rate.freightCharges || [],
      origin: rate.originCharges || [],
      destination: rate.destinationCharges || [],
    },
  }, note);

  res.json({ success: true, message: `Rate details sent to ${recipientEmail}` });
});

module.exports = router;

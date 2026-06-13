const express = require('express');
const router = express.Router();
const { Rate, Port, SearchLog } = require('../models');
const { protect, requireKyc } = require('../middleware/auth');
const { cache } = require('../config/db');
const { calculateAirQuote } = require('../utils/airFreight');

/* ═══════════════════════════════════════════════════════════
   ALL SPECIFIC ROUTES MUST COME BEFORE  /:id
   Express matches top-to-bottom — any GET /something will be
   caught by  /:id  if it is registered first.
═══════════════════════════════════════════════════════════ */

// ─── Port autocomplete ────────────────────────────────────────
// GET /api/rates/ports/search?q=&type=sea|air&limit=10
// When q is empty, returns up to `limit` ports (for initial dropdown)
router.get('/ports/search', protect, async (req, res) => {
  const { q = '', type = 'sea', limit = 15 } = req.query;
  const lim = Math.min(parseInt(limit) || 15, 30);

  const cacheKey = `ports:${type}:${q.slice(0, 3).toLowerCase() || '__all__'}`;
  let ports = await cache.get(cacheKey);

  if (!ports) {
    const query = { type, isActive: true };

    // If query string provided, do text search; otherwise return first N ports
    if (q.trim().length > 0) {
      query.$or = [
        { name:    new RegExp(q, 'i') },
        { code:    new RegExp(q, 'i') },
        { country: new RegExp(q, 'i') },
      ];
    }

    ports = await Port.find(query)
      .select('code name country countryCode region')
      .sort({ name: 1 })
      .limit(q.trim().length > 0 ? 20 : lim)
      .lean();

    await cache.set(cacheKey, ports, q.trim().length > 0 ? 3600 : 600);
  }

  // Client-side re-filter for the typed query (handles cached supersets)
  const filtered = q.trim().length > 0
    ? ports.filter(p =>
        p.name.toLowerCase().includes(q.toLowerCase()) ||
        p.code.toLowerCase().includes(q.toLowerCase()) ||
        (p.country || '').toLowerCase().includes(q.toLowerCase())
      ).slice(0, lim)
    : ports.slice(0, lim);

  res.json({ success: true, data: filtered });
});

// ─── Container / load types ───────────────────────────────────
router.get('/meta/load-types', async (req, res) => {
  const types = [
    { id: 1,  loadCode: '20GP', loadDescription: "20' General Purpose", cbm: 33.0,  kgs: 28000 },
    { id: 2,  loadCode: '40GP', loadDescription: "40' General Purpose", cbm: 67.4,  kgs: 26500 },
    { id: 3,  loadCode: '40HC', loadDescription: "40' High Cube",       cbm: 76.2,  kgs: 26580 },
    { id: 4,  loadCode: '45HC', loadDescription: "45' High Cube",       cbm: 86.0,  kgs: 29500 },
    { id: 5,  loadCode: '20RE', loadDescription: "20' Reefer",          cbm: 28.2,  kgs: 27400 },
    { id: 6,  loadCode: '40RE', loadDescription: "40' Reefer",          cbm: 64.9,  kgs: 29500 },
    { id: 7,  loadCode: '20OT', loadDescription: "20' Open Top",        cbm: 32.4,  kgs: 27700 },
    { id: 8,  loadCode: '40OT', loadDescription: "40' Open Top",        cbm: 66.2,  kgs: 35000 },
    { id: 9,  loadCode: '20FR', loadDescription: "20' Flat Rack",       cbm: 28.4,  kgs: 27940 },
    { id: 10, loadCode: '40FR', loadDescription: "40' Flat Rack",       cbm: 53.2,  kgs: 39000 },
    { id: 11, loadCode: 'LCL',  loadDescription: "Less Container Load", cbm: null,  kgs: null  },
  ];
  res.json({ success: true, data: types });
});

// ─── User's recent searches ───────────────────────────────────
// GET /api/rates/my-searches  — last 10 searches for the logged-in user
router.get('/my-searches', protect, async (req, res) => {
  const searches = await SearchLog.find({ user: req.user._id })
    .sort({ createdAt: -1 })
    .limit(10)
    .lean();

  const formatted = searches.map(s => ({
    id:         s._id.toString(),
    originCode: s.originPort,
    originName: s.originPort,
    destCode:   s.destinationPort,
    destName:   s.destinationPort,
    mode:       s.mode || 'SEA-FCL',
    load:       s.containerType || 'N/A',
    ago:        timeAgo(s.createdAt),
  }));

  res.json({ success: true, data: formatted });
});

function timeAgo(date) {
  const diff = Date.now() - new Date(date).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1)   return 'just now';
  if (mins < 60)  return `${mins} min ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24)   return `${hrs} hour${hrs > 1 ? 's' : ''} ago`;
  const days = Math.floor(hrs / 24);
  return `${days} day${days > 1 ? 's' : ''} ago`;
}

// ─── Rate search ──────────────────────────────────────────────
router.post('/search', protect, requireKyc, async (req, res) => {
  const {
    mode = 'SEA-FCL', originPort, destinationPort, containerType,
    sailingDate, sortBy = 'freightRateUsd',
    filterCarrier, filterDirect, filterCargo,
    page = 1, limit = 20,
  } = req.body;

  if (!originPort || !destinationPort)
    return res.status(400).json({ success: false, message: 'originPort and destinationPort required' });

  const orig = originPort.toUpperCase();
  const dest = destinationPort.toUpperCase();

  // FIX: don't include containerType in cache key — fetch all containers, filter in memory
  const cacheKey = `rates:${mode}:${orig}:${dest}`;
  let rates = await cache.get(cacheKey);

  if (!rates) {
    const query = {
      mode,
      originPort: orig,
      destinationPort: dest,
      isActive: true,
      // FIX: removed validFrom filter — validFrom means "rate available from this date",
      // not "rate must have been created in the past"
      $or: [{ validTo: null }, { validTo: { $gte: new Date() } }],
    };
    // FIX: do NOT filter by containerType in DB query — fetch all, filter in memory
    // This way the cache covers all containers for a route
    rates = await Rate.find(query).lean();
    await cache.set(cacheKey, rates, 300);
  }

  let filtered = [...rates];

  // FIX: containerType filter moved to in-memory so it works with the broader cache
  if (containerType) filtered = filtered.filter(r => !r.containerType || r.containerType === containerType);
  
  if (filterCarrier) filtered = filtered.filter(r => r.shippingLine?.toLowerCase().includes(filterCarrier.toLowerCase()));
  if (filterDirect === 'direct')   filtered = filtered.filter(r => !r.viaPort?.length);
  if (filterDirect === 'indirect') filtered = filtered.filter(r =>  r.viaPort?.length > 0);
  if (filterCargo && filterCargo !== 'All') filtered = filtered.filter(r => r.cargoType === filterCargo);
  if (sailingDate) {
    const sd = new Date(sailingDate);
    filtered = filtered.filter(r => !r.sailingDate || new Date(r.sailingDate) >= sd);
  }

  const sortMap = {
    freightRateUsd:  (a, b) => (a.freightRateUsd  || 0)   - (b.freightRateUsd  || 0),
    totalUsd:        (a, b) => (a.totalUsd         || 0)   - (b.totalUsd         || 0),
    transitTimeDays: (a, b) => (a.transitTimeDays  || 999) - (b.transitTimeDays  || 999),
    sailingDate:     (a, b) => new Date(a.sailingDate || 0) - new Date(b.sailingDate || 0),
    carrier:         (a, b) => (a.shippingLine || '').localeCompare(b.shippingLine || ''),
  };
  filtered.sort(sortMap[sortBy] || sortMap.freightRateUsd);

  const total     = filtered.length;
  const paginated = filtered.slice((page - 1) * limit, page * limit);
  const carriers      = [...new Set(rates.map(r => r.shippingLine).filter(Boolean))];
  const cargoTypes    = [...new Set(rates.map(r => r.cargoType).filter(Boolean))];
  const containerTypes= [...new Set(rates.map(r => r.containerType).filter(Boolean))];

  SearchLog.create({
    user: req.user._id, mode, originPort: orig, destinationPort: dest, containerType,
    sailingDate: sailingDate ? new Date(sailingDate) : null,
    resultsCount: total, ip: req.ip, userAgent: req.get('user-agent'),
  }).catch(() => {});

  res.json({
    success: true,
    data: {
      rates: paginated,
      pagination: { total, page, limit, pages: Math.ceil(total / limit) },
      filters: { carriers, cargoTypes, containerTypes },
      originPort: orig, destinationPort: dest, mode,
    },
  });
});

// GET /api/rates/air/search
router.post('/air/search', protect, requireKyc, async (req, res) => {
  try {
    const {
      originPort, destinationPort,
      actualKg = 0, lengthCm = 0, widthCm = 0, heightCm = 0, pieces = 1,
      page = 1, limit = 20,
    } = req.body;

    if (!originPort || !destinationPort) {
      return res.status(400).json({ success: false, message: 'originPort and destinationPort required' });
    }

    // ── Calculate cargo weights ──────────────────────────────
    const divisor  = 6000;
    const vwPerPiece = (parseFloat(lengthCm) * parseFloat(widthCm) * parseFloat(heightCm)) / divisor;
    const totalVW    = Math.round(vwPerPiece * parseInt(pieces) * 100) / 100;
    const totalAW    = Math.round(parseFloat(actualKg) * parseInt(pieces) * 100) / 100;
    const cw         = Math.max(totalVW, totalAW);

    // Build cargo object — field names must match what frontend uses
    const cargo = { totalAW, totalVW, cw, divisor };

    // ── Find matching air rates ──────────────────────────────
    const { AirRate } = require('../models');
    const { calculateAirQuote } = require('../utils/airFreight');

    const airRates = await AirRate.find({
      originPort:      originPort.toUpperCase(),
      destinationPort: destinationPort.toUpperCase(),
      isActive: true,
    }).lean();

    const results = airRates.map(r => {
      const quote = calculateAirQuote(r, { actualKg: totalAW / parseInt(pieces), lengthCm, widthCm, heightCm, pieces });
      return {
        _id:            r._id,
        _airRate:       true,
        carrier:        r.carrier,
        shippingLine:   r.carrier,
        originPort:     r.originPort,
        destinationPort:r.destinationPort,
        cargoType:      r.cargoType,
        vwDivisor:      r.vwDivisor || divisor,
        transitTime:    r.transitTime,
        validFrom:      r.validFrom,
        validTo:        r.validTo,
        slabs:          r.slabs,
        mode:           'AIR',
        quote,
      };
    }).filter(r => r.quote?.slab); // only return rates where a slab matched

    // Sort by freight cost ascending
    results.sort((a, b) => (a.quote?.freightCost || 0) - (b.quote?.freightCost || 0));

    const total = results.length;
    const paginated = results.slice((page - 1) * limit, page * limit);

    res.json({
      success: true,
      data: {
        rates:      paginated,
        cargo,                    // ← this is what the frontend reads
        pagination: {
          total,
          page:  parseInt(page),
          pages: Math.ceil(total / limit),
          limit: parseInt(limit),
        },
      },
    });

  } catch (err) {
    console.error('POST /rates/air/search error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── Send rate by email ───────────────────────────────────────
router.post('/send-email', protect, requireKyc, async (req, res) => {
  const { rateId, recipientEmail, note } = req.body;
  if (!rateId || !recipientEmail)
    return res.status(400).json({ success: false, message: 'rateId and recipientEmail required' });

  const rate = await Rate.findById(rateId).lean();
  if (!rate) return res.status(404).json({ success: false, message: 'Rate not found' });

  const emailService = require('../services/emailService');
  const totalFreight = (rate.freightCharges     || []).reduce((s, c) => s + (c.amount || 0), 0);
  const totalOrigin  = (rate.originCharges      || []).reduce((s, c) => s + (c.amount || 0), 0);
  const totalDest    = (rate.destinationCharges || []).reduce((s, c) => s + (c.amount || 0), 0);

  await emailService.sendRateEmail(recipientEmail, {
    carrier: rate.shippingLine, originPort: rate.originPort,
    destinationPort: rate.destinationPort, mode: rate.mode,
    containerType: rate.containerType, transitTime: `${rate.transitTimeDays} Days`,
    sailingDate: rate.sailingDate, currency: 'USD',
    freightRate: totalFreight,
    totalRate: rate.totalUsd || (totalFreight + totalOrigin + totalDest),
    charges: { freight: rate.freightCharges || [], origin: rate.originCharges || [], destination: rate.destinationCharges || [] },
  }, note);

  res.json({ success: true, message: `Rate details sent to ${recipientEmail}` });
});

// ─── Single rate — MUST be last ───────────────────────────────
router.get('/:id', protect, requireKyc, async (req, res) => {
  const rate = await Rate.findById(req.params.id).lean();
  if (!rate) return res.status(404).json({ success: false, message: 'Rate not found' });
  res.json({ success: true, data: rate });
});

module.exports = router;

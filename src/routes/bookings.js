const express = require('express');
const router = express.Router();
const { Booking, Enquiry, Admin, ActivityLog } = require('../models');
const { protect, requireKyc } = require('../middleware/auth');
const emailService = require('../services/emailService');

// ═══════════════════════════════════════════════════════
//  BOOKINGS
// ═══════════════════════════════════════════════════════

// ─── Create booking request ───────────────────────────────────
router.post('/', protect, requireKyc, async (req, res) => {
  try {
    // Log what we actually receive
    console.log('POST /bookings body keys:', Object.keys(req.body));
    console.log('mode:', req.body.mode, 'origin:', req.body.originPort, 'dest:', req.body.destinationPort);

    const mode           = req.body.mode;
    const originPort     = req.body.originPort;
    const destinationPort= req.body.destinationPort;

    if (!originPort || !destinationPort || !mode) {
      return res.status(400).json({
        success: false,
        message: `originPort (${originPort}), destinationPort (${destinationPort}), and mode (${mode}) are required`,
      });
    }

    const booking = await Booking.create({
      user:           req.user._id,
      rate:           req.body.rate || req.body.rateId || undefined,
      mode,
      originPort,
      destinationPort,
      carrier:        req.body.shippingLine || req.body.carrier || undefined,
      containerType:  mode === 'AIR' ? undefined : (req.body.containerType || undefined),
      cargoType:      req.body.cargoType     || 'FAK',
      commodity:      req.body.commodity     || undefined,
      hsCode:         req.body.hsCode        || undefined,
      incoterms:      mode === 'AIR' ? undefined : (req.body.incoterms || undefined),
      sailingDate:    req.body.sailingDate    ? new Date(req.body.sailingDate) : undefined,
      totalAmount:    req.body.totalAmount    ? parseFloat(req.body.totalAmount) : undefined,
      currency:       req.body.currency      || 'USD',
      pickupAddress:  req.body.pickupAddress  || undefined,
      deliveryAddress:req.body.deliveryAddress|| undefined,
      customerNotes:  req.body.customerNotes  || undefined,
      // Air-specific
      actualKg:      req.body.actualKg      ? parseFloat(req.body.actualKg)     : undefined,
      lengthCm:      req.body.lengthCm      ? parseFloat(req.body.lengthCm)     : undefined,
      widthCm:       req.body.widthCm       ? parseFloat(req.body.widthCm)      : undefined,
      heightCm:      req.body.heightCm      ? parseFloat(req.body.heightCm)     : undefined,
      pieces:        req.body.pieces        ? parseInt(req.body.pieces)          : undefined,
      chargeableKg:  req.body.chargeableKg  ? parseFloat(req.body.chargeableKg) : undefined,
    });

    // Notify admins
    const admins = await Admin.find({ isActive: true, role: { $in: ['admin', 'super_admin'] } })
      .select('email').limit(3).lean();
    for (const admin of admins) {
      await emailService.sendBookingAdminAlert(admin.email, booking, req.user).catch(() => {});
    }

    await emailService.sendBookingConfirmation(
      req.user?.officialEmail || req.user?.email,
      req.user?.name,
      booking
    ).catch(() => {});

    await ActivityLog.create({
      actor: req.user._id, actorModel: 'User',
      action: 'booking_created', resource: 'Booking', resourceId: booking._id,
    }).catch(() => {});

    res.status(201).json({
      success: true,
      message: 'Booking request submitted successfully.',
      data: {
        booking: {
          _id:        booking._id,
          bookingRef: booking.bookingRef,
          status:     booking.status,
        },
      },
    });

  } catch (err) {
    console.error('POST /bookings error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});



// ─── Get user's bookings ──────────────────────────────────────
router.get('/', protect, async (req, res) => {
  const { status, page = 1, limit = 20 } = req.query;
  const query = { user: req.user._id };
  if (status) query.status = status;

  const [bookings, total] = await Promise.all([
    Booking.find(query).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(parseInt(limit)).lean(),
    Booking.countDocuments(query),
  ]);

  res.json({ success: true, data: { bookings, pagination: { total, page: parseInt(page), pages: Math.ceil(total / limit) } } });
});

// ─── Get single booking ───────────────────────────────────────
router.get('/:id', protect, async (req, res) => {
  const booking = await Booking.findOne({ _id: req.params.id, user: req.user._id }).lean();
  if (!booking) return res.status(404).json({ success: false, message: 'Booking not found' });
  res.json({ success: true, data: booking });
});

// ═══════════════════════════════════════════════════════
//  ENQUIRIES (custom rate requests / match rate)
// ═══════════════════════════════════════════════════════

// ─── Create enquiry ───────────────────────────────────────────
router.post('/enquiries', protect, requireKyc, async (req, res) => {
  try {
    const {
      mode, originPort, destinationPort, containerType,
      targetRate, currency, cargoWeight, weightUnit,
      preferredLiner, preferredSailingDate, freeDays, charges, notes,
    } = req.body;

    const enquiry = await Enquiry.create({
      user: req.user._id,
      mode, originPort, destinationPort, containerType,
      targetRate, currency, cargoWeight, weightUnit,
      preferredLiner,
      preferredSailingDate: preferredSailingDate ? new Date(preferredSailingDate) : undefined,
      freeDays, charges, notes,
    });

    // Notify admins with full email alert  ← fixed
    const admins = await Admin.find({ isActive: true, role: { $in: ['admin', 'super_admin'] } })
      .select('email').limit(3).lean();
    for (const admin of admins) {
      await emailService.sendEnquiryAdminAlert(admin.email, enquiry, req.user).catch(() => {});
    }

    res.status(201).json({
      success: true,
      message: 'Rate enquiry submitted. Our team will respond within 24 hours.',
      enquiry: { _id: enquiry._id, enquiryRef: enquiry.enquiryRef, status: enquiry.status },
    });

  } catch (err) {
    console.error('POST /enquiries error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

router.get('/enquiries', protect, async (req, res) => {
  const { status, page = 1, limit = 20 } = req.query;
  const query = { user: req.user._id };
  if (status) query.status = status;

  const [enquiries, total] = await Promise.all([
    Enquiry.find(query).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(parseInt(limit)).lean(),
    Enquiry.countDocuments(query),
  ]);

  res.json({ success: true, data: { enquiries, pagination: { total, page: parseInt(page), pages: Math.ceil(total / limit) } } });
});

module.exports = router;

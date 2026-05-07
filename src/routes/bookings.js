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
  const {
    rateId, mode, originPort, destinationPort, carrier, containerType,
    containers, cargoType, commodity, hsCode, incoterms, sailingDate,
    totalAmount, currency, pickupAddress, deliveryAddress, customerNotes,
  } = req.body;

  if (!originPort || !destinationPort || !mode) {
    return res.status(400).json({ success: false, message: 'originPort, destinationPort, and mode are required' });
  }

  const booking = await Booking.create({
    user: req.user._id,
    rate: rateId,
    mode, originPort, destinationPort, carrier, containerType,
    containers, cargoType, commodity, hsCode, incoterms,
    sailingDate: sailingDate ? new Date(sailingDate) : undefined,
    totalAmount, currency,
    pickupAddress, deliveryAddress,
    customerNotes,
  });

  // Notify admin(s)
  const admins = await Admin.find({ isActive: true, role: { $in: ['admin', 'super_admin'] } }).select('email').limit(3);
  for (const admin of admins) {
    await emailService.sendBookingAdminAlert(admin.email, booking, req.user).catch(() => {});
  }

  // Log activity
  await ActivityLog.create({ actor: req.user._id, actorModel: 'User', action: 'booking_created', resource: 'Booking', resourceId: booking._id });

  res.status(201).json({
    success: true,
    message: 'Booking request submitted successfully. You will receive a confirmation within 24 hours.',
    booking: { _id: booking._id, bookingRef: booking.bookingRef, status: booking.status },
  });
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

  // Notify admins
  const admins = await Admin.find({ isActive: true }).select('email').limit(3);
  for (const admin of admins) {
    await emailService.send?.({
      to: admin.email,
      subject: `New enquiry ${enquiry.enquiryRef} — ${originPort} → ${destinationPort}`,
      html: `<p>New rate enquiry submitted by ${req.user.name}. <a href="${process.env.ADMIN_URL}/enquiries/${enquiry._id}">View in admin portal</a></p>`,
    }).catch(() => {});
  }

  res.status(201).json({
    success: true,
    message: 'Rate enquiry submitted. Our team will respond within 24 hours.',
    enquiry: { _id: enquiry._id, enquiryRef: enquiry.enquiryRef, status: enquiry.status },
  });
});

// ─── Get user's enquiries ─────────────────────────────────────
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

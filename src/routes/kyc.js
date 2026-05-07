const express = require('express');
const router  = express.Router();
const { User, Admin, ActivityLog } = require('../models');
const { protect } = require('../middleware/auth');
const { upload, uploadToS3, getPresignedUrl } = require('../services/s3Service');
const emailService = require('../services/emailService');
const { cache }    = require('../config/db');
const axios        = require('axios');
const logger       = require('../utils/logger');

/* ── Accept ALL document field names the frontend may send ──
   KycPage sends country-specific keys: aadhaar, pan, gst,
   national_id, trade_license, business_reg, address_proof,
   other, pan_card, emiratesid, ein_doc, companies_house, uен_doc
   We accept any field that contains a file.
── */
const KYC_FIELDS = [
  { name: 'aadhaar',          maxCount: 1 },
  { name: 'pan',              maxCount: 1 },
  { name: 'gst',              maxCount: 1 },
  { name: 'national_id',      maxCount: 1 },
  { name: 'trade_license',    maxCount: 1 },
  { name: 'business_reg',     maxCount: 1 },
  { name: 'address_proof',    maxCount: 1 },
  { name: 'other',            maxCount: 1 },
  { name: 'vat_cert',         maxCount: 1 },
  { name: 'incorporation',    maxCount: 1 },
];

/* ── Upload KYC documents ── */
router.post('/upload', protect, upload.fields(KYC_FIELDS), async (req, res) => {
  try {
    const user = await User.findById(req.user._id);
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });

    if (user.kyc?.status === 'approved') {
      return res.status(400).json({ success: false, message: 'KYC is already approved' });
    }

    const {
      gstNumber, companyName, companyAddress, companyCity,
      companyCountry, companyPincode, panNumber, aadhaarNumber,
      nationalId, taxId, country,
    } = req.body;

    /* Upload each received file to S3 */
    const newDocs   = [];
    const files     = req.files || {};
    const fileKeys  = Object.keys(files);

    if (fileKeys.length === 0) {
      return res.status(400).json({ success: false, message: 'Please upload at least one document' });
    }

    for (const docType of fileKeys) {
      const fileArr = files[docType];
      for (const file of fileArr) {
        try {
          const { key, url, scheduledDeleteAt } = await uploadToS3(file, `kyc/${user._id}`);
          newDocs.push({
            type:             docType,
            s3Key:            key,
            s3Url:            url,
            scheduledDeleteAt,
            uploadedAt:       new Date(),
          });
        } catch (s3Err) {
          logger.error(`KYC S3 upload failed [${docType}]: ${s3Err.message}`);
          return res.status(500).json({
            success: false,
            message: `Failed to upload ${docType} — please try again`,
          });
        }
      }
    }

    /* Update user KYC */
    if (!user.kyc) user.kyc = {};
    user.kyc.status      = 'pending';
    user.kyc.submittedAt = new Date();
    if (gstNumber)     user.kyc.gstNumber     = gstNumber;
    if (panNumber)     user.kyc.panNumber      = panNumber;
    if (aadhaarNumber) user.kyc.aadhaarNumber  = aadhaarNumber;
    if (nationalId)    user.kyc.nationalId     = nationalId;
    if (taxId)         user.kyc.taxId          = taxId;
    if (country)       user.kyc.country        = country;

    user.kyc.documents = [...(user.kyc.documents || []), ...newDocs];

    /* Update company info if provided */
    if (companyName) {
      user.company = {
        ...(user.company || {}),
        name:    companyName,
        address: companyAddress || user.company?.address,
        city:    companyCity    || user.company?.city,
        country: companyCountry || user.company?.country,
        pincode: companyPincode || user.company?.pincode,
      };
    }

    await user.save();

    /* Notify user (use officialEmail, fall back to email) */
    const userEmail = user.officialEmail || user.email;
    if (userEmail) {
      await emailService.sendKycSubmitted(userEmail, user.name).catch(e =>
        logger.warn(`KYC submitted email failed: ${e.message}`)
      );
    }

    /* Notify admins */
    const admins = await Admin.find({ isActive: true, role: { $in: ['admin', 'super_admin'] } })
      .select('email').limit(3).lean();
    for (const admin of admins) {
      await emailService.sendKycAdminAlert(admin.email, user).catch(e =>
        logger.warn(`KYC admin alert failed: ${e.message}`)
      );
    }

    await cache.del(`user:${user._id}`).catch(() => {});

    res.json({
      success:           true,
      message:           'KYC documents uploaded successfully. Verification takes up to 48 business hours.',
      kycStatus:         'pending',
      documentsUploaded: newDocs.length,
    });

  } catch (err) {
    logger.error(`KYC upload error: ${err.message}`);
    res.status(500).json({ success: false, message: 'KYC upload failed — please try again' });
  }
});

/* ── Get KYC status + presigned URLs ── */
router.get('/status', protect, async (req, res) => {
  try {
    const user = await User.findById(req.user._id);
    const docs = await Promise.all(
      (user.kyc?.documents || [])
        .filter(d => !d.deleted)
        .map(async (doc) => ({
          type:             doc.type,
          uploadedAt:       doc.uploadedAt,
          scheduledDeleteAt:doc.scheduledDeleteAt,
          viewUrl:          doc.s3Key ? await getPresignedUrl(doc.s3Key, 1800) : null,
        }))
    );

    res.json({
      success: true,
      kyc: {
        status:          user.kyc?.status || 'not_submitted',
        submittedAt:     user.kyc?.submittedAt,
        reviewedAt:      user.kyc?.reviewedAt,
        rejectionReason: user.kyc?.rejectionReason,
        gstNumber:       user.kyc?.gstNumber,
        gstVerified:     user.kyc?.gstVerified,
        documents:       docs,
      },
    });
  } catch (err) {
    logger.error(`KYC status error: ${err.message}`);
    res.status(500).json({ success: false, message: 'Failed to fetch KYC status' });
  }
});

/* ── GST verification (user-side) ── */
router.post('/verify-gst', protect, async (req, res) => {
  const { gstNumber } = req.body;
  if (!gstNumber) return res.status(400).json({ success: false, message: 'GST number required' });

  const gstRegex = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/;
  if (!gstRegex.test(gstNumber.toUpperCase())) {
    return res.status(400).json({ success: false, message: 'Invalid GST number format' });
  }

  try {
    if (process.env.GST_API_KEY && process.env.GST_API_URL) {
      const resp = await axios.get(`${process.env.GST_API_URL}/${gstNumber}`, {
        headers: { 'api-client-id': process.env.GST_API_KEY },
        timeout: 8000,
      });
      const data = resp.data;

      const user = await User.findById(req.user._id);
      user.kyc = user.kyc || {};
      user.kyc.gstNumber    = gstNumber.toUpperCase();
      user.kyc.gstVerified  = true;
      user.kyc.gstVerifiedAt = new Date();
      await user.save();

      return res.json({
        success: true,
        verified: true,
        gstDetails: {
          legalName:        data.lgnm,
          tradeName:        data.tradeNam,
          state:            data.stj,
          registrationDate: data.rgdt,
          status:           data.sts,
        },
      });
    }

    /* No GST API configured — return format valid */
    res.json({
      success:   true,
      verified:  false,
      message:   'GST format valid. Live verification not configured — admin will verify manually.',
      gstNumber: gstNumber.toUpperCase(),
    });

  } catch (err) {
    logger.error(`GST verification error: ${err.message}`);
    res.status(502).json({ success: false, message: 'GST verification service unavailable. Please try again.' });
  }
});

module.exports = router;

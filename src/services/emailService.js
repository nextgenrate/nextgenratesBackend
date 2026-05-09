const nodemailer = require('nodemailer');
const logger = require('../utils/logger');

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,          // smtppro.zoho.in
  port: parseInt(process.env.SMTP_PORT || '465'),
  secure: true,                          // ← true for port 465 SSL
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
  tls: {
    rejectUnauthorized: false,
  },
  connectionTimeout: 10000,
  greetingTimeout: 10000,
  socketTimeout: 15000,
  pool: true,
  maxConnections: 5,
});

const NG = { navy: '#0D1B5E', blue: '#1A3CC8', accent: '#00C2FF', white: '#FFFFFF' };

const base = (content) => `<!DOCTYPE html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  body{margin:0;padding:0;background:#EEF3FF;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif}
  .wrap{max-width:600px;margin:32px auto;background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 8px 32px rgba(13,27,94,.12)}
  .hd{background:linear-gradient(135deg,${NG.navy},#162299);padding:28px 32px;text-align:center}
  .hd-logo{font-size:22px;font-weight:900;color:#fff;letter-spacing:-.3px}
  .hd-logo span{color:${NG.accent}}
  .hd-sub{font-size:12px;color:rgba(255,255,255,.5);margin-top:4px}
  .bd{padding:32px}
  .otp-box{font-size:40px;font-weight:900;letter-spacing:10px;color:${NG.navy};padding:22px;text-align:center;background:#EEF3FF;border-radius:12px;border:2px dashed ${NG.blue};margin:22px 0;font-family:ui-monospace,monospace}
  .info-row{display:flex;padding:9px 0;border-bottom:1px solid #F1F5F9;font-size:13px}
  .info-label{color:#7B8EC0;width:180px;flex-shrink:0;font-weight:600}
  .info-val{color:#0D1535;font-weight:700}
  .btn{display:inline-block;padding:13px 28px;background:linear-gradient(135deg,${NG.blue},#1E50FF);color:#fff;text-decoration:none;border-radius:10px;font-size:14px;font-weight:800;margin:20px 0;box-shadow:0 4px 14px rgba(26,60,200,.35)}
  .step-row{display:flex;gap:10px;align-items:flex-start;margin-bottom:10px}
  .step-num{width:22px;height:22px;border-radius:50%;background:#FEF08A;border:1px solid #FDE68A;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:800;color:#92400E;flex-shrink:0}
  .ft{background:#F0F4FF;padding:18px 32px;text-align:center;font-size:12px;color:#7B8EC0}
</style></head><body>
<div class="wrap">
  <div class="hd">
    <div class="hd-logo">NEXT GEN <span>RATES</span></div>
    <div class="hd-sub">Instant Freight Rates Re-Imagined!</div>
  </div>
  <div class="bd">${content}</div>
  <div class="ft">© ${new Date().getFullYear()} Next Gen Rates. All rights reserved.<br>This is an automated email — please do not reply.</div>
</div></body></html>`;

const send = async ({ to, subject, html }) => {
  try {
    await transporter.sendMail({
      from: `"Next Gen Rates" <${process.env.SMTP_FROM || process.env.SMTP_USER}>`,
      to, subject, html,
    });
    logger.info(`Email → ${to}: ${subject}`);
  } catch (err) {
    logger.error(`Email failed → ${to}: ${err.message}`);
    throw err;
  }
};

const emailService = {

  /* OTP for registration / password reset */
  sendRegistrationOtp: async (to, otp, purpose = 'registration') => {
    const label = purpose === 'password_reset' ? 'Password Reset' : 'Company Registration';
    await send({
      to,
      subject: `${otp} — Your Next Gen Rates ${label} OTP`,
      html: base(`
        <h2 style="color:#0D1535;font-size:20px;margin:0 0 8px;font-weight:900">${label} OTP</h2>
        <p style="color:#3A4A7A;line-height:1.7">Please use the following OTP to verify your ${purpose === 'password_reset' ? 'identity' : 'email address'}. This code expires in <strong>10 minutes</strong>.</p>
        <div class="otp-box">${otp}</div>
        <p style="color:#7B8EC0;font-size:12px">⚠️ Never share this OTP with anyone. Next Gen Rates will never ask for your OTP by phone or email.</p>
      `),
    });
  },

  /* Legacy sendOtp (keeps compatibility) */
  sendOtp: async (to, name, otp, purpose = 'verification') => {
    await emailService.sendRegistrationOtp(to, otp, purpose);
  },

  /* Registration acknowledgement to applicant */
  sendRegistrationReceived: async (to, contactName, companyName, userId) => {
    const appId = `NGR-${userId.slice(-8).toUpperCase()}`;
    await send({
      to,
      subject: `Registration Received — Application ID: ${appId}`,
      html: base(`
        <h2 style="color:#0D1535;font-size:20px;font-weight:900;margin:0 0 12px">Registration Submitted! ✅</h2>
        <p style="color:#3A4A7A;line-height:1.7">Dear <strong>${contactName}</strong>,<br><br>
        Thank you for registering <strong>${companyName}</strong> on the Next Gen Rates platform. Your application has been received and is currently under review by our compliance team.</p>
        <div style="background:#EEF3FF;border-radius:12px;padding:18px 22px;margin:20px 0;text-align:center">
          <div style="font-size:12px;color:#7B8EC0;font-weight:700;text-transform:uppercase;letter-spacing:.5px">Application ID</div>
          <div style="font-size:28px;font-weight:900;color:#1A3CC8;font-family:ui-monospace,monospace;margin-top:6px">${appId}</div>
        </div>
        <div style="background:#FFF8E6;border:1px solid #FDE68A;border-radius:12px;padding:16px 20px;margin:16px 0">
          <p style="color:#C47B00;font-weight:800;font-size:13px;margin:0 0 10px">What happens next:</p>
          <div class="step-row"><div class="step-num">1</div><span style="font-size:13px;color:#78350F">Our team reviews your company documents</span></div>
          <div class="step-row"><div class="step-num">2</div><span style="font-size:13px;color:#78350F">Account is activated upon approval</span></div>
          <div class="step-row"><div class="step-num">3</div><span style="font-size:13px;color:#78350F">You receive account activation confirmation by email</span></div>
          <div class="step-row"><div class="step-num">4</div><span style="font-size:13px;color:#78350F">Sign in and start searching real-time freight rates</span></div>
        </div>
        <p style="color:#7B8EC0;font-size:13px">Questions? Contact us at <a href="mailto:${process.env.ADMIN_EMAIL||'support@nextgenrates.com'}" style="color:#1A3CC8">${process.env.ADMIN_EMAIL||'support@nextgenrates.com'}</a></p>
      `),
    });
  },

  /* Admin alert — new registration arrived */
  sendAdminRegistrationAlert: async (user) => {
    const adminEmail = process.env.ADMIN_EMAIL;
    if (!adminEmail) return;
    const appId = `NGR-${user._id.toString().slice(-8).toUpperCase()}`;
    const docs = user.registrationDocuments?.length || 0;
    await send({
      to: adminEmail,
      subject: `🆕 New Registration: ${user.company?.name} (${user.company?.country}) — ${appId}`,
      html: base(`
        <h2 style="color:#0D1535;font-size:18px;font-weight:900;margin:0 0 16px">New Company Registration</h2>
        <div style="background:#EEF3FF;border-radius:10px;padding:16px 20px;margin-bottom:18px">
          <div class="info-row"><span class="info-label">Application ID</span><span class="info-val" style="color:#1A3CC8;font-family:ui-monospace">${appId}</span></div>
          <div class="info-row"><span class="info-label">Company Name</span><span class="info-val">${user.company?.name}</span></div>
          <div class="info-row"><span class="info-label">Company Type</span><span class="info-val">${user.company?.type}</span></div>
          <div class="info-row"><span class="info-label">Country</span><span class="info-val">${user.company?.country}</span></div>
          <div class="info-row"><span class="info-label">Contact Person</span><span class="info-val">${user.name}</span></div>
          <div class="info-row"><span class="info-label">Official Email</span><span class="info-val">${user.officialEmail}</span></div>
          <div class="info-row"><span class="info-label">Mobile</span><span class="info-val">${user.mobile || '—'}</span></div>
          <div class="info-row"><span class="info-label">Director</span><span class="info-val">${user.director?.name || '—'}</span></div>
          <div class="info-row"><span class="info-label">Director Email</span><span class="info-val">${user.director?.email || '—'}</span></div>
          <div class="info-row"><span class="info-label">Incorporation Date</span><span class="info-val">${user.company?.incorporationDate ? new Date(user.company.incorporationDate).toLocaleDateString('en-IN') : '—'}</span></div>
          <div class="info-row"><span class="info-label">VAT / GST / TAX</span><span class="info-val">${user.company?.vatGstTaxNo || '—'}</span></div>
          <div class="info-row" style="border:none"><span class="info-label">Documents Uploaded</span><span class="info-val" style="color:${docs > 0 ? '#0A8A56' : '#D91A1A'}">${docs} file${docs !== 1 ? 's' : ''}</span></div>
        </div>
        <div style="text-align:center">
          <a href="${process.env.ADMIN_URL || 'http://localhost:3001'}/registrations" class="btn">Review Application →</a>
        </div>
      `),
    });
  },

  /* Account activated — sent by admin after approval */
  sendAccountActivated: async (to, name, loginUrl) => {
    await send({
      to,
      subject: `Your Next Gen Rates Account is Active! 🎉`,
      html: base(`
        <h2 style="color:#0D1535;font-size:20px;font-weight:900;margin:0 0 12px">Account Activated! 🎉</h2>
        <p style="color:#3A4A7A;line-height:1.7">Hi <strong>${name}</strong>,<br><br>Great news! Your Next Gen Rates account has been verified and is now active. You can sign in using your registered email and the password you set during registration.</p>
        <div style="text-align:center">
          <a href="${loginUrl}" class="btn">Sign In Now →</a>
        </div>
        <p style="color:#7B8EC0;font-size:13px;text-align:center">Access real-time freight rates from 50+ carriers worldwide.</p>
      `),
    });
  },

  /* Booking notifications */
  sendBookingConfirmation: async (to, name, booking) => {
    await send({
      to,
      subject: `Booking Received — ${booking.bookingRef}`,
      html: base(`
        <h2 style="color:#0D1535;font-size:20px;font-weight:900;margin:0 0 12px">Booking Request Received</h2>
        <p style="color:#3A4A7A">Hi <strong>${name}</strong>, your booking request has been received.</p>
        <div style="background:#EEF3FF;border-radius:10px;padding:14px 18px;margin:16px 0;font-family:ui-monospace;font-size:20px;font-weight:900;color:#1A3CC8;text-align:center">${booking.bookingRef}</div>
        <div class="info-row"><span class="info-label">Route</span><span class="info-val">${booking.originPort} → ${booking.destinationPort}</span></div>
        <div class="info-row" style="border:none"><span class="info-label">Mode</span><span class="info-val">${booking.mode}</span></div>
      `),
    });
  },
};

module.exports = emailService;

// KYC approved notification
emailService.sendKycApproved = async (to, name, loginUrl) => {
  await send({
    to,
    subject: `KYC Approved — You now have full access to Next Gen Rates!`,
    html: base(`
      <h2 style="color:#0D1535;font-size:20px;font-weight:900;margin:0 0 12px;font-family:'Outfit',sans-serif">KYC Verified! ✅</h2>
      <p style="color:#3A4A7A;line-height:1.7">Hi <strong>${name}</strong>,<br><br>
      Great news! Your KYC verification has been <strong style="color:#0A8A56">approved</strong>. You now have full access to the Next Gen Rates platform.</p>
      <div style="text-align:center;margin:24px 0">
        <a href="${loginUrl}" style="display:inline-block;padding:13px 28px;background:linear-gradient(135deg,#1A3CC8,#1E50FF);color:#fff;text-decoration:none;border-radius:10px;font-size:14px;font-weight:800;box-shadow:0 4px 14px rgba(26,60,200,.35)">Access Platform →</a>
      </div>
      <p style="color:#7B8EC0;font-size:13px">You can now search real-time rates from 50+ carriers, create bookings, and send enquiries.</p>
    `),
  });
};

// KYC rejected notification
emailService.sendKycRejected = async (to, name, reason, loginUrl) => {
  await send({
    to,
    subject: `KYC Action Required — Please Re-upload Your Documents`,
    html: base(`
      <h2 style="color:#0D1535;font-size:20px;font-weight:900;margin:0 0 12px;font-family:'Outfit',sans-serif">KYC Documents Need Attention</h2>
      <p style="color:#3A4A7A;line-height:1.7">Hi <strong>${name}</strong>,<br><br>
      Unfortunately, we were unable to verify your KYC documents. Please re-upload corrected documents to complete verification.</p>
      <div style="padding:14px 18px;background:#FFF1F0;border:1px solid #FFCCC7;border-radius:12px;margin:18px 0">
        <div style="font-size:12px;font-weight:800;color:#D91A1A;margin-bottom:6px">Reason for rejection:</div>
        <div style="font-size:13px;color:#7F1D1D;line-height:1.6">${reason || 'Documents could not be verified. Please ensure they are clear and legible.'}</div>
      </div>
      <div style="text-align:center;margin:20px 0">
        <a href="${loginUrl}" style="display:inline-block;padding:13px 28px;background:linear-gradient(135deg,#1A3CC8,#1E50FF);color:#fff;text-decoration:none;border-radius:10px;font-size:14px;font-weight:800;">Re-upload Documents →</a>
      </div>
    `),
  });
};

// KYC documents submitted — notify user
emailService.sendKycSubmitted = async (to, name) => {
  await send({
    to,
    subject: `KYC Documents Received — Next Gen Rates`,
    html: base(`
      <h2 style="color:#0D1535;font-size:20px;font-weight:900;margin:0 0 12px;font-family:'Outfit',sans-serif">KYC Documents Received ✅</h2>
      <p style="color:#3A4A7A;line-height:1.7">Hi <strong>${name}</strong>,<br><br>
      We have received your KYC verification documents. Our compliance team will review them within <strong>48 business hours</strong>.</p>
      <div style="padding:14px 18px;background:#FFF8E6;border:1px solid #FDE68A;border-radius:12px;margin:18px 0">
        <div style="font-size:12px;font-weight:800;color:#C47B00;margin-bottom:6px">What happens next?</div>
        <div style="font-size:13px;color:#78350F;line-height:1.7">
          1. Our team reviews your identity documents<br>
          2. You receive a confirmation email with the result<br>
          3. Once approved, you get full access to rate search and bookings
        </div>
      </div>
      <p style="color:#7B8EC0;font-size:13px">If you have any questions, contact us at <a href="mailto:${process.env.ADMIN_EMAIL||'support@nextgenrates.com'}" style="color:#1A3CC8">${process.env.ADMIN_EMAIL||'support@nextgenrates.com'}</a></p>
    `),
  });
};

// KYC submitted — notify admin
emailService.sendKycAdminAlert = async (to, user) => {
  await send({
    to,
    subject: `KYC Submitted: ${user.name} (${user.company?.name || 'N/A'})`,
    html: base(`
      <h2 style="color:#0D1535;font-size:18px;font-weight:900;margin:0 0 14px;font-family:'Outfit',sans-serif">New KYC Submission</h2>
      <div style="background:#EEF3FF;border-radius:10px;padding:16px 18px;margin-bottom:18px">
        <div style="display:flex;padding:7px 0;border-bottom:1px solid #D4DCFF;font-size:13px"><span style="width:160px;color:#7B8EC0;font-weight:600;flex-shrink:0">Name</span><strong style="color:#0D1535">${user.name}</strong></div>
        <div style="display:flex;padding:7px 0;border-bottom:1px solid #D4DCFF;font-size:13px"><span style="width:160px;color:#7B8EC0;font-weight:600;flex-shrink:0">Email</span><strong style="color:#0D1535">${user.officialEmail||user.email||'N/A'}</strong></div>
        <div style="display:flex;padding:7px 0;border-bottom:1px solid #D4DCFF;font-size:13px"><span style="width:160px;color:#7B8EC0;font-weight:600;flex-shrink:0">Company</span><strong style="color:#0D1535">${user.company?.name||'N/A'}</strong></div>
        <div style="display:flex;padding:7px 0;font-size:13px"><span style="width:160px;color:#7B8EC0;font-weight:600;flex-shrink:0">Country</span><strong style="color:#0D1535">${user.company?.country||user.kyc?.country||'N/A'}</strong></div>
      </div>
      <div style="text-align:center">
        <a href="${process.env.ADMIN_URL||'http://localhost:3001'}/kyc" style="display:inline-block;padding:13px 28px;background:linear-gradient(135deg,#1A3CC8,#1E50FF);color:#fff;text-decoration:none;border-radius:10px;font-size:14px;font-weight:800;box-shadow:0 4px 14px rgba(26,60,200,.35)">Review KYC →</a>
      </div>
    `),
  });
};

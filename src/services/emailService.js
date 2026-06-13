const nodemailer = require('nodemailer');
const logger = require('../utils/logger');
const axios = require('axios');

async function getAccessToken() {
  const res = await axios.post(
    'https://accounts.zoho.in/oauth/v2/token',
    null,
    {
      params: {
        refresh_token: process.env.ZOHO_REFRESH_TOKEN,
        client_id: process.env.ZOHO_CLIENT_ID,
        client_secret: process.env.ZOHO_CLIENT_SECRET,
        grant_type: 'refresh_token',
      },
    }
  );

  return res.data.access_token;
}

const NG = { navy: '#0D1B5E', blue: '#1A3CC8', accent: '#00C2FF', white: '#FFFFFF' };
const base = (content) => `
<div style="font-family:sans-serif;max-width:600px;margin:auto">
  ${content}
</div>
`;
const send = async ({ to, subject, html }) => {
  try {
    const token = await getAccessToken();

    // Use mail.zoho.in for Indian accounts
    const url = `https://mail.zoho.in/api/accounts/${process.env.ZOHO_ACCOUNT_ID}/messages`;

    const res = await axios.post(url,
      {
        fromAddress: process.env.ZOHO_FROM,
        toAddress: to,
        subject: subject,
        content: html,
        mailFormat: "html",   // ← correct key is mailFormat, not contentType
      },
      {
        headers: {
          Authorization: `Zoho-oauthtoken ${token}`,
          "Content-Type": "application/json",
          "Accept": "application/json",   // ← was missing
        },
      }
    );

    console.log("Zoho success:", res.data);
    return res.data;

  } catch (err) {
    console.error("Zoho FULL ERROR:", err.response?.data || err.message);
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
sendEnquiryAdminAlert : async (to, enquiry, user) => {
  if (!to) return;
  const fmtD = d => d ? new Date(d).toLocaleDateString('en-IN', { day:'2-digit', month:'short', year:'numeric' }) : '—';
  await send({
    to,
    subject: `📋 New Rate Enquiry — ${enquiry.enquiryRef} | ${enquiry.originPort} → ${enquiry.destinationPort}`,
    html: base(`
      <h2 style="color:#0D1535;font-size:18px;font-weight:900;margin:0 0 16px">New Rate Enquiry Received</h2>
      <div style="background:#EEF3FF;border-radius:10px;padding:16px 18px;margin-bottom:18px">
        <div style="display:flex;padding:7px 0;border-bottom:1px solid #D4DCFF;font-size:13px"><span style="width:170px;color:#7B8EC0;font-weight:600;flex-shrink:0">Enquiry Ref</span><strong style="color:#1A3CC8;font-family:ui-monospace">${enquiry.enquiryRef}</strong></div>
        <div style="display:flex;padding:7px 0;border-bottom:1px solid #D4DCFF;font-size:13px"><span style="width:170px;color:#7B8EC0;font-weight:600;flex-shrink:0">Customer</span><strong style="color:#0D1535">${user?.name || '—'}</strong></div>
        <div style="display:flex;padding:7px 0;border-bottom:1px solid #D4DCFF;font-size:13px"><span style="width:170px;color:#7B8EC0;font-weight:600;flex-shrink:0">Email</span><strong style="color:#0D1535">${user?.officialEmail || user?.email || '—'}</strong></div>
        <div style="display:flex;padding:7px 0;border-bottom:1px solid #D4DCFF;font-size:13px"><span style="width:170px;color:#7B8EC0;font-weight:600;flex-shrink:0">Company</span><strong style="color:#0D1535">${user?.company?.name || '—'}</strong></div>
        <div style="display:flex;padding:7px 0;border-bottom:1px solid #D4DCFF;font-size:13px"><span style="width:170px;color:#7B8EC0;font-weight:600;flex-shrink:0">Route</span><strong style="color:#0D1535">${enquiry.originPort} → ${enquiry.destinationPort}</strong></div>
        <div style="display:flex;padding:7px 0;border-bottom:1px solid #D4DCFF;font-size:13px"><span style="width:170px;color:#7B8EC0;font-weight:600;flex-shrink:0">Mode</span><strong style="color:#0D1535">${enquiry.mode || '—'}</strong></div>
        <div style="display:flex;padding:7px 0;border-bottom:1px solid #D4DCFF;font-size:13px"><span style="width:170px;color:#7B8EC0;font-weight:600;flex-shrink:0">Container</span><strong style="color:#0D1535">${enquiry.containerType || '—'}</strong></div>
        <div style="display:flex;padding:7px 0;border-bottom:1px solid #D4DCFF;font-size:13px"><span style="width:170px;color:#7B8EC0;font-weight:600;flex-shrink:0">Target Rate</span><strong style="color:#0D1535">${enquiry.currency || 'USD'} ${enquiry.targetRate?.toLocaleString() || '—'}</strong></div>
        <div style="display:flex;padding:7px 0;border-bottom:1px solid #D4DCFF;font-size:13px"><span style="width:170px;color:#7B8EC0;font-weight:600;flex-shrink:0">Cargo Weight</span><strong style="color:#0D1535">${enquiry.cargoWeight ? `${enquiry.cargoWeight} ${enquiry.weightUnit || 'KG'}` : '—'}</strong></div>
        <div style="display:flex;padding:7px 0;border-bottom:1px solid #D4DCFF;font-size:13px"><span style="width:170px;color:#7B8EC0;font-weight:600;flex-shrink:0">Preferred Liner</span><strong style="color:#0D1535">${enquiry.preferredLiner || 'Any'}</strong></div>
        <div style="display:flex;padding:7px 0;border-bottom:1px solid #D4DCFF;font-size:13px"><span style="width:170px;color:#7B8EC0;font-weight:600;flex-shrink:0">Preferred Sailing</span><strong style="color:#0D1535">${fmtD(enquiry.preferredSailingDate)}</strong></div>
        <div style="display:flex;padding:7px 0;font-size:13px"><span style="width:170px;color:#7B8EC0;font-weight:600;flex-shrink:0">Free Days</span><strong style="color:#0D1535">${enquiry.freeDays || '—'}</strong></div>
      </div>
      ${enquiry.notes ? `
      <div style="padding:12px 16px;background:#FFF8E6;border:1px solid #FDE68A;border-radius:10px;margin-bottom:18px">
        <div style="font-size:11px;font-weight:700;color:#C47B00;margin-bottom:5px">CUSTOMER NOTES</div>
        <div style="font-size:13px;color:#78350F;line-height:1.6">${enquiry.notes}</div>
      </div>` : ''}
      <div style="text-align:center">
        <a href="${process.env.ADMIN_URL || 'http://localhost:3001'}/enquiries"
          style="display:inline-block;padding:13px 28px;background:linear-gradient(135deg,#1A3CC8,#1E50FF);color:#fff;text-decoration:none;border-radius:10px;font-size:14px;font-weight:800;box-shadow:0 4px 14px rgba(26,60,200,.35)">
          Respond to Enquiry →
        </a>
      </div>
    `),
  });
},
  
  sendBookingConfirmation: async (to, name, booking) => {
    if (!to) return;

    const fmtDate = d => d ? new Date(d).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '—';
    const fmtAmt  = (amt, cur) => amt ? `${cur || 'USD'} ${Number(amt).toLocaleString('en-IN', { minimumFractionDigits: 2 })}` : '—';

    const row = (label, value, mono = false) => `
      <tr>
        <td style="padding:10px 14px;font-size:12px;font-weight:700;color:#7B8EC0;text-transform:uppercase;letter-spacing:0.05em;width:48%;vertical-align:top;border-bottom:1px solid #E8EEFF;">${label}</td>
        <td style="padding:10px 14px;font-size:13px;font-weight:700;color:#0D1535;vertical-align:top;border-bottom:1px solid #E8EEFF;${mono ? 'font-family:ui-monospace,monospace;' : ''}">${value || '—'}</td>
      </tr>`;

    const addrBlock = (label, addr) => {
      if (!addr || !addr.company) return '';
      const lines = [addr.company, addr.contact, addr.street, [addr.city, addr.country, addr.postalCode].filter(Boolean).join(', '), addr.phone, addr.email].filter(Boolean);
      return `
        <div style="flex:1;min-width:220px;background:#F7F9FF;border:1px solid #DDE5F5;border-radius:12px;padding:16px 18px;">
          <div style="font-size:10px;font-weight:800;color:#7B8EC0;text-transform:uppercase;letter-spacing:0.07em;margin-bottom:10px;padding-bottom:6px;border-bottom:2px solid #DDE5F5;">${label}</div>
          ${lines.map(l => `<div style="font-size:13px;color:#0D1535;font-weight:600;line-height:1.7;">${l}</div>`).join('')}
        </div>`;
    };

    const hasPickup   = booking.pickupAddress?.company;
    const hasDelivery = booking.deliveryAddress?.company;

    await send({
      to,
      subject: `Booking Received — ${booking.bookingRef}`,
      html: `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#EEF2FA;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;">
<div style="max-width:620px;margin:32px auto;padding:0 16px 40px;">

  <div style="background:linear-gradient(135deg,#0B1D5E 0%,#1A4FD8 70%,#00C2FF 100%);border-radius:16px 16px 0 0;padding:28px 32px;text-align:center;">
    <div style="font-size:22px;font-weight:900;color:#fff;letter-spacing:-0.3px;">NEXT GEN <span style="color:#00C2FF;">RATES</span></div>
    <div style="font-size:11px;color:rgba(255,255,255,0.55);margin-top:4px;">Instant Freight Rates Re-Imagined!</div>
  </div>

  <div style="background:#ffffff;padding:32px;border-left:1px solid #DDE5F5;border-right:1px solid #DDE5F5;">

    <div style="margin-bottom:6px;">
      <h2 style="margin:0 0 6px;font-size:20px;font-weight:900;color:#0B1D5E;">Booking Request Received</h2>
      <p style="margin:0 0 12px;font-size:13.5px;color:#5A6E9C;line-height:1.6;">Hi <strong style="color:#0B1D5E;">${name || 'Customer'}</strong>, your booking request has been received and is pending review.</p>
      <span style="display:inline-block;padding:5px 14px;border-radius:99px;font-size:11px;font-weight:800;background:#FFFBEB;color:#D97706;border:1px solid #FDE68A;">⏳ Pending Review</span>
    </div>

    <div style="background:linear-gradient(90deg,#EEF3FF,#F0F8FF);border:1.5px solid #BCC9E8;border-radius:12px;padding:16px 20px;margin:22px 0;text-align:center;">
      <div style="font-size:10px;font-weight:700;color:#7B8EC0;text-transform:uppercase;letter-spacing:0.07em;margin-bottom:6px;">Booking Reference</div>
      <div style="font-size:22px;font-weight:900;color:#1A4FD8;font-family:ui-monospace,monospace;letter-spacing:1px;">${booking.bookingRef}</div>
    </div>

    <div style="margin-bottom:22px;">
      <div style="font-size:10px;font-weight:800;color:#0B1D5E;text-transform:uppercase;letter-spacing:0.07em;margin-bottom:10px;padding-bottom:7px;border-bottom:2px solid #0B1D5E;">Booking Details</div>
      <table style="width:100%;border-collapse:collapse;background:#F7F9FF;border-radius:12px;overflow:hidden;border:1px solid #DDE5F5;">
        <tbody>
          <tr>
            <td style="padding:10px 14px;font-size:12px;font-weight:700;color:#7B8EC0;text-transform:uppercase;letter-spacing:0.05em;width:48%;vertical-align:top;border-bottom:1px solid #E8EEFF;">Booking Ref</td>
            <td style="padding:10px 14px;font-size:13px;font-weight:700;color:#1A4FD8;font-family:ui-monospace,monospace;vertical-align:top;border-bottom:1px solid #E8EEFF;">${booking.bookingRef}</td>
          </tr>
          ${row('Status', '<span style="padding:3px 10px;border-radius:99px;font-size:11px;font-weight:800;background:#FFFBEB;color:#D97706;border:1px solid #FDE68A;">Pending</span>')}
          ${row('Customer', name)}
          ${row('Company', booking.pickupAddress?.company || '—')}
          ${row('Mode', booking.mode)}
          ${row('Container', booking.containerType || '—')}
          ${row('Route', (booking.originPort || '') + ' → ' + (booking.destinationPort || ''), true)}
          ${row('Carrier', booking.carrier || booking.shippingLine || '—')}
          ${row('Sailing Date', fmtDate(booking.sailingDate))}
          ${row('Total Amount', fmtAmt(booking.totalAmount, booking.currency))}
          ${row('Cargo Type', booking.cargoType || '—')}
          ${row('Commodity', booking.commodity || '—')}
          ${row('HS Code', booking.hsCode || '—', true)}
          <tr>
            <td style="padding:10px 14px;font-size:12px;font-weight:700;color:#7B8EC0;text-transform:uppercase;letter-spacing:0.05em;width:48%;vertical-align:top;">Incoterms</td>
            <td style="padding:10px 14px;font-size:13px;font-weight:700;color:#0D1535;vertical-align:top;">${booking.incoterms || '—'}</td>
          </tr>
        </tbody>
      </table>
    </div>

    ${(hasPickup || hasDelivery) ? `
    <div style="margin-bottom:22px;">
      <div style="font-size:10px;font-weight:800;color:#0B1D5E;text-transform:uppercase;letter-spacing:0.07em;margin-bottom:10px;padding-bottom:7px;border-bottom:2px solid #0B1D5E;">Addresses</div>
      <table style="width:100%;border-collapse:collapse;"><tr>
        <td style="padding-right:6px;vertical-align:top;width:50%;">${addrBlock('Pickup / Origin Address', booking.pickupAddress)}</td>
        <td style="padding-left:6px;vertical-align:top;width:50%;">${addrBlock('Delivery / Destination Address', booking.deliveryAddress)}</td>
      </tr></table>
    </div>` : ''}

    ${booking.customerNotes ? `
    <div style="margin-bottom:22px;padding:14px 16px;background:#FFFBEB;border:1px solid #FDE68A;border-radius:12px;">
      <div style="font-size:10px;font-weight:800;color:#D97706;text-transform:uppercase;letter-spacing:0.07em;margin-bottom:6px;">Your Notes</div>
      <div style="font-size:13px;color:#78350F;line-height:1.7;">${booking.customerNotes}</div>
    </div>` : ''}

    <div style="margin-bottom:26px;padding:18px 20px;background:#EEF3FF;border:1px solid #BCC9E8;border-radius:12px;">
      <div style="font-size:11px;font-weight:800;color:#1A4FD8;text-transform:uppercase;letter-spacing:0.07em;margin-bottom:12px;">What Happens Next?</div>
      <table style="width:100%;border-collapse:collapse;">
        ${[['1','Our team reviews your booking request'],['2','We verify rate availability and carrier allocation'],['3','You receive a confirmation or update within 24–48 business hours'],['4','Final booking confirmation is sent with shipment details']].map(([n,t])=>`
        <tr><td style="width:32px;vertical-align:top;padding-bottom:8px;">
          <div style="width:22px;height:22px;border-radius:50%;background:#FEF08A;border:1px solid #FDE68A;font-size:11px;font-weight:800;color:#92400E;text-align:center;line-height:22px;">${n}</div>
        </td><td style="font-size:13px;color:#2D3F6B;line-height:1.6;padding-bottom:8px;">${t}</td></tr>`).join('')}
      </table>
    </div>

    <div style="text-align:center;margin-bottom:28px;">
      <a href="${process.env.CLIENT_URL || 'https://nextgenrates.com'}/bookings"
        style="display:inline-block;padding:13px 32px;background:linear-gradient(90deg,#1540C0,#1A6FE8 55%,#00C2FF);color:#fff;text-decoration:none;border-radius:10px;font-size:14px;font-weight:800;box-shadow:0 4px 16px rgba(0,194,255,0.28);">
        View My Bookings →
      </a>
    </div>

    <div style="background:#F7F9FF;border:1px solid #DDE5F5;border-radius:12px;padding:18px 20px;text-align:center;">
      <div style="font-size:11px;font-weight:800;color:#7B8EC0;text-transform:uppercase;letter-spacing:0.07em;margin-bottom:12px;">Need Help? Contact Our Team</div>
      <table style="width:100%;border-collapse:collapse;"><tr>
        <td style="text-align:center;padding:4px;">
          <a href="tel:+919884055097" style="text-decoration:none;color:#0B1D5E;font-size:14px;font-weight:800;">📞 +91 98840 55097</a>
        </td>
        <td style="text-align:center;padding:4px;">
          <a href="mailto:${process.env.ADMIN_EMAIL || 'support@nextgenrates.com'}" style="text-decoration:none;color:#0B1D5E;font-size:14px;font-weight:800;">✉️ ${process.env.ADMIN_EMAIL || 'support@nextgenrates.com'}</a>
        </td>
      </tr></table>
    </div>

  </div>

  <div style="background:#0B1D5E;border-radius:0 0 16px 16px;padding:18px 32px;text-align:center;">
    <div style="font-size:12px;color:rgba(255,255,255,0.5);line-height:1.7;">
      © ${new Date().getFullYear()} Next Gen Rates. All rights reserved.<br>
      This is an automated email — please do not reply directly to this message.
    </div>
  </div>

</div>
</body></html>`,
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

emailService.sendBookingStatusUpdate = async (to, name, booking) => {
  if (!to) return;

  const statusConfig = {
    approved:     { label: 'Approved ✅',     color: '#0A8A56', bg: '#EDFBF4', border: '#6EE7B7', msg: 'Your booking has been approved and is being processed.' },
    confirmed:    { label: 'Confirmed 🎉',    color: '#1A3CC8', bg: '#EEF3FF', border: '#93C5FD', msg: 'Your booking is confirmed. Our team will be in touch with shipment details shortly.' },
    rejected:     { label: 'Rejected ❌',     color: '#D91A1A', bg: '#FFF1F0', border: '#FFCCC7', msg: 'Unfortunately your booking could not be approved at this time.' },
    cancelled:    { label: 'Cancelled',       color: '#92400E', bg: '#FFF8E6', border: '#FDE68A', msg: 'Your booking has been cancelled.' },
    under_review: { label: 'Under Review 🔍', color: '#C47B00', bg: '#FFF8E6', border: '#FDE68A', msg: 'Your booking is currently under review. We will update you shortly.' },
  };

  const cfg = statusConfig[booking.status] || { label: booking.status, color: '#3A4A7A', bg: '#EEF3FF', border: '#D4DCFF', msg: 'Your booking status has been updated.' };

  await send({
    to,
    subject: `Booking ${cfg.label} — ${booking.bookingRef}`,
    html: base(`
      <h2 style="color:#0D1535;font-size:20px;font-weight:900;margin:0 0 12px">Booking Status Update</h2>
      <p style="color:#3A4A7A;line-height:1.7">Hi <strong>${name || 'Customer'}</strong>,</p>
      <div style="padding:14px 18px;background:${cfg.bg};border:1px solid ${cfg.border};border-radius:12px;margin:16px 0;text-align:center">
        <div style="font-size:11px;font-weight:700;color:${cfg.color};text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px">Status</div>
        <div style="font-size:22px;font-weight:900;color:${cfg.color}">${cfg.label}</div>
      </div>
      <p style="color:#3A4A7A;line-height:1.7">${cfg.msg}</p>
      <div style="background:#EEF3FF;border-radius:10px;padding:14px 18px;margin:16px 0">
        <div style="display:flex;padding:6px 0;border-bottom:1px solid #D4DCFF;font-size:13px"><span style="width:140px;color:#7B8EC0;font-weight:600;flex-shrink:0">Booking Ref</span><strong style="color:#1A3CC8;font-family:ui-monospace">${booking.bookingRef}</strong></div>
        <div style="display:flex;padding:6px 0;border-bottom:1px solid #D4DCFF;font-size:13px"><span style="width:140px;color:#7B8EC0;font-weight:600;flex-shrink:0">Route</span><strong style="color:#0D1535">${booking.originPort} → ${booking.destinationPort}</strong></div>
        <div style="display:flex;padding:6px 0;border-bottom:1px solid #D4DCFF;font-size:13px"><span style="width:140px;color:#7B8EC0;font-weight:600;flex-shrink:0">Mode</span><strong style="color:#0D1535">${booking.mode}</strong></div>
        <div style="display:flex;padding:6px 0;font-size:13px;border:none"><span style="width:140px;color:#7B8EC0;font-weight:600;flex-shrink:0">Carrier</span><strong style="color:#0D1535">${booking.carrier || '—'}</strong></div>
      </div>
      ${booking.adminNotes ? `
      <div style="padding:12px 16px;background:#FFFBEB;border:1px solid #FDE68A;border-radius:10px;margin:14px 0">
        <div style="font-size:11px;font-weight:700;color:#C47B00;margin-bottom:5px">NOTE FROM OUR TEAM</div>
        <div style="font-size:13px;color:#78350F;line-height:1.6">${booking.adminNotes}</div>
      </div>` : ''}
      <p style="color:#7B8EC0;font-size:13px;margin-top:20px">Questions? Reply to this email or contact <a href="mailto:${process.env.ADMIN_EMAIL || 'support@nextgenrates.com'}" style="color:#1A3CC8">${process.env.ADMIN_EMAIL || 'support@nextgenrates.com'}</a></p>
    `),
  });
};

// Admin-created account — sends temp credentials to user
emailService.sendAdminCreatedAccount = async (to, name, email, tempPassword, loginUrl) => {
  await send({
    to,
    subject: `Your Next Gen Rates Account Has Been Created`,
    html: base(`
      <h2 style="color:#0D1535;font-size:20px;font-weight:900;margin:0 0 12px">Account Created for You</h2>
      <p style="color:#3A4A7A;line-height:1.7">Hi <strong>${name}</strong>,<br><br>
      An account has been created for you on the Next Gen Rates platform. Please sign in with the credentials below and change your password immediately.</p>
      <div style="background:#EEF3FF;border-radius:12px;padding:18px 22px;margin:20px 0">
        <div style="display:flex;padding:7px 0;border-bottom:1px solid #D4DCFF;font-size:13px"><span style="width:120px;color:#7B8EC0;font-weight:600;flex-shrink:0">Email</span><strong style="color:#0D1535;font-family:ui-monospace">${email}</strong></div>
        <div style="display:flex;padding:7px 0;font-size:13px;border:none"><span style="width:120px;color:#7B8EC0;font-weight:600;flex-shrink:0">Password</span><strong style="color:#1A3CC8;font-family:ui-monospace;font-size:16px">${tempPassword}</strong></div>
      </div>
      <div style="padding:12px 16px;background:#FFF1F0;border:1px solid #FFCCC7;border-radius:10px;margin:14px 0;font-size:13px;color:#7F1D1D">
        ⚠️ Please change your password immediately after logging in.
      </div>
      <div style="text-align:center;margin:20px 0">
        <a href="${loginUrl}/login" style="display:inline-block;padding:13px 28px;background:linear-gradient(135deg,#1A3CC8,#1E50FF);color:#fff;text-decoration:none;border-radius:10px;font-size:14px;font-weight:800;box-shadow:0 4px 14px rgba(26,60,200,.35)">Sign In Now →</a>
      </div>
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


emailService.sendBookingAdminAlert = async (to, booking, user) => {
  if (!to) return;
  await send({
    to,
    subject: `📦 New Booking Request — ${booking.bookingRef}`,
    html: base(`
      <h2 style="color:#0D1535;font-size:18px;font-weight:900;margin:0 0 16px">New Booking Request</h2>
      <div style="background:#EEF3FF;border-radius:10px;padding:16px 18px;margin-bottom:18px">
        <div style="display:flex;padding:7px 0;border-bottom:1px solid #D4DCFF;font-size:13px">
          <span style="width:150px;color:#7B8EC0;font-weight:600;flex-shrink:0">Booking Ref</span>
          <strong style="color:#1A3CC8;font-family:ui-monospace">${booking.bookingRef}</strong>
        </div>
        <div style="display:flex;padding:7px 0;border-bottom:1px solid #D4DCFF;font-size:13px">
          <span style="width:150px;color:#7B8EC0;font-weight:600;flex-shrink:0">Customer</span>
          <strong style="color:#0D1535">${user?.name || '—'}</strong>
        </div>
        <div style="display:flex;padding:7px 0;border-bottom:1px solid #D4DCFF;font-size:13px">
          <span style="width:150px;color:#7B8EC0;font-weight:600;flex-shrink:0">Email</span>
          <strong style="color:#0D1535">${user?.officialEmail || user?.email || '—'}</strong>
        </div>
        <div style="display:flex;padding:7px 0;border-bottom:1px solid #D4DCFF;font-size:13px">
          <span style="width:150px;color:#7B8EC0;font-weight:600;flex-shrink:0">Company</span>
          <strong style="color:#0D1535">${user?.company?.name || '—'}</strong>
        </div>
        <div style="display:flex;padding:7px 0;border-bottom:1px solid #D4DCFF;font-size:13px">
          <span style="width:150px;color:#7B8EC0;font-weight:600;flex-shrink:0">Route</span>
          <strong style="color:#0D1535">${booking.originPort} → ${booking.destinationPort}</strong>
        </div>
        <div style="display:flex;padding:7px 0;border-bottom:1px solid #D4DCFF;font-size:13px">
          <span style="width:150px;color:#7B8EC0;font-weight:600;flex-shrink:0">Mode</span>
          <strong style="color:#0D1535">${booking.mode}</strong>
        </div>
        <div style="display:flex;padding:7px 0;border-bottom:1px solid #D4DCFF;font-size:13px">
          <span style="width:150px;color:#7B8EC0;font-weight:600;flex-shrink:0">Container</span>
          <strong style="color:#0D1535">${booking.containerType || '—'}</strong>
        </div>
        <div style="display:flex;padding:7px 0;border-bottom:1px solid #D4DCFF;font-size:13px">
          <span style="width:150px;color:#7B8EC0;font-weight:600;flex-shrink:0">Carrier</span>
          <strong style="color:#0D1535">${booking.carrier || '—'}</strong>
        </div>
        <div style="display:flex;padding:7px 0;font-size:13px;border:none">
          <span style="width:150px;color:#7B8EC0;font-weight:600;flex-shrink:0">Total Amount</span>
          <strong style="color:#0D1535">${booking.currency || 'USD'} ${booking.totalAmount?.toLocaleString() || '—'}</strong>
        </div>
      </div>
      <div style="text-align:center">
        <a href="${process.env.ADMIN_URL || 'http://localhost:3001'}/bookings"
          style="display:inline-block;padding:13px 28px;background:linear-gradient(135deg,#1A3CC8,#1E50FF);color:#fff;text-decoration:none;border-radius:10px;font-size:14px;font-weight:800;box-shadow:0 4px 14px rgba(26,60,200,.35)">
          Review Booking →
        </a>
      </div>
    `),
  });
};

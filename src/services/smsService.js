/**
 * SMS Service — Next Gen Rates
 * Replace the send() implementation with your SMS provider:
 *   - MSG91 (recommended for India, DLT-compliant)
 *   - Twilio
 *   - AWS SNS
 */

const axios = require('axios');

async function sendOtp(mobileWithCode, otp) {
  const provider = process.env.SMS_PROVIDER || 'console';

  if (provider === 'console') {
    // Development mode — just log to console
    console.log(`[SMS OTP] To: ${mobileWithCode}  OTP: ${otp}`);
    return { success: true };
  }

if (provider === 'msg91') {
  const response = await axios.post(
    'https://control.msg91.com/api/v5/otp',
    {
      template_id: process.env.MSG91_TEMPLATE_ID,
      mobile: mobileWithCode.replace(/\D/g, ''),
      otp: otp,
    },
    {
      headers: {
        authkey: process.env.MSG91_AUTH_KEY,
        'Content-Type': 'application/json',
      },
    }
  );

  console.log("MSG91 RESPONSE:", response.data);
  return response.data;
}

  if (provider === 'twilio') {
    const twilio = require('twilio')(process.env.TWILIO_SID, process.env.TWILIO_TOKEN);
    await twilio.messages.create({
      from: process.env.TWILIO_FROM,
      to:   mobileWithCode,
      body: `Your Next Gen Rates OTP is: ${otp}. Valid for 10 minutes. Do not share this with anyone.`,
    });
    return { success: true };
  }

  throw new Error(`Unknown SMS_PROVIDER: ${provider}`);
}

module.exports = { sendOtp };

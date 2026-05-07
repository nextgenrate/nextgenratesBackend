/**
 * One-time migration script — run with: node src/utils/fixKycStatus.js
 * 
 * Problem: When admin approved a registration, it incorrectly set kyc.status = 'approved'
 * even though the user hasn't uploaded any KYC identity documents yet.
 * 
 * Fix: Reset kyc.status to 'not_submitted' for users who have:
 *   - status: 'active' 
 *   - kyc.status: 'approved'
 *   - kyc.documents is empty (no actual KYC docs uploaded)
 * 
 * These users will be prompted to upload KYC after next login.
 */

require('dotenv').config();
const mongoose = require('mongoose');
const { User } = require('../models');

async function run() {
  await mongoose.connect(process.env.MONGO_URI);
  console.log('Connected to MongoDB');

  const affected = await User.find({
    status: 'active',
    'kyc.status': 'approved',
    $or: [
      { 'kyc.documents': { $size: 0 } },
      { 'kyc.documents': { $exists: false } },
    ],
  });

  console.log(`Found ${affected.length} user(s) with incorrectly approved KYC`);

  for (const user of affected) {
    console.log(`  Resetting: ${user.name} (${user.officialEmail})`);
    user.kyc.status = 'not_submitted';
    user.kyc.reviewedAt   = undefined;
    user.kyc.reviewedBy   = undefined;
    user.kyc.submittedAt  = undefined;
    await user.save();
  }

  console.log(`✅ Done — ${affected.length} user(s) reset to kyc.status=not_submitted`);
  console.log('These users will be prompted to upload KYC documents on next login.');
  process.exit(0);
}

run().catch(err => { console.error(err); process.exit(1); });

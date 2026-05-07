const cron = require('node-cron');
const { User } = require('../models');
const { deleteFromS3 } = require('../services/s3Service');
const logger = require('../utils/logger');

// ─── Delete expired KYC documents ─────────────────────────────
// Runs every day at 2:00 AM
const kycCleanupJob = cron.schedule('0 2 * * *', async () => {
  logger.info('Running KYC document cleanup job...');
  try {
    const now = new Date();

    // Find users with documents scheduled for deletion
    const users = await User.find({
      'kyc.documents': {
        $elemMatch: {
          scheduledDeleteAt: { $lte: now },
          deleted: false,
        },
      },
    });

    let deletedCount = 0;

    for (const user of users) {
      for (const doc of user.kyc.documents) {
        if (!doc.deleted && doc.scheduledDeleteAt && doc.scheduledDeleteAt <= now) {
          const deleted = await deleteFromS3(doc.s3Key);
          if (deleted) {
            doc.deleted = true;
            doc.s3Url = null;
            deletedCount++;
          }
        }
      }
      await user.save();
    }

    logger.info(`KYC cleanup: deleted ${deletedCount} documents from ${users.length} users`);
  } catch (err) {
    logger.error(`KYC cleanup job failed: ${err.message}`);
  }
}, { scheduled: false });

// ─── Send pending KYC reminder to admin ───────────────────────
// Runs every day at 9 AM
const kycReminderJob = cron.schedule('0 9 * * *', async () => {
  try {
    const twoDaysAgo = new Date(Date.now() - 2 * 86400 * 1000);
    const pendingUsers = await User.countDocuments({
      'kyc.status': 'pending',
      'kyc.submittedAt': { $lte: twoDaysAgo },
    });
    if (pendingUsers > 0) {
      logger.warn(`⚠ ${pendingUsers} KYC submissions pending for >48h — admin should review`);
      // Could send email to admin here
    }
  } catch (err) {
    logger.error(`KYC reminder job failed: ${err.message}`);
  }
}, { scheduled: false });

const startJobs = () => {
  kycCleanupJob.start();
  kycReminderJob.start();
  logger.info('Cron jobs started: KYC cleanup (2 AM daily), KYC reminder (9 AM daily)');
};

module.exports = { startJobs };

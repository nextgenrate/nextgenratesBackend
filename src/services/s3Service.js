const { S3Client, PutObjectCommand, DeleteObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const multer = require('multer');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const logger = require('../utils/logger');

const s3 = new S3Client({
  region: process.env.AWS_REGION,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
});

const BUCKET = process.env.AWS_S3_BUCKET;
const KYC_DELETE_DAYS = parseInt(process.env.KYC_DELETE_DAYS || '3');

// ─── Multer — memory storage (upload to S3 from buffer) ───────
const storage = multer.memoryStorage();

const fileFilter = (req, file, cb) => {
  const allowed = ['.pdf', '.jpg', '.jpeg', '.png'];
  const ext = path.extname(file.originalname).toLowerCase();
  if (allowed.includes(ext)) return cb(null, true);
  cb(new Error('Only PDF, JPG, and PNG files are allowed'));
};

const upload = multer({
  storage,
  fileFilter,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
});

// ─── Upload to S3 ─────────────────────────────────────────────
const uploadToS3 = async (file, folder = 'kyc') => {
  const ext = path.extname(file.originalname).toLowerCase();
  const key = `${folder}/${uuidv4()}${ext}`;

  await s3.send(new PutObjectCommand({
    Bucket: BUCKET,
    Key: key,
    Body: file.buffer,
    ContentType: file.mimetype,
    // S3 object expiry — auto-delete after KYC_DELETE_DAYS (requires lifecycle policy on bucket too)
    Metadata: {
      uploadedAt: new Date().toISOString(),
      scheduledDelete: new Date(Date.now() + KYC_DELETE_DAYS * 86400 * 1000).toISOString(),
    },
  }));

  const url = `https://${BUCKET}.s3.${process.env.AWS_REGION}.amazonaws.com/${key}`;
  const scheduledDeleteAt = new Date(Date.now() + KYC_DELETE_DAYS * 86400 * 1000);

  return { key, url, scheduledDeleteAt };
};

// ─── Get presigned URL for secure viewing ─────────────────────
const getPresignedUrl = async (key, expiresInSeconds = 3600) => {
  try {
    const command = new GetObjectCommand({ Bucket: BUCKET, Key: key });
    return await getSignedUrl(s3, command, { expiresIn: expiresInSeconds });
  } catch (err) {
    logger.error(`Presigned URL error for key ${key}: ${err.message}`);
    return null;
  }
};

// ─── Delete from S3 ───────────────────────────────────────────
const deleteFromS3 = async (key) => {
  try {
    await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key }));
    logger.info(`S3 deleted: ${key}`);
    return true;
  } catch (err) {
    logger.error(`S3 delete error for key ${key}: ${err.message}`);
    return false;
  }
};

module.exports = { upload, uploadToS3, deleteFromS3, getPresignedUrl, KYC_DELETE_DAYS };

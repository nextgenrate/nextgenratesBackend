require('dotenv').config();
const { connectDB } = require('../config/db');
const { User, Admin, Rate, Port } = require('../models');
const logger = require('./logger');

const SAMPLE_PORTS = [
  { code: 'INMAA', name: 'Chennai (ex Madras)', country: 'India', countryCode: 'IN', type: 'sea', region: 'Asia Pacific' },
  { code: 'INNSA', name: 'Nhava Sheva (JNPT)', country: 'India', countryCode: 'IN', type: 'sea', region: 'Asia Pacific' },
  { code: 'INMUN', name: 'Mumbai', country: 'India', countryCode: 'IN', type: 'sea', region: 'Asia Pacific' },
  { code: 'INENR', name: 'Ennore', country: 'India', countryCode: 'IN', type: 'sea', region: 'Asia Pacific' },
  { code: 'INCOK', name: 'Cochin', country: 'India', countryCode: 'IN', type: 'sea', region: 'Asia Pacific' },
  { code: 'SGSIN', name: 'Singapore', country: 'Singapore', countryCode: 'SG', type: 'sea', region: 'Asia Pacific' },
  { code: 'LKCMB', name: 'Colombo', country: 'Sri Lanka', countryCode: 'LK', type: 'sea', region: 'Asia Pacific' },
  { code: 'TZDAR', name: 'Dar es Salaam', country: 'Tanzania', countryCode: 'TZ', type: 'sea', region: 'Africa' },
  { code: 'AEDXB', name: 'Dubai (Jebel Ali)', country: 'UAE', countryCode: 'AE', type: 'sea', region: 'Middle East' },
  { code: 'GBFXT', name: 'Felixstowe', country: 'UK', countryCode: 'GB', type: 'sea', region: 'Europe' },
  { code: 'NLRTM', name: 'Rotterdam', country: 'Netherlands', countryCode: 'NL', type: 'sea', region: 'Europe' },
  { code: 'USNYC', name: 'New York', country: 'USA', countryCode: 'US', type: 'sea', region: 'North America' },
  { code: 'USLAX', name: 'Los Angeles', country: 'USA', countryCode: 'US', type: 'sea', region: 'North America' },
  // Air ports
  { code: 'MAA', name: 'Chennai International', country: 'India', countryCode: 'IN', type: 'air', region: 'Asia Pacific' },
  { code: 'BOM', name: 'Chhatrapati Shivaji Mumbai', country: 'India', countryCode: 'IN', type: 'air', region: 'Asia Pacific' },
  { code: 'DXB', name: 'Dubai International', country: 'UAE', countryCode: 'AE', type: 'air', region: 'Middle East' },
  { code: 'LHR', name: 'London Heathrow', country: 'UK', countryCode: 'GB', type: 'air', region: 'Europe' },
  { code: 'JFK', name: 'John F Kennedy International', country: 'USA', countryCode: 'US', type: 'air', region: 'North America' },
];

const seed = async () => {
  try {
    await connectDB();
    logger.info('Seeding database...');

    // Admin user
    const existingAdmin = await Admin.findOne({ email: process.env.ADMIN_EMAIL });
    if (!existingAdmin) {
      await Admin.create({
        name: process.env.ADMIN_NAME || 'System Admin',
        email: process.env.ADMIN_EMAIL,
        password: process.env.ADMIN_PASSWORD,
        role: 'super_admin',
      });
      logger.info(`✅ Admin created: ${process.env.ADMIN_EMAIL}`);
    } else {
      logger.info(`ℹ Admin already exists: ${process.env.ADMIN_EMAIL}`);
    }

    // Ports
    for (const port of SAMPLE_PORTS) {
      await Port.findOneAndUpdate({ code: port.code }, port, { upsert: true, new: true });
    }
    logger.info(`✅ ${SAMPLE_PORTS.length} ports seeded`);

    // Sample rates
    const sampleRates = [
      {
        mode: 'SEA-FCL', originPort: 'INENR', destinationPort: 'TZDAR',
        carrier: 'Hapag-Lloyd Quick Quotes', carrierCode: 'HLCU',
        containerType: '40GP', service: 'CY/CY',
        freightRate: { amount: 3170, currency: 'USD' },
        originCharges: [
          { name: 'Origin Terminal Handling Charge (OTHC)', basis: 'per equipment', currency: 'INR', amount: 10733, perEquipment: true },
          { name: 'Export Service Fee', basis: 'per equipment', currency: 'INR', amount: 920, perEquipment: true },
          { name: 'Document Charge', basis: 'per B/L', currency: 'INR', amount: 5300, perEquipment: false },
        ],
        transitTime: '53 Days',
        validFrom: new Date(),
        validTo: new Date(Date.now() + 60 * 86400000),
        inclusions: 'Vessel Risk Surcharge',
        remarks: 'ADFT 4 DAYS = 72.00 USD · CARGO SHIELD STANDARD = 28.00 USD',
      },
      {
        mode: 'SEA-FCL', originPort: 'INMAA', destinationPort: 'AEDXB',
        carrier: 'MSC', carrierCode: 'MSCU',
        containerType: '40GP', service: 'CY/CY',
        freightRate: { amount: 1200, currency: 'USD' },
        originCharges: [
          { name: 'Origin Terminal Handling Charge', basis: 'per equipment', currency: 'INR', amount: 9800, perEquipment: true },
          { name: 'Document Charge', basis: 'per B/L', currency: 'INR', amount: 3520, perEquipment: false },
        ],
        transitTime: '14 Days',
        validFrom: new Date(),
        validTo: new Date(Date.now() + 30 * 86400000),
        inclusions: '',
        remarks: '',
      },
    ];

    for (const rate of sampleRates) {
      const exists = await Rate.findOne({ originPort: rate.originPort, destinationPort: rate.destinationPort, carrier: rate.carrier, containerType: rate.containerType });
      if (!exists) {
        await Rate.create(rate);
        logger.info(`✅ Rate seeded: ${rate.originPort} → ${rate.destinationPort} (${rate.carrier})`);
      }
    }

    logger.info('✅ Database seeded successfully');
    process.exit(0);
  } catch (err) {
    logger.error(`Seed failed: ${err.message}`);
    process.exit(1);
  }
};

seed();

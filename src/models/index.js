const mongoose = require('mongoose');
const bcrypt   = require('bcryptjs');

/* ── Charge schema (for Rate model) ─────────────────────────── */
const chargeSchema = new mongoose.Schema({
  code:       String,
  name:       { type:String, required:true },
  basis:      { type:String, default:'per equipment' },
  currency:   { type:String, default:'USD' },
  amount:     { type:Number, required:true },
  perEquipment:{ type:Boolean, default:true },
  qty:        { type:Number, default:1 },
}, { _id:false });

/* ══════════════════════════════════════════════════════════════
   USER  (updated for company registration flow)
══════════════════════════════════════════════════════════════ */
const userSchema = new mongoose.Schema({
  /* ── Login credentials ── */
  name:               { type:String, required:true, trim:true },
  email:              { type:String, unique:true, sparse:true, lowercase:true, trim:true },
  officialEmail:      { type:String, unique:true, sparse:true, lowercase:true, trim:true },
  password:           { type:String, required:true, select:false },
  mustChangePassword: { type:Boolean, default:false },
  isEmailVerified:    { type:Boolean, default:false },
  otp:                { code:String, expires:Date, attempts:{ type:Number, default:0 } },

  /* ── Account status ── */
  status: {
    type: String,
    enum: ['active','suspended','pending_approval','pending_kyc'],
    default: 'pending_approval',
  },

  /* ── Contact ── */
  phone:              String,
  phoneCountryCode:   { type:String, default:'+91' },
  mobile:             String,
  landline:           String,
  landlineCountryCode:String,

  /* ── Company (from registration form) ── */
  company: {
    name:    String,
    type: {
      type: String,
      enum: [
        'Freight Forwarder',
        'CHA',
        'Shipper / Exporter / Importer',
        'Trader',
        'Manufacturer',
        'Courier Company',
        'Airlines',
        'Shipping Line',
        'Road Transport Company',
        'NVOCC',
        'Rail Transport Company',
        '',                              // allow empty (optional field during draft)
      ],
    },
    address:           String,
    zipCode:           String,
    country:           String,
    website:           String,
    incorporationDate: Date,
    vatGstTaxNo:       String,
    billingAddress:    String,
    billingAddressSame:{ type:Boolean, default:true },
    city:              String,
    pincode:           String,
  },

  /* ── Management / Director ── */
  director: {
    name:   String,
    email:  String,
    mobile: String,
  },

  /* ── Company registration documents (up to 5) ── */
  registrationDocuments: [
    {
      type:             { type:String, required:true },
      fieldKey:         String,
      originalName:     String,
      mimeType:         String,
      s3Key:            String,
      s3Url:            String,
      uploadedAt:       Date,
      scheduledDeleteAt:Date,
    },
  ],
  registrationDate: Date,

  /* ── KYC ── */
  kyc: {
    status: {
      type: String,
      enum: ['not_submitted','pending','approved','rejected','resubmit_required'],
      default: 'pending',
    },
    submittedAt:     Date,
    reviewedAt:      Date,
    reviewedBy:      { type:mongoose.Schema.Types.ObjectId, ref:'Admin' },
    rejectionReason: String,
    /* GST fields kept for legacy/admin use; gstNumber populated from vatGstTaxNo at submit */
    gstNumber:       String,
    gstVerified:     { type:Boolean, default:false },
    gstVerifiedAt:   Date,
    country:         String,
    aadhaarNumber:   String,
    panNumber:       String,
    nationalId:      String,
    taxId:           String,
    documents: [
      {
        type:             { type:String },
        fieldKey:         String,
        originalName:     String,
        mimeType:         String,
        s3Key:            String,
        s3Url:            String,
        uploadedAt:       { type:Date, default:Date.now },
        scheduledDeleteAt:Date,
        deleted:          { type:Boolean, default:false },
      },
    ],
  },

  /* ── Misc ── */
  createdByAdmin: { type:Boolean, default:false },
  lastLoginAt:    Date,
  loginAttempts:  { type:Number, default:0 },
  lockUntil:      Date,
  preferences: {
    currency:  { type:String, default:'USD' },
    incoterms: { type:String, default:'FOB' },
  },
}, { timestamps:true });

/* Indexes */
userSchema.index({ officialEmail:1 });
userSchema.index({ 'company.name':1 });
userSchema.index({ status:1 });
userSchema.index({ createdAt:-1 });

/* Password hashing */
userSchema.pre('save', async function(next) {
  if (!this.isModified('password')) return next();
  this.password = await bcrypt.hash(this.password, 12);
  next();
});
userSchema.methods.comparePassword = async function(pw) {
  return bcrypt.compare(pw, this.password);
};
userSchema.methods.isLocked = function() {
  return this.lockUntil && this.lockUntil > Date.now();
};

const User = mongoose.model('User', userSchema);

/* ══════════════════════════════════════════════════════════════
   AIR RATE  (slab-based pricing)
══════════════════════════════════════════════════════════════ */
const airRateSchema = new mongoose.Schema({
  originPort:        { type:String, required:true, uppercase:true },  // IATA airport code
  destinationPort:   { type:String, required:true, uppercase:true },
  carrier:           { type:String, default:'All Airlines' },
  cargoType:         { type:String, default:'FAK' },    // FAK / HAZ / PHAR / COOL
  vwDivisor:         { type:Number, default:6000 },     // IATA=6000, some use 5000
  transitTime:       String,
  validFrom:         { type:Date, required:true },
  validTo:           Date,
  isActive:          { type:Boolean, default:true },
  createdBy:         { type:mongoose.Schema.Types.ObjectId, ref:'Admin' },
  // Rate slabs — one doc can have multiple slabs for same route
  slabs: [{
    minCW:      { type:Number, required:true },   // exclusive (>)
    maxCW:      { type:Number, required:true },   // inclusive (≤)
    slabName:   String,
    ratePerKg:  { type:Number, required:true },   // USD/KG
    currency:   { type:String, default:'USD' },
    minCharge:  { type:Number, default:0 },       // USD minimum
    remarks:    String,
  }],
  // Origin charges (FSC, SSC, AWB etc.)
  originCharges: [{
    name:     String,
    code:     String,
    basis:    { type:String, default:'per shipment' },
    currency: { type:String, default:'USD' },
    amount:   Number,
  }],
  // Destination charges
  destinationCharges: [{
    name:     String,
    code:     String,
    basis:    { type:String, default:'per shipment' },
    currency: { type:String, default:'USD' },
    amount:   Number,
  }],
  inclusions: String,
  remarks:    String,
}, { timestamps:true });

airRateSchema.index({ originPort:1, destinationPort:1 });
airRateSchema.index({ isActive:1 });
airRateSchema.index({ validFrom:1, validTo:1 });

const AirRate = mongoose.model('AirRate', airRateSchema);

/* ══════════════════════════════════════════════════════════════
   ADMIN
══════════════════════════════════════════════════════════════ */
const adminSchema = new mongoose.Schema({
  name:        { type:String, required:true, trim:true },
  email:       { type:String, required:true, unique:true, lowercase:true },
  password:    { type:String, required:true, select:false },
  role:        { type:String, enum:['super_admin','admin','viewer'], default:'admin' },
  lastLoginAt: Date,
  isActive:    { type:Boolean, default:true },
}, { timestamps:true });

adminSchema.index({ email:1 });
adminSchema.pre('save', async function(next) {
  if (!this.isModified('password')) return next();
  this.password = await bcrypt.hash(this.password, 12);
  next();
});
adminSchema.methods.comparePassword = async function(pw) {
  return bcrypt.compare(pw, this.password);
};

const Admin = mongoose.model('Admin', adminSchema);

/* ══════════════════════════════════════════════════════════════
   RATE
══════════════════════════════════════════════════════════════ */
const rateSchema = new mongoose.Schema({
  rateCode:           String,
  mode:               { type:String, enum:['SEA-FCL','SEA-LCL','AIR'], required:true, default:'SEA-FCL' },
  shippingLine:       { type:String, required:true },
  shippingLineCode:   String,
  shippingLineLogo:   String,
  originPort:         { type:String, required:true, uppercase:true },
  originPortName:     String,
  originTerminal:     String,
  destinationPort:    { type:String, required:true, uppercase:true },
  destinationPortName:String,
  destinationTerminal:String,
  viaPort:            [String],
  viaPortNames:       [String],
  viaTerminals:       [String],
  serviceMode:        { type:String, default:'CY/CY' },
  serviceName:        String,
  rateType:           { type:String, enum:['SPOT RATE','CONTRACT','LIVE RATE'], default:'SPOT RATE' },
  containerType:      String,
  sailingDate:        Date,
  transitTimeDays:    Number,
  freeDays:           { type:Number, default:4 },
  cargoType:          { type:String, default:'FAK' },
  cargoDescription:   String,
  commodity:          String,
  validFrom:          { type:Date, required:true },
  validTo:            Date,
  freightCharges:     [chargeSchema],
  originCharges:      [chargeSchema],
  destinationCharges: [chargeSchema],
  totalUsd:           Number,
  freightRateUsd:     Number,
  inclusions:         String,
  remarks:            String,
  termsAndConditions: String,
  isActive:           { type:Boolean, default:true },
  createdBy:          { type:mongoose.Schema.Types.ObjectId, ref:'Admin' },
}, { timestamps:true });

rateSchema.index({ originPort:1, destinationPort:1, mode:1 });
rateSchema.index({ sailingDate:1 });
rateSchema.index({ validFrom:1, validTo:1 });
rateSchema.index({ isActive:1 });
rateSchema.index({ shippingLine:1 });
rateSchema.index({ freightRateUsd:1 });
rateSchema.index({ totalUsd:1 });

const Rate = mongoose.model('Rate', rateSchema);

/* ══════════════════════════════════════════════════════════════
   PORT
══════════════════════════════════════════════════════════════ */
const portSchema = new mongoose.Schema({
  code:        { type:String, required:true, unique:true, uppercase:true },
  name:        { type:String, required:true },
  country:     String,
  countryCode: String,
  type:        { type:String, enum:['sea','air','icd'], default:'sea' },
  region:      String,
  lat:         Number,
  lng:         Number,
  isActive:    { type:Boolean, default:true },
}, { timestamps:true });

portSchema.index({ code:1 });
portSchema.index({ name:'text', country:'text' });

const Port = mongoose.model('Port', portSchema);

/* ══════════════════════════════════════════════════════════════
   BOOKING
══════════════════════════════════════════════════════════════ */
const bookingSchema = new mongoose.Schema({
  bookingRef:      { type:String, unique:true },
  user:            { type:mongoose.Schema.Types.ObjectId, ref:'User', required:true },
  rate:            { type:mongoose.Schema.Types.ObjectId, ref:'Rate' },
  rateSnapshot:    mongoose.Schema.Types.Mixed,
  mode:            String,
  originPort:      String,
  destinationPort: String,
  shippingLine:    String,
  carrier:         String,
  containerType:   String,
  containers:      [{ type:String, qty:Number }],
  cargoType:       String,
  commodity:       String,
  hsCode:          String,
  incoterms:       String,
  sailingDate:     Date,
  totalAmount:     Number,
  currency:        { type:String, default:'USD' },
  pickupAddress:   { company:String, contact:String, email:String, phone:String, street:String, city:String, country:String, postalCode:String },
  deliveryAddress: { company:String, contact:String, email:String, phone:String, street:String, city:String, country:String, postalCode:String },
  customerNotes:   String,
  actualKg:     Number,
lengthCm:     Number,
widthCm:      Number,
heightCm:     Number,
pieces:       Number,
chargeableKg: Number,
  adminNotes:      String,
  status:          { type:String, enum:['pending','under_review','approved','rejected','confirmed','cancelled'], default:'pending' },
  reviewedBy:      { type:mongoose.Schema.Types.ObjectId, ref:'Admin' },
  reviewedAt:      Date,
  confirmedAt:     Date,
}, { timestamps:true });

bookingSchema.index({ user:1 });
bookingSchema.index({ status:1 });
bookingSchema.index({ createdAt:-1 });
bookingSchema.pre('save', function(next) {
  if (!this.bookingRef) this.bookingRef = `NGR-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2,6).toUpperCase()}`;
  next();
});

const Booking = mongoose.model('Booking', bookingSchema);

/* ══════════════════════════════════════════════════════════════
   ENQUIRY
══════════════════════════════════════════════════════════════ */
const enquirySchema = new mongoose.Schema({
  enquiryRef:          { type:String, unique:true },
  user:                { type:mongoose.Schema.Types.ObjectId, ref:'User', required:true },
  mode:                String,
  originPort:          String,
  destinationPort:     String,
  containerType:       String,
  targetRate:          Number,
  currency:            { type:String, default:'USD' },
  cargoWeight:         Number,
  weightUnit:          { type:String, default:'KG' },
  preferredLiner:      String,
  preferredSailingDate:Date,
  freeDays:            Number,
  charges:             [String],
  notes:               String,
  status:              { type:String, enum:['pending','under_review','responded','closed'], default:'pending' },
  adminResponse:       String,
  respondedBy:         { type:mongoose.Schema.Types.ObjectId, ref:'Admin' },
  respondedAt:         Date,
}, { timestamps:true });

enquirySchema.index({ user:1 });
enquirySchema.index({ status:1 });
enquirySchema.pre('save', function(next) {
  if (!this.enquiryRef) this.enquiryRef = `ENQ-${Date.now().toString(36).toUpperCase()}`;
  next();
});

const Enquiry = mongoose.model('Enquiry', enquirySchema);

/* ══════════════════════════════════════════════════════════════
   SEARCH LOG  /  ACTIVITY LOG
══════════════════════════════════════════════════════════════ */
const searchLogSchema = new mongoose.Schema({
  user:            { type:mongoose.Schema.Types.ObjectId, ref:'User' },
  sessionId:       String,
  mode:            String,
  originPort:      String,
  destinationPort: String,
  containerType:   String,
  sailingDate:     Date,
  resultsCount:    Number,
  ip:              String,
  userAgent:       String,
}, { timestamps:true });

searchLogSchema.index({ user:1 });
searchLogSchema.index({ createdAt:-1 });
searchLogSchema.index({ originPort:1, destinationPort:1 });
const SearchLog = mongoose.model('SearchLog', searchLogSchema);

const activityLogSchema = new mongoose.Schema({
  actor:      { type:mongoose.Schema.Types.ObjectId, refPath:'actorModel' },
  actorModel: { type:String, enum:['User','Admin'] },
  action:     String,
  resource:   String,
  resourceId: mongoose.Schema.Types.ObjectId,
  meta:       mongoose.Schema.Types.Mixed,
  ip:         String,
}, { timestamps:true });

activityLogSchema.index({ actor:1 });
activityLogSchema.index({ createdAt:-1 });
const ActivityLog = mongoose.model('ActivityLog', activityLogSchema);

module.exports = { User, Admin, Rate, AirRate, Port, Booking, Enquiry, SearchLog, ActivityLog };

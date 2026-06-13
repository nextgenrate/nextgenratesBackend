/**
 * Air freight calculation utilities
 * VW = L × W × H (cm) ÷ divisor   [IATA standard divisor = 6000]
 * CW = MAX(actual weight, volume weight)
 * Cost = MAX(CW × rate/kg, min charge)
 */

const calcVolumeWeight = (lengthCm, widthCm, heightCm, divisor = 6000) =>
  Math.round((lengthCm * widthCm * heightCm) / divisor * 100) / 100;

const calcChargeableWeight = (actualKg, volumeWeightKg) =>
  Math.max(actualKg, volumeWeightKg);

const calcFreightCost = (chargeableWeight, ratePerKg, minCharge = 0) =>
  Math.max(chargeableWeight * ratePerKg, minCharge);

/**
 * Given a chargeable weight, find the matching slab from an AirRate doc
 */
const findSlab = (slabs = [], chargeableWeight) =>
  slabs.find(s => chargeableWeight > s.minCW && chargeableWeight <= s.maxCW) || null;

/**
 * Full quote calculation for an AirRate
 * @param {Object} airRate  - AirRate document
 * @param {Object} cargo    - { actualKg, lengthCm, widthCm, heightCm, pieces }
 */
// utils/airFreight.js — calculateAirQuote should return:
function calculateAirQuote(airRate, cargo) {
  const { actualKg, lengthCm, widthCm, heightCm, pieces = 1 } = cargo;
  const divisor = airRate.vwDivisor || 6000;

  const vwPerPiece = (parseFloat(lengthCm||0) * parseFloat(widthCm||0) * parseFloat(heightCm||0)) / divisor;
  const totalVW    = Math.round(vwPerPiece * parseInt(pieces) * 100) / 100;
  const totalAW    = Math.round(parseFloat(actualKg||0) * parseInt(pieces) * 100) / 100;
  const cw         = Math.max(totalVW, totalAW);

  // Find matching slab
  const slab = (airRate.slabs || []).find(s => cw > s.minCW && cw <= s.maxCW);
  if (!slab) return { cw, totalVW, totalAW, divisor, slab: null, freightCost: 0 };

  const freightCost = Math.round(Math.max(cw * slab.ratePerKg, slab.minCharge) * 100) / 100;

  return {
    cw,
    totalVW,
    totalAW,
    divisor,
    slab,
    freightCost,
  };
}

module.exports = { calcVolumeWeight, calcChargeableWeight, calcFreightCost, findSlab, calculateAirQuote };
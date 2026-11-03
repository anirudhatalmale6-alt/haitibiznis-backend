/* 3 Nov 2026 (Jeffery): "Add a CSV export of filtered drivers ... Restrict exports to authorized
   administrators and log them." One row per export: who (the name typed at the console), when, from
   where, which filter, how many drivers and which ones. The CSV itself is never stored. */
const mongoose = require('mongoose');

const driverExportLogSchema = new mongoose.Schema({
  by: { type: String, default: '' },
  filter: { type: String, default: '' },
  count: { type: Number, default: 0 },
  driverIds: [{ type: String }],
  ip: { type: String, default: '' },
  at: { type: Date, default: Date.now }
});

module.exports = mongoose.model('DriverExportLog', driverExportLogSchema);

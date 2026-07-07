'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// PIR module type registry — V2 (-20) series
// Covered by velbus-pir-20 node.
//
// hasTempSensor:  module has temperature sensor — 0xE6 emitted, 0xE8 part1
//                 is full glass-panel-style multi-part format (only calibration
//                 and alarm fields meaningful — no thermostat presets).
//                 Temp alarm bits replace absence in 0x00 bitmask.
// lockStyle:      'number' — DB2 of lock/unlock is channel number 1-N
// channels:       named channel numbers (1-indexed), keyed by channel number
// minMapVer:      minimum memory map version (null = unverified)
// series:         'v2'
// ─────────────────────────────────────────────────────────────────────────────

const PIR_TYPES_20 = {
  0x4D: {
    name: 'VMBPIR-20',
    hasTempSensor: false,
    lockStyle: 'number',
    // Channels 1-7 by number; bitmask uses bit0=dark...bit6=absence
    channels: {
      1: 'dark', 2: 'light', 3: 'motion1', 4: 'ldMotion1',
      5: 'motion2', 6: 'ldMotion2', 7: 'absence',
    },
    // 0x00 bitmask: bit0-bit6 as above, bit7 unused
    bitmask: ['dark', 'light', 'motion1', 'ldMotion1', 'motion2', 'ldMotion2', 'absence'],
    minMapVer: 1,
    series: 'v2',
  },
  0x59: {
    name: 'VMBPIRO-20',
    hasTempSensor: true,
    lockStyle: 'number',
    // Channels 1-6 lockable; bits 6-7 are temp alarms (read-only, not lockable)
    channels: {
      1: 'dark', 2: 'light', 3: 'motion1', 4: 'ldMotion1',
      5: 'motion2', 6: 'ldMotion2',
    },
    // 0x00 bitmask: bits 0-5 motion channels, bit6=lowTempAlarm, bit7=highTempAlarm
    bitmask: ['dark', 'light', 'motion1', 'ldMotion1', 'motion2', 'ldMotion2',
              'lowTempAlarm', 'highTempAlarm'],
    minMapVer: null,
    series: 'v2',
  },
};

const PIR_TYPE_IDS_20 = new Set(Object.keys(PIR_TYPES_20).map(k => parseInt(k)));

module.exports = { PIR_TYPES_20, PIR_TYPE_IDS_20 };

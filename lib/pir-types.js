'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// PIR module type registry — original and -10 series
// Covered by velbus-pir node.
//
// hasTempSensor:  module has temperature sensor — 0xE6 emitted, 0xE8 settings
//                 compact format (7 bytes). Alarms replace absence in bitmask.
// lockStyle:      'bitmask' — DB2 of lock/unlock/enable/disable is channel bitmask
// channels:       named channel bits in bitmask order (bit0=index0)
// minMapVer:      minimum memory map version (null = unverified)
// series:         'original' | '-10'
// ─────────────────────────────────────────────────────────────────────────────

const CHANNEL_BITS_WITH_ABSENCE = [
  'dark', 'light', 'motion1', 'ldMotion1', 'motion2', 'ldMotion2', 'absence',
];

const CHANNEL_BITS_WITH_TEMP = [
  'dark', 'light', 'motion1', 'ldMotion1', 'motion2', 'ldMotion2',
  'lowTempAlarm', 'highTempAlarm',
];

const PIR_TYPES = {
  0x2A: {
    name: 'VMBPIRM',
    hasTempSensor: false,
    lockStyle: 'bitmask',
    channels: CHANNEL_BITS_WITH_ABSENCE,
    minMapVer: null,
    series: 'original',
  },
  0x2B: {
    name: 'VMBPIRC',
    hasTempSensor: false,
    lockStyle: 'bitmask',
    channels: CHANNEL_BITS_WITH_ABSENCE,
    minMapVer: null,
    series: 'original',
  },
  0x2C: {
    name: 'VMBPIRO',
    hasTempSensor: true,
    lockStyle: 'bitmask',
    channels: CHANNEL_BITS_WITH_TEMP,
    minMapVer: null,
    series: 'original',
  },
  0x23: {
    name: 'VMBPIRO-10',
    hasTempSensor: true,
    lockStyle: 'bitmask',
    channels: CHANNEL_BITS_WITH_TEMP,
    minMapVer: null,
    series: '-10',
  },
};

const PIR_TYPE_IDS = new Set(Object.keys(PIR_TYPES).map(k => parseInt(k)));

module.exports = { PIR_TYPES, PIR_TYPE_IDS };

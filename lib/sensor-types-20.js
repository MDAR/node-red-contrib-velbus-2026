'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// Sensor/input module type registry — V2 series
// Covered by velbus-sensor-20 node.
//
// VMB8IN-20 (0x4E): 8 digital inputs + 8 energy counters + up to 24 alarm
//   channels via 3 subaddresses (channels 9-16, 17-24, 25-32)
//   lockStyle: 'number' — DB2 of lock/unlock is channel number 1-32
//   nameStyle: 'number' — DB2 of 0xF0/F1/F2 is channel number 1-32
//   hasCounter: true — 0xA4 energy counter on all 8 channels (Wh / litres / ml)
// ─────────────────────────────────────────────────────────────────────────────

const SENSOR_TYPES_20 = {
  0x4E: {
    name:        'VMB8IN-20',
    channels:    8,        // primary digital input channels
    alarmCh:     24,       // additional alarm channels via subaddresses (9-32)
    hasCounter:  true,
    lockStyle:   'number',
    nameStyle:   'number',
    minMapVer:   null,
    series:      'v2',
  },
};

const SENSOR_TYPE_IDS_20 = new Set(Object.keys(SENSOR_TYPES_20).map(k => parseInt(k)));

module.exports = { SENSOR_TYPES_20, SENSOR_TYPE_IDS_20 };

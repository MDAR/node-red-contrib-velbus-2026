'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// Sensor/input module type registry — original series
// Covered by velbus-sensor node.
//
// VMB7IN (0x22): 8 digital inputs + 4 pulse counters (channels 1-4)
//   lockStyle: 'bitmask' — DB2 of lock/unlock/enable/disable is channel bitmask
//   nameStyle: 'bitmask' — DB2 of 0xF0/F1/F2 is channel bitmask
//   hasCounter: true — 0xBE pulse counter on channels 1-4
//
// VMB4AN (0x32): 16 logical channels across 3 functional groups
//   GROUP 1: alarm outputs (channels 1-8)  — 0x00 press/release
//   GROUP 2: sensor inputs (channels 9-12) — analogue, 4 presets
//   GROUP 3: analogue outputs (ch 13-16)   — 0-10V, original dimmer protocol
//   lockStyle: 'bitmask'
//   nameStyle: 'bitmask'
//   hasCounter: false
//   hasAnalogue: true
// ─────────────────────────────────────────────────────────────────────────────

const SENSOR_TYPES = {
  0x22: {
    name:         'VMB7IN',
    channels:     8,
    counterCh:    [1, 2, 3, 4],  // channels with pulse counter capability
    hasCounter:   true,
    hasAnalogue:  false,
    lockStyle:    'bitmask',
    nameStyle:    'bitmask',
    minMapVer:    null,
    series:       'original',
  },
  0x32: {
    name:         'VMB4AN',
    channels:     8,    // alarm output channels (group 1, produce 0x00 events)
    counterCh:    [],
    hasCounter:   false,
    hasAnalogue:  true, // groups 2 and 3 — handled separately
    lockStyle:    'bitmask',
    nameStyle:    'bitmask',
    minMapVer:    null,
    series:       'original',
  },
};

const SENSOR_TYPE_IDS = new Set(Object.keys(SENSOR_TYPES).map(k => parseInt(k)));

module.exports = { SENSOR_TYPES, SENSOR_TYPE_IDS };

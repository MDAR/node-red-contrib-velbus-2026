'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// Blind/shutter module type registry — V2 (-20) series
// Covered by velbus-blind-20 node.
//
// VMB2BLE-20 (0x61): Full V2 redesign. 8-byte 0xFF with CAN FD properties.
//   0xEC status packet covers BOTH channels in one packet using nibble encoding.
//   Channel identifier in commands: plain integer 1, 2, or 0xFF (all).
//   Name request 0xEF: DB2 = channel number or 0xFF for all.
//   No 0x00 relay event transmit — status comes via 0xEC only.
//   0xFFFFFF NOT allowed for up/down timeout (allowed for lock/force/inhibit).
// ─────────────────────────────────────────────────────────────────────────────

const BLIND_TYPES_20 = {
  0x61: {
    name:        'VMB2BLE-20',
    channels:    2,
    minMapVer:   null,
    series:      'v2',
  },
};

const BLIND_TYPE_IDS_20 = new Set(Object.keys(BLIND_TYPES_20).map(k => parseInt(k)));

module.exports = { BLIND_TYPES_20, BLIND_TYPE_IDS_20 };

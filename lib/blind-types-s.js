'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// Blind/shutter module type registry — BLS/BLE series (VMB1BLS, VMB2BLE)
// Covered by velbus-blind-s node.
//
// Full-featured blind controllers with position feedback (0-100%),
// lock/unlock (0x1A/0x1B), forced up/down, inhibit variants, auto modes,
// sunrise/sunset, and real-time clock. 0xFF response is 7 bytes with serial.
//
// channels:       number of blind channels
// channelBits:    map of channel number to bit value used in commands
//                 Both modules use clean bit encoding: ch1=0x01, ch2=0x02
// hasLocalButtons: false — local button events NOT reported in 0x00
// ─────────────────────────────────────────────────────────────────────────────

const BLIND_TYPES_S = {
  0x2E: {
    name:            'VMB1BLS',
    channels:        1,
    channelBits:     { 1: 0x01 },
    hasLocalButtons: false,
    minMapVer:       null,
    series:          'bls',
  },
  0x1D: {
    name:            'VMB2BLE',
    channels:        2,
    channelBits:     { 1: 0x01, 2: 0x02 },
    hasLocalButtons: false,
    minMapVer:       null,
    series:          'ble',
  },
  0x4A: {
    name:            'VMB2BLE-10',
    channels:        2,
    channelBits:     { 1: 0x01, 2: 0x02 },
    hasLocalButtons: false,
    minMapVer:       null,
    series:          'ble-10',
  },
};

const BLIND_TYPE_IDS_S = new Set(Object.keys(BLIND_TYPES_S).map(k => parseInt(k)));

module.exports = { BLIND_TYPES_S, BLIND_TYPE_IDS_S };

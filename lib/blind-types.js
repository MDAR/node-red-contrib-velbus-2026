'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// Blind/shutter module type registry — original series (VMB1BL, VMB2BL)
// Covered by velbus-blind node.
//
// These are early modules with no position feedback, no lock/force/inhibit,
// and dip-switch-based timeout. 0xFF response is 5 bytes (no serial number).
//
// channels:       number of blind channels
// channelMasks:   map of channel number to bitmask used in 0xEC and commands
//                 VMB1BL uses 0x03 for its single channel (historical oddity)
//                 VMB2BL uses packed 2-bit pairs: ch1=0x03, ch2=0x0C
// hasLocalButtons: module reports local push button events mixed into 0x00
// ─────────────────────────────────────────────────────────────────────────────

const BLIND_TYPES = {
  0x03: {
    name:            'VMB1BL',
    channels:        1,
    channelMasks:    { 1: 0x03 },
    hasLocalButtons: true,
    minMapVer:       null,
    series:          'original',
  },
  0x09: {
    name:            'VMB2BL',
    channels:        2,
    channelMasks:    { 1: 0x03, 2: 0x0C },
    hasLocalButtons: true,
    minMapVer:       null,
    series:          'original',
  },
};

const BLIND_TYPE_IDS = new Set(Object.keys(BLIND_TYPES).map(k => parseInt(k)));

module.exports = { BLIND_TYPES, BLIND_TYPE_IDS };

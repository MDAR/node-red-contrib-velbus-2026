'use strict';

/**
 * relay-types-20.js
 * Registry of V2 (-20 series) Velbus relay module types.
 * Original series modules are in relay-types.js.
 *
 * KEY PROTOCOL DIFFERENCES FROM ORIGINAL SERIES:
 *   0xFF response: 8 bytes (byte 8 = properties: CAN FD, terminator, HW ver)
 *   0xFB status:   One packet = full module state (bitmask per byte, not per-channel)
 *     byte 2: channel 1-8 on/off status bitmask
 *     byte 3: channel 1-8 inhibited bitmask
 *     byte 4: channel 1-8 forced_on bitmask
 *     byte 5: channel 1-8 forced_off (locked) bitmask
 *     byte 6: channel 1-8 program disabled bitmask
 *     byte 7: channel 1-8 interval timer running bitmask
 *     byte 8: alarm & program selection
 *   Commands use channel NUMBER (1-8) or 0xFF for all — NOT bitmask
 *   Full scheduling engine: programs, alarms, sunrise/sunset
 *   CAN FD support (flag in 0xFF properties byte)
 *   Program steps: 122 (original series: 72)
 *
 * Fields:
 *   name              - Human-readable module name
 *   channels          - Number of physical relay channels
 *   virtual           - Number of virtual channels
 *   hasInput          - true if module has physical input channel (VMB1RYS-20 ch8)
 *   minMemoryMapVersion - minimum map version required (null = unverified)
 *
 * Confirmed type bytes (25/06/2026, from PDF edition 3 Jun 2025):
 *   VMB1RYS-20: 0x0D  (previously TBD — now confirmed)
 *   VMB4RYLD-20: 0x26
 *   VMB4RYNO-20: 0x27
 */
const RELAY_TYPES_20 = {
  0x0D: { name: 'VMB1RYS-20',   channels: 1, virtual: 0, hasInput: true,  minMemoryMapVersion: null },
  0x26: { name: 'VMB4RYLD-20',  channels: 4, virtual: 4, hasInput: false, minMemoryMapVersion: null },
  0x27: { name: 'VMB4RYNO-20',  channels: 4, virtual: 4, hasInput: false, minMemoryMapVersion: null },
};

const RELAY_TYPE_IDS_20 = new Set(Object.keys(RELAY_TYPES_20).map(Number));

module.exports = { RELAY_TYPES_20, RELAY_TYPE_IDS_20 };

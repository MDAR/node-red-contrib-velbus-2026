'use strict';

/**
 * relay-types.js
 * Registry of ORIGINAL SERIES Velbus relay module types only.
 * V2 (-20) modules are in relay-types-20.js.
 *
 * Fields:
 *   name              - Human-readable module name
 *   channels          - Number of physical relay channels
 *   virtual           - Number of virtual channels
 *   hexSwitch         - true if address set by physical hex switches
 *   hasForcedInhibit  - true | 'build1105' | false
 *   hasInput          - true if module has physical input button (VMB1RYS)
 *   minMemoryMapVersion - minimum map version required (null = unverified)
 *
 * Confirmed map versions (Toulouse, 25/06/2026):
 *   VMB1RYS 0x41: map version 0, build 2436
 *   All other original series assumed 0 pending confirmation.
 *
 * NOTE: Build number bytes in 0xFF response are NOT year/week.
 *   They are build number high byte and low byte.
 *   (byte6_decimal * 100) + byte7_decimal = build number as shown in VelbusLink.
 */
const RELAY_TYPES = {
  0x02: { name: 'VMB1RY',      channels: 1, virtual: 0, hexSwitch: true,  hasForcedInhibit: false,       hasInput: false, minMemoryMapVersion: 0 },
  0x08: { name: 'VMB4RY',      channels: 4, virtual: 0, hexSwitch: true,  hasForcedInhibit: 'build1105', hasInput: false, minMemoryMapVersion: 0 },
  0x10: { name: 'VMB4RYLD',    channels: 4, virtual: 1, hexSwitch: false, hasForcedInhibit: 'build1105', hasInput: false, minMemoryMapVersion: 0 },
  0x11: { name: 'VMB4RYNO',    channels: 4, virtual: 1, hexSwitch: false, hasForcedInhibit: 'build1105', hasInput: false, minMemoryMapVersion: 0 },
  0x1B: { name: 'VMB1RYNO',    channels: 1, virtual: 4, hexSwitch: false, hasForcedInhibit: 'build1105', hasInput: false, minMemoryMapVersion: 0 },
  0x29: { name: 'VMB1RYNOS',   channels: 1, virtual: 4, hexSwitch: false, hasForcedInhibit: true,        hasInput: false, minMemoryMapVersion: 0 },
  0x41: { name: 'VMB1RYS',     channels: 1, virtual: 4, hexSwitch: false, hasForcedInhibit: true,        hasInput: true,  minMemoryMapVersion: 0 },
  0x48: { name: 'VMB4RYLD-10', channels: 4, virtual: 1, hexSwitch: false, hasForcedInhibit: true,        hasInput: false, minMemoryMapVersion: 0 },
  0x49: { name: 'VMB4RYNO-10', channels: 4, virtual: 1, hexSwitch: false, hasForcedInhibit: true,        hasInput: false, minMemoryMapVersion: 0 },
};

const RELAY_TYPE_IDS = new Set(Object.keys(RELAY_TYPES).map(Number));

module.exports = { RELAY_TYPES, RELAY_TYPE_IDS };

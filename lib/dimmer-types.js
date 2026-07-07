'use strict';

/**
 * dimmer-types.js
 * Registry of ORIGINAL SERIES Velbus dimmer module types.
 * V2 (-20) modules are in dimmer-types-20.js.
 *
 * KEY PROTOCOL NOTES:
 *   Status packet:  0xB8 (NOT 0xEE or 0xFB)
 *   Dim value:      0-100% (NOT 0-254)
 *   Dimspeed:       16-bit seconds
 *   0xFF response:  7 bytes (no properties byte — original series)
 *   Channel:        0x01 fixed for VMBDMI/VMBDMI-R, bitmask for VMB4DC
 *
 * STATUS BYTE DIFFERENCES:
 *   VMBDMI / VMBDMI-R:  mode(2b) + error(2b) + loadType(1b) + tempBand(3b)
 *   VMB4DC:             mode(2b) only
 *
 * Fields:
 *   name              - Human-readable module name
 *   channels          - Number of dimmer channels
 *   hasThermal        - true if thermal status in 0xB8 byte3 (VMBDMI/R only)
 *   channelModel      - 'single' (fixed 0x01) or 'bitmask'
 *   minMemoryMapVersion - minimum map version required (null = unverified)
 */
const DIMMER_TYPES = {
  0x15: { name: 'VMBDMI',   channels: 1, hasThermal: true,  channelModel: 'single',  minMemoryMapVersion: null },
  0x2F: { name: 'VMBDMI-R', channels: 1, hasThermal: true,  channelModel: 'single',  minMemoryMapVersion: null },
  0x12: { name: 'VMB4DC',   channels: 4, hasThermal: false, channelModel: 'bitmask', minMemoryMapVersion: null },
};

const DIMMER_TYPE_IDS = new Set(Object.keys(DIMMER_TYPES).map(Number));

module.exports = { DIMMER_TYPES, DIMMER_TYPE_IDS };

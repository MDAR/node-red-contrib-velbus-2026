'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// Energy / power-supply-manager module type registry — V2 series
// Covered by velbus-energy node.
//
// VMBPSUMNGR-20 (0x04): manages up to two power supplies (PSU1, PSU2) feeding
//   a combined output (PSUOut) — load balancing / boost / back-up modes.
//   Reports per-rail load percentage, live wattage/voltage/amperage, a
//   warranty counter (hours in operation, 10-year/87660h limit + expired
//   flag), and PSU/warranty alarm status. Single-purpose monitoring module —
//   no per-channel I/O config in the usual sense.
//
// Source: protocol_vmbpsumngr_20.pdf (ed.1, 14/03/2025). Note: the PDF's own
// header still reads "VMB8IN-20 PROTOCOL" throughout — an un-retitled
// template artifact, not a sign this registry entry is wrong.
// ─────────────────────────────────────────────────────────────────────────────

const ENERGY_TYPES_20 = {
  0x04: {
    name:      'VMBPSUMNGR-20',
    minMapVer: null,   // no minimum stated in the protocol PDF
    series:    'v2',
  },
};

const ENERGY_TYPE_IDS_20 = new Set(Object.keys(ENERGY_TYPES_20).map(k => parseInt(k)));

module.exports = { ENERGY_TYPES_20, ENERGY_TYPE_IDS_20 };

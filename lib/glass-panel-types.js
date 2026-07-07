'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// Glass panel type registry — full VMBEL / VMBGP family
// Single velbus-glass-panel node handles all entries in this table.
//
// hasOled:      module has OLED display — DATABYTE8 of 0xED is page number,
//               0xAC memo text and 0xBE counter status are also emitted
// hasPir:       module has PIR sensor — 0xA9 raw light value emitted
// hasOc:        module has open collector output (channel 18 in protocol)
//               Confirmed from PDF: VMBEL1/2/4 and -20 variants, VMBELO/-20,
//               VMBGPO/-20, VMBELPIR/-20, VMBEL2PIR/-20, VMBGP4PIR/-20.
//               VMBGP1/2/4 original and -2/-20 series: OC NOT confirmed from
//               PDF — VMBGP1-2/2-2/4-2 protocol doc has no OC commands.
//               TO VERIFY ON HARDWARE (UK, post July 4th 2026).
//               hasOc: null = unverified, treat as false until confirmed.
// pirChannels:  channel meanings for PIR variants (1-indexed)
//               keys: channel number, value: semantic label
// channels:     number of physical button channels
// minMapVer:    minimum memory map version required (null = unverified/unknown)
// series:       'original' | 'v2'
// ─────────────────────────────────────────────────────────────────────────────

const GLASS_PANEL_TYPES = {

  // ── Original series ───────────────────────────────────────────────────────

  0x1E: {
    name: 'VMBGP1',
    channels: 1,
    hasOled: false,
    hasPir: false,
    hasOc: null,        // TO VERIFY — no PDF read for original VMBGP1
    minMapVer: null,
    series: 'original',
  },
  0x1F: {
    name: 'VMBGP2',
    channels: 2,
    hasOled: false,
    hasPir: false,
    hasOc: null,        // TO VERIFY — no PDF read for original VMBGP2
    minMapVer: null,
    series: 'original',
  },
  0x20: {
    name: 'VMBGP4',
    channels: 4,
    hasOled: false,
    hasPir: false,
    hasOc: null,        // TO VERIFY — no PDF read, was incorrectly labelled VMB6PB-20
    minMapVer: null,
    series: 'original',
  },
  0x21: {
    name: 'VMBGPO',
    channels: 32,
    hasOled: true,
    hasPir: false,
    hasOc: true,        // OLED/output variant — OC confirmed by protocol family
    minMapVer: 2,
    series: 'original',
  },
  0x2D: {
    name: 'VMBGP4PIR',
    channels: 8,
    hasOled: false,
    hasPir: true,
    hasOc: null,        // TO VERIFY on hardware
    pirChannels: {
      1: 'button1', 2: 'button2', 3: 'button3', 4: 'button4',
      5: 'virtual',  6: 'dark',    7: 'light',   8: 'motion',
    },
    minMapVer: null,
    series: 'original',
  },
  0x34: {
    name: 'VMBEL1',
    channels: 1,
    hasOled: false,
    hasPir: false,
    hasOc: true,        // Confirmed: VMBEL1/2/4 protocol PDF ed2 Nov 2024
    minMapVer: 2,
    series: 'original',
  },
  0x35: {
    name: 'VMBEL2',
    channels: 2,
    hasOled: false,
    hasPir: false,
    hasOc: true,        // Confirmed: VMBEL1/2/4 protocol PDF ed2 Nov 2024
    minMapVer: 2,
    series: 'original',
  },
  0x36: {
    name: 'VMBEL4',
    channels: 4,
    hasOled: false,
    hasPir: false,
    hasOc: true,        // Confirmed: VMBEL1/2/4 protocol PDF ed2 Nov 2024
    minMapVer: 2,
    series: 'original',
  },
  0x37: {
    name: 'VMBELO',
    channels: 4,
    hasOled: true,
    hasPir: false,
    hasOc: true,        // OLED/output variant — OC confirmed by protocol family
    minMapVer: 4,
    series: 'original',
  },
  0x38: {
    name: 'VMBELPIR',
    channels: 8,
    hasOled: false,
    hasPir: true,
    hasOc: true,        // PIR variant of VMBEL family — OC present
    pirChannels: {
      1: 'button1', 2: 'button2', 3: 'button3', 4: 'button4',
      5: 'virtual',  6: 'dark',    7: 'light',   8: 'motion',
    },
    minMapVer: 2,
    series: 'original',
  },
  0x3A: {
    name: 'VMBGP1-2',
    channels: 1,
    hasOled: false,
    hasPir: false,
    hasOc: false,       // VMBGP1-2/2-2/4-2 PDF has no OC commands — TO VERIFY on hardware
    minMapVer: null,
    series: 'original',
  },
  0x3B: {
    name: 'VMBGP2-2',
    channels: 2,
    hasOled: false,
    hasPir: false,
    hasOc: false,       // VMBGP1-2/2-2/4-2 PDF has no OC commands — TO VERIFY on hardware
    minMapVer: null,
    series: 'original',
  },
  0x3C: {
    name: 'VMBGP4-2',
    channels: 4,
    hasOled: false,
    hasPir: false,
    hasOc: false,       // VMBGP1-2/2-2/4-2 PDF has no OC commands — TO VERIFY on hardware
    minMapVer: null,
    series: 'original',
  },
  0x3D: {
    name: 'VMBGPOD-2',
    channels: 4,
    hasOled: true,
    hasPir: false,
    hasOc: null,        // OLED variant of GP series — TO VERIFY on hardware
    minMapVer: 2,
    series: 'original',
  },
  0x47: {
    name: 'VMBEL2PIR',
    channels: 6,
    hasOled: false,
    hasPir: true,
    hasOc: true,        // PIR variant of VMBEL family — OC present
    pirChannels: {
      1: 'button1', 2: 'button2',
      3: 'virtual',  4: 'dark',    5: 'light',   6: 'motion',
    },
    minMapVer: null,
    series: 'original',
  },

  // ── V2 series ─────────────────────────────────────────────────────────────

  0x4F: {
    name: 'VMBEL1-20',
    channels: 1,
    hasOled: false,
    hasPir: false,
    hasOc: true,        // Confirmed: VMBEL1/2/4 protocol PDF ed2 Nov 2024 covers -20 variants
    minMapVer: null,
    series: 'v2',
  },
  0x50: {
    name: 'VMBEL2-20',
    channels: 2,
    hasOled: false,
    hasPir: false,
    hasOc: true,        // Confirmed: VMBEL1/2/4 protocol PDF ed2 Nov 2024 covers -20 variants
    minMapVer: null,
    series: 'v2',
  },
  0x51: {
    name: 'VMBEL4-20',
    channels: 4,
    hasOled: false,
    hasPir: false,
    hasOc: true,        // Confirmed: VMBEL1/2/4 protocol PDF ed2 Nov 2024 covers -20 variants
    minMapVer: null,
    series: 'v2',
  },
  0x52: {
    name: 'VMBELO-20',
    channels: 4,
    hasOled: true,
    hasPir: false,
    hasOc: true,        // OLED/output variant — OC confirmed by protocol family
    minMapVer: null,
    series: 'v2',
  },
  0x53: {
    name: 'VMBELPIR-20',  // Official list shows VMBBEL1PIR-20 — TO VERIFY via VelbusLink
    channels: 8,
    hasOled: false,
    hasPir: true,
    hasOc: true,        // PIR variant of VMBEL family — OC present
    pirChannels: {
      1: 'button1', 2: 'button2', 3: 'button3', 4: 'button4',
      5: 'virtual',  6: 'dark',    7: 'light',   8: 'motion',
    },
    minMapVer: null,
    series: 'v2',
  },
  0x54: {
    name: 'VMBGP1-20',
    channels: 1,
    hasOled: false,
    hasPir: false,
    hasOc: null,        // TO VERIFY — GP series OC status unconfirmed
    minMapVer: null,
    series: 'v2',
  },
  0x55: {
    name: 'VMBGP2-20',
    channels: 2,
    hasOled: false,
    hasPir: false,
    hasOc: null,        // TO VERIFY — GP series OC status unconfirmed
    minMapVer: null,
    series: 'v2',
  },
  0x56: {
    name: 'VMBGP4-20',
    channels: 4,
    hasOled: false,
    hasPir: false,
    hasOc: null,        // TO VERIFY — GP series OC status unconfirmed
    minMapVer: null,
    series: 'v2',
  },
  0x57: {
    name: 'VMBGPO-20',
    channels: 32,
    hasOled: true,
    hasPir: false,
    hasOc: true,        // OLED/output variant — OC confirmed by protocol family
    minMapVer: null,
    series: 'v2',
  },
  0x5C: {
    name: 'VMBEL2PIR-20',  // Official list shows VMBBEL2PIR-20 / VMBEL4PIR-20 conflict — TO VERIFY via VelbusLink
    channels: 6,
    hasOled: false,
    hasPir: true,
    hasOc: true,        // PIR variant of VMBEL family — OC present
    pirChannels: {
      1: 'button1', 2: 'button2',
      3: 'virtual',  4: 'dark',    5: 'light',   6: 'motion',
    },
    minMapVer: null,
    series: 'v2',
  },
  0x5F: {
    name: 'VMBGP4PIR-20',
    channels: 8,
    hasOled: false,
    hasPir: true,
    hasOc: null,        // TO VERIFY — GP4PIR OC status unconfirmed
    pirChannels: {
      1: 'button1', 2: 'button2', 3: 'button3', 4: 'button4',
      5: 'virtual',  6: 'dark',    7: 'light',   8: 'motion',
    },
    minMapVer: null,
    series: 'v2',
  },
};

// Flat set of all type byte values — used for quick membership test in scan node
const GLASS_PANEL_TYPE_IDS = new Set(
  Object.keys(GLASS_PANEL_TYPES).map(k => parseInt(k))
);

module.exports = { GLASS_PANEL_TYPES, GLASS_PANEL_TYPE_IDS };

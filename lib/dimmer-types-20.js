'use strict';

/**
 * dimmer-types-20.js
 * Registry of V2 (-20 series) Velbus dimmer/output module types.
 * Original series modules are in dimmer-types.js.
 *
 * ALL THREE MODULES SHARE IDENTICAL PACKET STRUCTURE.
 * The only behavioural difference is the dim curve:
 *   linear      — VMB2DC-20, VMB8DC-20 (0-10V DC output)
 *   exponential — VMB4LEDPWM-20 (PWM LED output, perceptual curve)
 *
 * WHAT THESE MODULES OUTPUT:
 *   VMB2DC-20 / VMB8DC-20:  0-10V DC control voltage per channel.
 *     No mains load. Drives dimmer packs (Finder, Mode Lighting etc.),
 *     linear actuators, variable valves, any 0-10V compatible input.
 *   VMB4LEDPWM-20: Direct PWM per channel for LED strips/drivers.
 *
 * VMB4LEDPWM-20 OUTPUT GROUPING MODES:
 *   The four PWM channels can be grouped in three ways. This is a
 *   hardware/memory configuration decision made at commissioning time.
 *   The mode must match the physical wiring.
 *
 *   'single'  — 4 independent single-colour channels (default)
 *               CH1, CH2, CH3, CH4 each drive separate LED circuits.
 *               Use cmd: 'set' per channel.
 *
 *   'rgb'     — CH1=Red, CH2=Green, CH3=Blue form one RGB group.
 *               CH4 remains independent.
 *               Use cmd: 'rgbw' for the group (W byte ignored).
 *               Use cmd: 'set' for CH4.
 *
 *   'rgbw'    — All four channels form one RGBW group.
 *               CH1=Red, CH2=Green, CH3=Blue, CH4=White.
 *               Use cmd: 'rgbw' for all colour control.
 *
 *   RESOLVED (protocol PDF ed.2, 01/07/2025): there is no single "mode byte".
 *   The mode is the emergent result of each channel's per-channel "Device Type"
 *   setting (settings index 25). Channel 1 = 0x08 (RGBW control) means the
 *   module is in 'rgbw' mode; channel 1 = 0xF0 (RGB control) means 'rgb' mode;
 *   any single-lamp type (typically 0x06, LED module) on every channel means
 *   'single' mode. See DEVICE_TYPE_NAMES below for the full value table.
 *
 *   Read via the settings API: 0xE7 [channel, 0x00, 25] request →
 *   0xE8 [channel, 25, device_type] reply. This node's 'get_device_type'
 *   input command performs this read and reports the detected mode on
 *   output 1, warning on output 2 if it disagrees with the configured
 *   ledMode. Direct memory addresses also exist (0x066C/0x06D0/0x0734/0x0798,
 *   0x64-byte stride per channel) but are for VLP-level analysis only —
 *   this node always uses the settings API, never a raw memory write.
 *
 *   This node exposes the mode as a config property so the correct command
 *   set can be applied and documented. It does NOT write the mode to the
 *   module — that remains a deliberate commissioning-time decision, made by
 *   the installer or the VelbusAI commissioning agent, never automatically.
 *
 *   CRITICAL: Sending individual channel dim commands to a module
 *   configured as 'rgb' or 'rgbw' bypasses colour coordination.
 *   The result will look wrong. Always confirm mode before commissioning.
 *
 * KEY PROTOCOL NOTES:
 *   Status packet:  0xEE (NOT 0xFB or 0xB8)
 *   Dim value:      0-254 raw (NOT 0-100%)
 *   Dim value pkt:  0xA5 (up to 4 channels packed per packet)
 *   Set dim:        0x07 + channel + value(0-254) + fade_mode
 *                   fade_mode: 0=direct, 1=rate, 2=time
 *   RGBW:           0x1E + group + R + G + B + W + fade_mode
 *   Scenes:         16 scenes (S0-S15), command 0x1D
 *   0xFF response:  8 bytes (properties byte: CAN FD, terminator, HW ver)
 *   Channel 0xFF:   broadcast to all channels
 *
 * NOTE: VMB2DC-20, VMB8DC-20 and VMB4LEDPWM-20 PDFs contain DALI-referencing
 *   commands. These are documentation bleed-over from the shared VMBDALI
 *   codebase and are INVALID for all three modules. Ignore all DALI references.
 *
 * Confirmed on Toulouse site (26/06/2026):
 *   VMB8DC-20 type 0x4B — present on site, channels 1/4/8 verified live.
 *
 * Fields:
 *   name                - Human-readable module name
 *   channels            - Number of output channels
 *   outputType          - '0-10V' or 'PWM'
 *   dimCurve            - 'linear' or 'exponential'
 *   ledMode             - VMB4LEDPWM-20 only: 'single'|'rgb'|'rgbw'|null
 *                         null = not applicable (VMB2DC-20, VMB8DC-20)
 *   minMemoryMapVersion - minimum map version required (null = unverified)
 */
const DIMMER_TYPES_20 = {
  0x24: { name: 'VMB2DC-20',     channels: 2,  outputType: '0-10V', dimCurve: 'linear',      ledMode: null, minMemoryMapVersion: null },
  0x4B: { name: 'VMB8DC-20',     channels: 8,  outputType: '0-10V', dimCurve: 'linear',      ledMode: null, minMemoryMapVersion: null },
  0x06: { name: 'VMB4LEDPWM-20', channels: 4,  outputType: 'PWM',   dimCurve: 'exponential', ledMode: 'single', minMemoryMapVersion: null },
};

const DIMMER_TYPE_IDS_20 = new Set(Object.keys(DIMMER_TYPES_20).map(Number));

// Type bytes for which ledMode configuration is applicable
const LEDPWM_TYPE_IDS = new Set([0x06]);

/**
 * VMB4LEDPWM-20 per-channel "Device Type" setting (settings index 25).
 * Read via 0xE7/0xE8 settings API — see doc comment above.
 * Source: VMB4LEDPWM-20 protocol PDF ed.2 (01/07/2025).
 */
const DEVICE_TYPE_NAMES = {
  0x00: 'Fluorescent lamps',
  0x01: 'Emergency lamps',
  0x02: 'Discharge lamps',
  0x03: 'Low voltage lamps',
  0x04: 'Dimmer for incandescent lamps',
  0x05: 'Conversion to DC voltage (1-10V)',
  0x06: 'LED module',
  0x07: 'Switching device (relay)',
  0x08: 'RGBW control (consumes all 4 channels)',
  0x09: 'Sequencer',
  0xF0: 'RGB control (consumes channels 1-3, channel 4 independent)',
  0xFE: 'Device present but type unknown',
  0xFF: 'Device not present (factory default)'
};

module.exports = { DIMMER_TYPES_20, DIMMER_TYPE_IDS_20, LEDPWM_TYPE_IDS, DEVICE_TYPE_NAMES };

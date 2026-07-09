'use strict';

const { pkt, parsePkt } = require('../../lib/velbus-utils');
const { GLASS_PANEL_TYPES, GLASS_PANEL_TYPE_IDS } = require('../../lib/glass-panel-types');

// ─────────────────────────────────────────────────────────────────────────────
// Thermostat mode constants
// ─────────────────────────────────────────────────────────────────────────────
const THERM_MODE_CMD = {
  comfort: 0xDB,
  day:     0xDC,
  night:   0xDD,
  safe:    0xDE,
};

const THERM_MODE_LABEL = {
  0: 'comfort',
  1: 'day',
  2: 'night',
  3: 'safe',
};

const THERM_STATUS_LABEL = {
  0: 'disabled',
  1: 'manual',
  2: 'timer',
  3: 'timer_override',
};

// ─────────────────────────────────────────────────────────────────────────────
// LED command bytes
// ─────────────────────────────────────────────────────────────────────────────
const LED_CMD = {
  led_clear: 0xF5,
  led_set:   0xF6,
  led_slow:  0xF7,
  led_fast:  0xF8,
  led_vfast: 0xF9,
};

// ─────────────────────────────────────────────────────────────────────────────
// Edge colour constants — VMBEL family only (hasEdgeLed), confirmed identical
// byte layout across every VMBEL sub-family protocol PDF checked (VMBEL1/2/4,
// VMBELO, VMBELPIR, and their -20 siblings). Command byte 0xD4
// (COMMAND_SET_PB_BACKLIGHT) is shared with 'Set Custom Color' (defining new
// custom RGB palette entries) — deliberately NOT implemented here. Defining
// custom colours is commissioning-time configuration and stays in
// VelbusLink's domain, same reasoning as VMB4LEDPWM-20's grouping mode and
// Program Step read/write elsewhere in this project. Only 'Set Edge Color'
// (applying an already-defined colour — default palette, or a custom slot
// VelbusLink has already programmed) is in scope: a genuine live/runtime
// action, not palette editing.
// ─────────────────────────────────────────────────────────────────────────────
const EDGE_LAYER_BITS = {
  background:  0x01,
  continuous:  0x02,
  slow_blink:  0x04,
  fast_blink:  0x08,
};
const EDGE_SIDE_BITS = {
  left:   0x01,
  top:    0x02,
  right:  0x04,
  bottom: 0x08,
};
const EDGE_PRIORITY = { low: 0x01, mid: 0x02, high: 0x03 };

// ─────────────────────────────────────────────────────────────────────────────
// Channel bitmask helpers
// ─────────────────────────────────────────────────────────────────────────────
function bitsToChannels(byte1, byte2, byte3, byte4) {
  // Returns array of 1-indexed channel numbers where bit is set
  const channels = [];
  const bytes = [byte1 || 0, byte2 || 0, byte3 || 0, byte4 || 0];
  for (let b = 0; b < 4; b++) {
    for (let bit = 0; bit < 8; bit++) {
      if (bytes[b] & (1 << bit)) channels.push(b * 8 + bit + 1);
    }
  }
  return channels;
}

function channelToBit(ch) {
  // Returns { byteIndex, mask } for a 1-indexed channel number
  const zero = ch - 1;
  return { byteIndex: Math.floor(zero / 8), mask: 1 << (zero % 8) };
}

// ─────────────────────────────────────────────────────────────────────────────
// Node
// ─────────────────────────────────────────────────────────────────────────────
module.exports = function(RED) {

  function VelbusGlassPanelNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;

    node.bridge        = RED.nodes.getNode(config.bridge);
    node.address       = typeof config.address === 'number'
      ? config.address  // legacy saves stored decimal numbers
      : (parseInt(config.address, 16) || 0);  // editor stores hex strings
    node.channelCount  = parseInt(config.channelCount) || 4;
    node.moduleName    = config.moduleName || '';
    node.typeId        = config.typeId ? parseInt(config.typeId) : null;

    if (!node.bridge) {
      node.status({ fill: 'red', shape: 'ring', text: 'no bridge' });
      node.error('velbus-glass-panel: no bridge configured');
      return;
    }
    if (!node.address || node.address < 1 || node.address > 254) {
      node.status({ fill: 'red', shape: 'ring', text: 'invalid address' });
      node.error('velbus-glass-panel: invalid address ' + node.address);
      return;
    }

    // Resolved type descriptor — may be null if typeId unknown or not set
    const typeDesc = (node.typeId !== null) ? (GLASS_PANEL_TYPES[node.typeId] || null) : null;
    const hasOled  = typeDesc ? typeDesc.hasOled  : false;
    const hasPir   = typeDesc ? typeDesc.hasPir   : false;
    const hasEdgeLed = typeDesc ? !!typeDesc.hasEdgeLed : false;
    const hasOc    = typeDesc ? !!typeDesc.hasOc  : false;
    const pirCh    = typeDesc ? (typeDesc.pirChannels || {}) : {};

    // Subaddresses populated from scan data (thermostat sub-address etc.)
    // Key: subaddress decimal, value: role string
    const _subAddresses = {};

    // Name retrieval state
    let _nameParts  = {};
    let _nameTimer  = null;

    function assembleName() {
      if (_nameTimer) { clearTimeout(_nameTimer); _nameTimer = null; }
      const bytes = [
        ...(_nameParts[0] || []),
        ...(_nameParts[1] || []),
        ...(_nameParts[2] || []),
      ].filter(b => b !== 0 && b !== 0xFF);
      const name = String.fromCharCode(...bytes).trim();
      if (name) node.moduleName = name;
    }

    // Friendly label for status bar
    const _label = node.moduleName
      ? node.moduleName + ' (0x' + node.address.toString(16).padStart(2, '0').toUpperCase() + ')'
      : '0x' + node.address.toString(16).padStart(2, '0').toUpperCase();

    function setStatus(text, fill, shape) {
      node.status({ fill: fill || 'green', shape: shape || 'dot', text: _label + ' ' + text });
    }

    // ── Packet receive handler ───────────────────────────────────────────

    function onPacket(raw) {
      const p = parsePkt(raw);
      if (!p || p.rtr) return;

      const { addr, cmd, body } = p;

      // Accept packets from primary address and any registered sub-addresses
      const isMe = (addr === node.address) ||
                   (addr in _subAddresses);
      if (!isMe) return;

      switch (cmd) {

        // ── 0x00  Button press / release ──────────────────────────────────
        case 0x00: {
          if (body.length < 3) return;
          // body[0]=0x00 cmd, body[1]=DB2 pressed, body[2]=DB3 released, body[3]=DB4 long
          const pressed     = bitsToChannels(body[1]);
          const released    = bitsToChannels(body[2]);
          const longPressed = body.length >= 4 ? bitsToChannels(body[3]) : [];

          // Map PIR channel numbers to semantic labels when known
          function mapPir(chs) {
            if (!hasPir || !Object.keys(pirCh).length) return chs;
            return chs.map(ch => pirCh[ch] !== undefined
              ? { channel: ch, label: pirCh[ch] }
              : { channel: ch });
          }

          const on = pressed.length > 0 || longPressed.length > 0;

          const payload = {
            type:        'button',
            on,
            pressed:     hasPir ? mapPir(pressed)     : pressed,
            released:    hasPir ? mapPir(released)    : released,
            longPressed: hasPir ? mapPir(longPressed) : longPressed,
          };
          setStatus('button');
          node.send([{ payload }, null, null]);
          break;
        }

        // ── 0xED  Module status ────────────────────────────────────────────
        case 0xED: {
          if (body.length < 8) return;

          // body[0] = 0xED (command byte — skip)
          // body[1] = DB2: channel 1-8 status (pressed/released) — not used here
          // body[2] = DB3: enabled/disabled channel status — not used here
          // body[3] = DB4: OC output + sensor flags
          // body[4] = DB5: locked channel bitmask
          // body[5] = DB6: disabled channel program bitmask
          // body[6] = DB7: alarm & program selection
          // body[7] = DB8: OLED page number (OLED types only)

          const ocByte = body[3];
          const ocOn              = !!(ocByte & 0x80);
          const ocLocked          = !!(ocByte & 0x40);
          const ocProgramDisabled = !!(ocByte & 0x20);

          const lockedChannels       = bitsToChannels(body[4]);
          const progDisabledChannels = bitsToChannels(body[5]);

          const progByte = body[6];
          const thermostatProgram = THERM_STATUS_LABEL[progByte & 0x03] || 'unknown';
          const alarm1Active = !!(progByte & 0x04);
          const alarm2Active = !!(progByte & 0x08);

          const payload = {
            type: 'status',
            locked: lockedChannels,
            thermostatProgram,
            alarms: {
              alarm1Active,
              alarm2Active,
              selected: progByte >> 6,
            },
          };

          // Open collector state — only emit if module is known to have OC
          if (hasOc) {
            payload.output = {
              on:              ocOn,
              locked:          ocLocked,
              programDisabled: ocProgramDisabled,
            };
          }

          // OLED types: body[7] = DB8 = display page number
          if (hasOled && body.length >= 8) {
            payload.oledPage = body[7];
          }

          setStatus('status');
          node.send([null, { payload }, null]);
          break;
        }

        // ── 0xEA  Thermostat status ────────────────────────────────────────
        case 0xEA: {
          if (body.length < 8) return;
          // body[0]=0xEA cmd
          // body[1]=DB2 operating mode byte
          // body[2]=DB3 program step mode byte
          // body[3]=DB4 output status byte
          // body[4]=DB5 current sensor temp (signed, resolution 0.5°)
          // body[5]=DB6 current temperature set (signed, resolution 0.5°)
          // body[6]=DB7 sleep timer high byte
          // body[7]=DB8 sleep timer low byte

          const opMode = body[1];
          // Mode bits 4-6: comfort=0x40, day=0x20, night=0x10, safe=0x00
          const modeBits = (opMode >> 4) & 0x07;
          const mode = modeBits === 4 ? 'comfort'
                     : modeBits === 2 ? 'day'
                     : modeBits === 1 ? 'night'
                     : 'safe';
          const heaterMode   = !(opMode & 0x80);              // bit7: 0=heater, 1=cooler
          const runModeBits  = opMode & 0x06;
          const thermostatOn = runModeBits !== 0x06;          // 0x06 = disabled

          const outByte  = body[3];                           // DB4 output status
          const heating  = !!(outByte & 0x01);               // heater on
          const boostMode = !!(outByte & 0x02);              // boost on
          const cooling  = !!(outByte & 0x08);               // cooler on

          // Signed 0.5° resolution: raw byte is two's complement
          const rawCurrent = body[4] > 127 ? body[4] - 256 : body[4];
          const rawTarget  = body[5] > 127 ? body[5] - 256 : body[5];
          const currentTemp = rawCurrent * 0.5;
          const targetTemp  = rawTarget  * 0.5;

          const payload = {
            type:        'thermostat',
            currentTemp,
            targetTemp,
            mode,
            heaterMode,
            heating,
            cooling,
            boostMode,
            thermostatOn,
          };

          setStatus('therm ' + currentTemp.toFixed(1) + '°C → ' + targetTemp.toFixed(1) + '°C');
          node.send([null, { payload }, null]);
          break;
        }

        // ── 0xE6  Current temperature ─────────────────────────────────────
        case 0xE6: {
          if (body.length < 3) return;
          // body[0]=0xE6 cmd, body[1-2]=DB2-3 current temp hi/lo (0.0625° resolution)
          // body[3-4]=DB4-5 min temp, body[5-6]=DB6-7 max temp (optional)
          // 16-bit signed, °C × 512 (0.0625° resolution, low 5 bits unused)
          const t16 = (hi, lo) => { const r = (hi << 8) | lo; return (r > 32767 ? r - 65536 : r) / 512; };
          const current = t16(body[1], body[2]);
          const min = body.length >= 5 ? t16(body[3], body[4]) : null;
          const max = body.length >= 7 ? t16(body[5], body[6]) : null;

          const payload = { type: 'temperature', current };
          if (min !== null) payload.min = min;
          if (max !== null) payload.max = max;

          node.send([null, { payload }, null]);
          break;
        }

        // ── 0xA9  Raw light sensor value (PIR types only) ─────────────────
        case 0xA9: {
          if (!hasPir) return;
          if (body.length < 3) return;
          // body[0]=0xA9 cmd, body[1-2]=DB2-3 16-bit light value
          const raw = (body[1] << 8) | body[2];
          const payload = { type: 'light', raw };
          node.send([null, { payload }, null]);
          break;
        }

        // ── 0xAC  Memo text (OLED types only) ────────────────────────────
        case 0xAC: {
          if (!hasOled) return;
          // body[0]=0xAC cmd, body[1]=DB2 page, body[2..]=DB3.. ASCII null-terminated
          const page = body[1];
          let text = '';
          for (let i = 2; i < body.length; i++) {
            if (body[i] === 0) break;
            text += String.fromCharCode(body[i]);
          }
          const payload = { type: 'memo', page, text };
          node.send([null, { payload }, null]);
          break;
        }

        // ── 0xBE  Counter status (OLED types only) ───────────────────────
        case 0xBE: {
          if (!hasOled) return;
          if (body.length < 6) return;
          // body[0]=0xBE cmd, body[1]=DB2 counter, body[2-5]=DB3-6 32-bit value
          const counter = body[1];
          const value   = (body[2] << 24) | (body[3] << 16) | (body[4] << 8) | body[5];
          const payload = { type: 'counter', counter, value };
          node.send([null, { payload }, null]);
          break;
        }

        // ── 0xF0/F1/F2  Name part response ───────────────────────────────
        case 0xF0:
        case 0xF1:
        case 0xF2: {
          // body[0]=cmd (0xF0/F1/F2), body[1]=DB2 channel number, body[2..]=DB3.. chars
          const part = cmd - 0xF0; // 0, 1, 2
          _nameParts[part] = Array.from(body).slice(2); // strip cmd + channel bytes
          let text = '';
          for (let i = 2; i < body.length; i++) {
            if (body[i] === 0) break;
            text += String.fromCharCode(body[i]);
          }
          if (part === 2) assembleName();
          node.send([null, null, { payload: { type: 'name_part', part, text } }]);
          break;
        }

        default:
          break;
      }
    }

    node.bridge.register(node.address, onPacket);

    // Auto-retrieve module name on startup (2s timeout)
    setTimeout(function() {
      node.bridge.send(pkt(0xF8, node.address, [0xEF]));
      _nameTimer = setTimeout(assembleName, 2000);
    }, 500);

    // Register sub-address listener if scan data provides them
    // (bridge passive 0xB0 handler already captures these; we read from
    //  scan results stored on bridge if available)
    if (node.bridge.getScanResults) {
      const results = node.bridge.getScanResults();
      if (results) {
        const me = results.find(m => m.addressDec === node.address);
        if (me && me.subaddresses) {
          me.subaddresses.forEach(sa => {
            const dec = parseInt(sa, 16);
            if (dec && dec !== node.address) {
              _subAddresses[dec] = 'sub';
              node.bridge.register(dec, onPacket);
            }
          });
        }
      }
    }

    // ── Input command handler ────────────────────────────────────────────

    node.on('input', function(msg) {
      const cmd = msg.payload && msg.payload.cmd;
      if (!cmd) return;

      // ── Thermostat mode switch ─────────────────────────────────────────
      if (THERM_MODE_CMD[cmd] !== undefined) {
        // sleepTime: 0 = until next programme step, >0 = minutes
        const sleep = (msg.payload.sleepTime !== undefined)
          ? parseInt(msg.payload.sleepTime) : 0;
        const sleepHi = (sleep >> 8) & 0xFF;
        const sleepLo = sleep & 0xFF;
        const out = pkt(0xF8, node.address, [THERM_MODE_CMD[cmd], sleepHi, sleepLo]);
        node.bridge.send(out);
        return;
      }

      // ── Set target temperature ─────────────────────────────────────────
      if (cmd === 'set_temp') {
        const pointer = (msg.payload.pointer !== undefined)
          ? parseInt(msg.payload.pointer) : 0;  // 0=comfort,1=day,2=night,3=safe
        const tempRaw = Math.round((parseFloat(msg.payload.temp) || 0) * 100);
        const tempHi  = (tempRaw >> 8) & 0xFF;
        const tempLo  = tempRaw & 0xFF;
        const out = pkt(0xF8, node.address, [0xE4, pointer, tempHi, tempLo]);
        node.bridge.send(out);
        return;
      }

      // ── LED control ────────────────────────────────────────────────────
      if (LED_CMD[cmd] !== undefined) {
        const ch = parseInt(msg.payload.channel) || 1;
        const { byteIndex, mask } = channelToBit(ch);
        const bytes = [0, 0, 0, 0];
        bytes[byteIndex] = mask;
        const out = pkt(0xF8, node.address, [LED_CMD[cmd], ...bytes]);
        node.bridge.send(out);
        return;
      }

      // ── Set edge colour (VMBEL family only) ─────────────────────────────
      // Applies an already-defined colour (default palette, or a custom
      // slot VelbusLink has already programmed) across a chosen combination
      // of layer(s), edge(s), and button page. Does NOT define new custom
      // colours — that stays in VelbusLink, see the constants comment above.
      if (cmd === 'set_edge_color') {
        if (!hasEdgeLed) {
          node.warn('velbus-glass-panel: ' + (typeDesc ? typeDesc.name : 'this module type') +
            ' has no edge lighting (VMBEL family only) — sending nothing.');
          return;
        }

        const layers = Array.isArray(msg.payload.layers) ? msg.payload.layers : ['background'];
        const edges  = Array.isArray(msg.payload.edges)  ? msg.payload.edges  : ['left', 'top', 'right', 'bottom'];
        const palette = msg.payload.palette === 'custom' ? 'custom' : 'default';
        const index  = Math.max(0, Math.min(31, parseInt(msg.payload.index) || 0));
        const blink  = !!msg.payload.blink;

        let db2 = 0;
        for (const l of layers) db2 |= (EDGE_LAYER_BITS[l] || 0);
        if (palette === 'custom') db2 |= 0x80;

        let db3 = 0;
        for (const e of edges) db3 |= (EDGE_SIDE_BITS[e] || 0);
        // Page: 1-8 map to nibble 0-7; 'all' (or omitted) uses 0xF, matching
        // the protocol's own stated range (1000xxxx through 1111xxxx all
        // mean "all pages" — 0xF is simply the clearest, most explicit value
        // in that range to use).
        const page = msg.payload.page;
        const pageNibble = (page === undefined || page === 'all')
          ? 0x0F
          : Math.max(0, Math.min(7, parseInt(page) - 1));
        db3 |= (pageNibble << 4) & 0xF0;

        let db4 = index & 0x1F;
        if (blink) db4 |= 0x80;
        if (palette === 'custom') {
          db4 |= (EDGE_PRIORITY[msg.payload.priority] || EDGE_PRIORITY.low) << 5;
        }

        node.bridge.send(pkt(0xFB, node.address, [0xD4, db2, db3, db4]));
        return;
      }

      // ── Open collector output ──────────────────────────────────────────
      if (cmd === 'output_on') {
        // COMMAND_SWITCH_RELAY_ON (0x02), channel byte = don't care (0xFF)
        node.bridge.send(pkt(0xF8, node.address, [0x02, 0xFF]));
        return;
      }
      if (cmd === 'output_off') {
        // COMMAND_SWITCH_RELAY_OFF (0x01), channel byte = don't care (0xFF)
        node.bridge.send(pkt(0xF8, node.address, [0x01, 0xFF]));
        return;
      }
      if (cmd === 'output_timer') {
        // COMMAND_START_RELAY_TIMER (0x03)
        // 24-bit duration in seconds: [channel, hiB, midB, loB]
        const duration = parseInt(msg.payload.duration) || 0;
        const hiB  = (duration >> 16) & 0xFF;
        const midB = (duration >>  8) & 0xFF;
        const loB  =  duration        & 0xFF;
        node.bridge.send(pkt(0xF8, node.address, [0x03, 0xFF, hiB, midB, loB]));
        return;
      }

      // ── Request module status ──────────────────────────────────────────
      if (cmd === 'get_status') {
        const out = pkt(0xFB, node.address, [0xFA]);
        node.bridge.send(out);
        return;
      }

      // ── Request thermostat status ──────────────────────────────────────
      if (cmd === 'get_thermostat') {
        const out = pkt(0xF8, node.address, [0xE7]);
        node.bridge.send(out);
        return;
      }

      // ── Request module name ────────────────────────────────────────────
      if (cmd === 'get_name') {
        const out = pkt(0xF8, node.address, [0xEF]);
        node.bridge.send(out);
        return;
      }

      // ── Heat / cool mode ───────────────────────────────────────────────
      if (cmd === 'heat_mode') {
        node.bridge.send(pkt(0xF8, node.address, [0xE0]));
        return;
      }
      if (cmd === 'cool_mode') {
        node.bridge.send(pkt(0xF8, node.address, [0xDF]));
        return;
      }

      node.warn('velbus-glass-panel: unknown cmd: ' + cmd);
    });

    // ── Cleanup ──────────────────────────────────────────────────────────

    node.on('close', function() {
      if (_nameTimer) { clearTimeout(_nameTimer); _nameTimer = null; }
      node.bridge.deregister(node.address, onPacket);
      Object.keys(_subAddresses).forEach(sa => {
        node.bridge.deregister(parseInt(sa), onPacket);
      });
    });

    setStatus('ready', 'grey', 'dot');
  }

  RED.nodes.registerType('velbus-glass-panel', VelbusGlassPanelNode);
};

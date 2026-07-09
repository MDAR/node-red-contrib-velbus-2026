'use strict';

const { pkt, parsePkt } = require('../../lib/velbus-utils');
const { SENSOR_TYPES, SENSOR_TYPE_IDS } = require('../../lib/sensor-types');

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function activeFromBitmask(byte) {
  const active = [];
  for (let i = 0; i < 8; i++) {
    if (byte & (1 << i)) active.push(i + 1);
  }
  return active;
}

function decodeNameBitmask(byte) {
  // Returns the channel number (1-8) for a single-bit bitmask
  for (let i = 0; i < 8; i++) {
    if (byte === (1 << i)) return i + 1;
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Node
// ─────────────────────────────────────────────────────────────────────────────

module.exports = function(RED) {

  function VelbusSensorNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;

    node.bridge    = RED.nodes.getNode(config.bridge);
    node.address   = typeof config.address === 'number'
      ? config.address  // legacy saves stored decimal numbers
      : (parseInt(config.address, 16) || 0);  // editor stores hex strings
    node.moduleName = config.moduleName || '';
    node.typeId    = config.typeId ? parseInt(config.typeId) : null;

    if (!node.bridge) {
      node.status({ fill: 'red', shape: 'ring', text: 'no bridge' });
      node.error('velbus-sensor: no bridge configured');
      return;
    }
    if (!node.address || node.address < 1 || node.address > 254) {
      node.status({ fill: 'red', shape: 'ring', text: 'invalid address' });
      node.error('velbus-sensor: invalid address ' + node.address);
      return;
    }

    const typeDesc   = node.typeId !== null ? (SENSOR_TYPES[node.typeId] || null) : null;
    const hasCounter = typeDesc ? typeDesc.hasCounter : false;
    const isVMB4AN   = node.typeId === 0x32;

    const _addrHex = '0x' + node.address.toString(16).padStart(2, '0').toUpperCase();
    const _label = () => node.moduleName
      ? node.moduleName + ' (' + _addrHex + ')'
      : (typeDesc ? typeDesc.name : 'sensor') + ' ' + _addrHex;

    function setStatus(text, fill, shape) {
      node.status({ fill: fill || 'green', shape: shape || 'dot',
        text: _label() + ' ' + text });
    }

    // Channel name store — keyed by channel number (1-8)
    const _channelNames = {};
    const _nameParts    = {};  // keyed by channel number, then part 0/1/2

    function assembleName(ch) {
      const parts = _nameParts[ch];
      if (!parts) return;
      const bytes = [
        ...(parts[0] || []),
        ...(parts[1] || []),
        ...(parts[2] || []),
      ].filter(b => b !== 0 && b !== 0xFF);
      const name = String.fromCharCode(...bytes).trim();
      if (name) _channelNames[ch] = name;
    }

    // ── Packet handler ────────────────────────────────────────────────────

    function onPacket(raw) {
      const p = parsePkt(raw);
      if (!p || p.rtr) return;
      // Note: no address re-check here. The bridge routes frames to this
      // listener, including subaddress frames mapped to the primary address
      // (e.g. GPO-20 thermostat status from subaddress 0x34).

      const { cmd, body } = p;

      switch (cmd) {

        // ── 0x00  Channel events ──────────────────────────────────────────
        case 0x00: {
          if (body.length < 4) return;
          // body[0]=cmd, body[1]=pressed, body[2]=released, body[3]=longPressed
          const pressed     = activeFromBitmask(body[1]);
          const released    = activeFromBitmask(body[2]);
          const longPressed = activeFromBitmask(body[3]);
          const on = pressed.length > 0 || longPressed.length > 0;

          const payload = { type: 'channel', on, pressed, released, longPressed };
          if (pressed.length) setStatus('ch' + pressed.join(',') + ' on');
          node.send([{ payload }, null]);
          break;
        }

        // ── 0xED  Module status ───────────────────────────────────────────
        case 0xED: {
          // VMB7IN: PDF says DLC=5 but lists 7 fields — treat as 7 data bytes
          if (body.length < 7) return;
          // body[0]=0xED, body[1]=channel status, body[2]=enabled/disabled,
          // body[3]=normal/inverted, body[4]=locked, body[5]=prog-disabled,
          // body[6]=alarm&program
          const on = body[1] !== 0;
          const progByte = body[6];
          const program = ['none', 'summer', 'winter', 'holiday'][progByte & 0x03];
          const alarm1Active   = !!(progByte & 0x04);
          const alarm2Active   = !!(progByte & 0x10);
          const sunriseEnabled = !!(progByte & 0x40);
          const sunsetEnabled  = !!(progByte & 0x80);

          const payload = {
            type:          'status',
            on,
            channels:      activeFromBitmask(body[1]),
            enabled:       activeFromBitmask(body[2]),
            normal:        activeFromBitmask(body[3]),
            locked:        activeFromBitmask(body[4]),
            progDisabled:  activeFromBitmask(body[5]),
            program,
            alarms: { alarm1Active, alarm2Active },
            sunrise: sunriseEnabled,
            sunset:  sunsetEnabled,
          };
          node.send([{ payload }, null]);
          break;
        }

        // ── 0xBE  Pulse counter status (VMB7IN channels 1-4) ─────────────
        case 0xBE: {
          if (!hasCounter) return;
          if (body.length < 8) return;
          // body[0]=0xBE
          // body[1]: bits0-1=channel(0-3), bits2-7=pulses-per-unit scaling
          // body[2-5]: 32-bit pulse count (MSB first)
          // body[6-7]: 16-bit period in ms between last 2 pulses (0xFFFF=overflow)
          const channelIndex = body[1] & 0x03;       // 0-3
          const channel = channelIndex + 1;           // 1-4
          const scalingBits = (body[1] >> 2) & 0x3F; // bits 2-7
          // scaling encodes pulses per unit * 100 (e.g. 0x01=100, 0x0A=1000)
          const pulsesPerUnit = scalingBits * 100;

          const count = ((body[2] << 24) | (body[3] << 16) | (body[4] << 8) | body[5]) >>> 0;
          const periodMs = (body[6] << 8) | body[7];
          const overflow = periodMs === 0xFFFF;

          const payload = {
            type:         'counter',
            channel,
            count,
            pulsesPerUnit,
            periodMs:     overflow ? null : periodMs,
            overflow,
          };

          node.send([null, { payload }]);
          break;
        }

        // ── 0xA9  Sensor raw value (VMB4AN channels 9-12 only) ────────────
        // Confirmed from protocol_vmb4an.pdf, "Transmit the sensor raw
        // value" — a genuinely standalone packet (COMMAND_SENSOR_RAW_DATA),
        // not to be confused with 0xEA "sensor status" (that one carries
        // operating mode / sleep timer / auto-send config, no actual value
        // at all — a real trap if you assume "status" means "reading").
        // body[0]=0xA9, body[1]=channel(9-12), body[2]=operating mode,
        // body[3-5]=24-bit raw value (upper/high/low, MSB first).
        // Deliberately generic per Stuart's own preference — engineering-
        // unit conversion (voltage/current/resistance/period) is left to
        // the flow, not attempted here. The PDF's resolution table (e.g.
        // 0.25mV/count for voltage) is available in this node's help if
        // conversion is ever wanted downstream.
        case 0xA9: {
          if (!isVMB4AN) return;
          if (body.length < 6) return;

          const channel  = body[1];
          const modeCode = body[2] & 0x03;
          const mode     = ['voltage', 'current', 'resistance', 'period'][modeCode];
          const raw      = (body[3] << 16) | (body[4] << 8) | body[5];

          const payload = { type: 'analogue', channel, mode, raw };

          node.send([null, { payload }]);
          break;
        }

        // ── 0xF0/F1/F2  Channel name parts ───────────────────────────────
        case 0xF0:
        case 0xF1:
        case 0xF2: {
          // body[0]=cmd, body[1]=channel bitmask, body[2..]=chars
          const mask = body[1];
          const ch   = decodeNameBitmask(mask);
          if (!ch) break;
          const part = cmd - 0xF0;
          if (!_nameParts[ch]) _nameParts[ch] = {};
          _nameParts[ch][part] = Array.from(body).slice(2);
          if (part === 2) assembleName(ch);
          break;
        }

        default:
          break;
      }
    }

    node.bridge.register(node.address, onPacket);

    // ── Input commands ────────────────────────────────────────────────────

    node.on('input', function(msg) {
      const cmd = msg.payload && msg.payload.cmd;
      if (!cmd) return;

      if (cmd === 'get_status') {
        node.bridge.send(pkt(0xFB, node.address, [0xFA, 0x00]));
        return;
      }

      // Request counter status — DB2=channel bitmask (bits 0-3 = ch 1-4), DB3=interval
      if (cmd === 'get_counter') {
        if (!hasCounter) { node.warn('velbus-sensor: this module has no pulse counter'); return; }
        const chMask = parseInt(msg.payload.channels) || 0x0F; // default all 4
        const interval = parseInt(msg.payload.interval) || 0;
        node.bridge.send(pkt(0xF8, node.address, [0xBD, chMask, interval]));
        return;
      }

      // Reset counter — DB2=channel number (0-3)
      if (cmd === 'reset_counter') {
        if (!hasCounter) { node.warn('velbus-sensor: this module has no pulse counter'); return; }
        const ch = (parseInt(msg.payload.channel) || 1) - 1; // 0-indexed
        node.bridge.send(pkt(0xF8, node.address, [0xAD, ch]));
        return;
      }

      // Request an analogue reading now — VMB4AN channels 9-12 only.
      // DATABYTE3=0 explicitly means "don't change the auto-send interval
      // config" per the protocol PDF — this just asks for a value without
      // side effects on the module's existing auto-send behaviour.
      // Priority: protocol PDF explicitly states "SID10-SID9 = 11 (lowest
      // priority)" for this specific command — 0xFB, not the 0xF8 used by
      // most other commands in this file. Checked directly rather than
      // assumed, since this is the one place it genuinely differs.
      if (cmd === 'get_analogue') {
        if (!isVMB4AN) { node.warn('velbus-sensor: this module has no analogue sensor channels'); return; }
        const ch = parseInt(msg.payload.channel);
        if (!ch || ch < 9 || ch > 12) {
          node.warn('velbus-sensor: get_analogue requires "channel": 9-12');
          return;
        }
        node.bridge.send(pkt(0xFB, node.address, [0xE5, ch, 0x00]));
        return;
      }

      // Load counter — DB2=channel number (0-3), DB3=don't care, DB4-7=32-bit value
      if (cmd === 'load_counter') {
        if (!hasCounter) { node.warn('velbus-sensor: this module has no pulse counter'); return; }
        const ch    = (parseInt(msg.payload.channel) || 1) - 1;
        const value = parseInt(msg.payload.value) || 0;
        const b4 = (value >>> 24) & 0xFF;
        const b5 = (value >>> 16) & 0xFF;
        const b6 = (value >>>  8) & 0xFF;
        const b7 =  value         & 0xFF;
        node.bridge.send(pkt(0xF8, node.address, [0xAD, ch, 0x00, b4, b5, b6, b7]));
        return;
      }

      // Request channel name — DB2=channel bitmask
      if (cmd === 'get_name') {
        const ch = parseInt(msg.payload.channel) || 0;
        const mask = ch >= 1 && ch <= 8 ? (1 << (ch - 1)) : 0xFF;
        node.bridge.send(pkt(0xF8, node.address, [0xEF, mask]));
        return;
      }

      node.warn('velbus-sensor: unknown cmd: ' + cmd);
    });

    // ── Cleanup ───────────────────────────────────────────────────────────

    node.on('close', function() {
      node.bridge.deregister(node.address, onPacket);
    });

    setStatus('ready', 'grey', 'dot');
  }

  RED.nodes.registerType('velbus-sensor', VelbusSensorNode);
};

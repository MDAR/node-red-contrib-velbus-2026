'use strict';

const { pkt, parsePkt } = require('../../lib/velbus-utils');
const { PIR_TYPES, PIR_TYPE_IDS } = require('../../lib/pir-types');

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

// Decode a bitmask byte into named channel states using the type's channel list
function decodeBitmask(byte, channelNames) {
  const result = {};
  for (let i = 0; i < channelNames.length; i++) {
    result[channelNames[i]] = !!(byte & (1 << i));
  }
  return result;
}

// Return array of active channel names from a bitmask byte
function activeChannels(byte, channelNames) {
  const active = [];
  for (let i = 0; i < channelNames.length; i++) {
    if (byte & (1 << i)) active.push(channelNames[i]);
  }
  return active;
}

// Signed 16-bit / 16 → °C at 0.0625° resolution (same as 0xE6 on glass panel)
function tempFrom16(hi, lo) {
  const raw = (hi << 8) | lo;
  const signed = raw > 32767 ? raw - 65536 : raw;
  return signed / 16;
}

// ─────────────────────────────────────────────────────────────────────────────
// Node
// ─────────────────────────────────────────────────────────────────────────────

module.exports = function(RED) {

  function VelbusPirNode(config) {
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
      node.error('velbus-pir: no bridge configured');
      return;
    }
    if (!node.address || node.address < 1 || node.address > 254) {
      node.status({ fill: 'red', shape: 'ring', text: 'invalid address' });
      node.error('velbus-pir: invalid address ' + node.address);
      return;
    }

    const typeDesc = node.typeId !== null ? (PIR_TYPES[node.typeId] || null) : null;
    const hasTempSensor = typeDesc ? typeDesc.hasTempSensor : false;
    const channelNames  = typeDesc ? typeDesc.channels : [
      'dark', 'light', 'motion1', 'ldMotion1', 'motion2', 'ldMotion2', 'absence',
    ];

    const _label = () => {
      const name = node.moduleName ||
        (typeDesc ? typeDesc.name : 'PIR') + ' 0x' +
        node.address.toString(16).padStart(2, '0').toUpperCase();
      return name;
    };

    function setStatus(text, fill, shape) {
      node.status({ fill: fill || 'green', shape: shape || 'dot',
        text: _label() + ' ' + text });
    }

    // ── Packet handler ────────────────────────────────────────────────────

    function onPacket(raw) {
      const p = parsePkt(raw);
      if (!p || p.rtr) return;
      if (p.addr !== node.address) return;

      const { cmd, body } = p;

      switch (cmd) {

        // ── 0x00  Channel status (motion/dark/light/absence/temp alarms) ──
        case 0x00: {
          if (body.length < 4) return;
          // body[0]=cmd, body[1]=pressed, body[2]=released, body[3]=longPressed
          const pressed     = activeChannels(body[1], channelNames);
          const released    = activeChannels(body[2], channelNames);
          const longPressed = activeChannels(body[3], channelNames);
          const on = pressed.length > 0 || longPressed.length > 0;

          const payload = { type: 'channel', on, pressed, released, longPressed };
          setStatus(pressed.length ? pressed.join(',') + ' on' : 'idle');
          node.send([{ payload }, null]);
          break;
        }

        // ── 0xED  Module status ───────────────────────────────────────────
        case 0xED: {
          if (body.length < 8) return;
          // body[0]=cmd, body[1]=channel bitmask, body[2-3]=light hi/lo,
          // body[4]=locked/test, body[5]=prog disabled, body[6]=alarm&program,
          // body[7]=auto-send interval
          const channels    = decodeBitmask(body[1], channelNames);
          const lightRaw    = (body[2] << 8) | body[3];
          const testMode    = !!(body[4] & 0x80);
          const locked      = decodeBitmask(body[4] & 0x7F, channelNames.slice(0, 6));
          const progDisabled = decodeBitmask(body[5], channelNames.slice(0, 6));

          const progByte = body[6];
          const program = ['none', 'summer', 'winter', 'holiday'][progByte & 0x03];
          const alarm1Active = !!(progByte & 0x04);
          const alarm2Active = !!(progByte & 0x10);
          const sunriseEnabled = !!(progByte & 0x40);
          const sunsetEnabled  = !!(progByte & 0x80);

          const autoSendInterval = body[7];

          const on = Object.values(channels).some(v => v);

          const payload = {
            type: 'status',
            on,
            channels,
            lightRaw,
            testMode,
            locked,
            progDisabled,
            program,
            alarms: { alarm1Active, alarm2Active },
            sunrise: sunriseEnabled,
            sunset: sunsetEnabled,
            autoSendInterval,
          };
          node.send([{ payload }, null]);
          break;
        }

        // ── 0xA9  Light raw value ─────────────────────────────────────────
        case 0xA9: {
          if (body.length < 3) return;
          // body[0]=cmd, body[1]=hi, body[2]=lo
          const raw = (body[1] << 8) | body[2];
          const payload = { type: 'light', on: raw > 0, raw };
          node.send([{ payload }, null]);
          break;
        }

        // ── 0xE6  Temperature (hasTempSensor types only) ─────────────────
        case 0xE6: {
          if (!hasTempSensor) return;
          if (body.length < 3) return;
          // body[0]=cmd, body[1-2]=current, body[3-4]=min, body[5-6]=max
          const current = tempFrom16(body[1], body[2]);
          const min = body.length >= 5 ? tempFrom16(body[3], body[4]) : null;
          const max = body.length >= 7 ? tempFrom16(body[5], body[6]) : null;

          const payload = { type: 'temperature', current };
          if (min !== null) payload.min = min;
          if (max !== null) payload.max = max;
          node.send([null, { payload }]);
          break;
        }

        // ── 0xE8  Temperature sensor settings (compact format) ───────────
        case 0xE8: {
          if (!hasTempSensor) return;
          if (body.length < 8) return;
          // body[0]=cmd, body[1]=calOffset, body[2]=calGain,
          // body[3]=lowAlarm, body[4]=highAlarm, body[5]=zone, body[6]=autoSend
          function signed05(b) { return (b > 127 ? b - 256 : b) * 0.5; }
          const payload = {
            type:        'temp_settings',
            calOffset:   signed05(body[1]),
            calGain:     body[2],
            lowAlarm:    signed05(body[3]),
            highAlarm:   signed05(body[4]),
            zone:        body[5],
            autoSend:    body[6],
          };
          node.send([null, { payload }]);
          break;
        }

        // ── 0xF0/F1/F2  Sensor name parts ────────────────────────────────
        case 0xF0:
        case 0xF1:
        case 0xF2: {
          if (!hasTempSensor) return;
          // body[0]=cmd, body[1]=sensor bit number, body[2..]=chars
          const part = cmd - 0xF0;
          let text = '';
          for (let i = 2; i < body.length; i++) {
            if (body[i] === 0 || body[i] === 0xFF) break;
            text += String.fromCharCode(body[i]);
          }
          const payload = { type: 'name_part', part, text };
          node.send([null, { payload }]);
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

      // Request module status
      if (cmd === 'get_status') {
        node.bridge.send(pkt(0xFB, node.address, [0xFA, 0x00]));
        return;
      }

      // Request light value (0xAA), optional auto-send interval
      if (cmd === 'get_light') {
        const interval = parseInt(msg.payload.interval) || 0;
        node.bridge.send(pkt(0xF8, node.address, [0xAA, interval]));
        return;
      }

      // Request temperature (hasTempSensor only)
      if (cmd === 'get_temp') {
        if (!hasTempSensor) { node.warn('velbus-pir: this module has no temperature sensor'); return; }
        const interval = parseInt(msg.payload.interval) || 0;
        node.bridge.send(pkt(0xF8, node.address, [0xE5, interval]));
        return;
      }

      // Request temperature settings
      if (cmd === 'get_temp_settings') {
        if (!hasTempSensor) { node.warn('velbus-pir: this module has no temperature sensor'); return; }
        node.bridge.send(pkt(0xF8, node.address, [0xE7, 0x00]));
        return;
      }

      // Test mode on/off
      if (cmd === 'test_on')  { node.bridge.send(pkt(0xF8, node.address, [0xB5, 0x01])); return; }
      if (cmd === 'test_off') { node.bridge.send(pkt(0xF8, node.address, [0xB5, 0x00])); return; }

      node.warn('velbus-pir: unknown cmd: ' + cmd);
    });

    // ── Cleanup ───────────────────────────────────────────────────────────

    node.on('close', function() {
      node.bridge.deregister(node.address, onPacket);
    });

    setStatus('ready', 'grey', 'dot');
  }

  RED.nodes.registerType('velbus-pir', VelbusPirNode);
};

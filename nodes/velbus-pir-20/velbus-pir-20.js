'use strict';

const { pkt, rtrPkt, parsePkt } = require('../../lib/velbus-utils');
const { PIR_TYPES_20, PIR_TYPE_IDS_20 } = require('../../lib/pir-types-20');

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function activeFromBitmask(byte, names) {
  const active = [];
  for (let i = 0; i < names.length; i++) {
    if (byte & (1 << i)) active.push(names[i]);
  }
  return active;
}

function decodeFromBitmask(byte, names) {
  const result = {};
  for (let i = 0; i < names.length; i++) {
    result[names[i]] = !!(byte & (1 << i));
  }
  return result;
}

function tempFrom16(hi, lo) {
  const raw = (hi << 8) | lo;
  const signed = raw > 32767 ? raw - 65536 : raw;
  return signed / 16;
}

function signed05(b) {
  return (b > 127 ? b - 256 : b) * 0.5;
}

// ─────────────────────────────────────────────────────────────────────────────
// Node
// ─────────────────────────────────────────────────────────────────────────────

module.exports = function(RED) {

  function VelbusPir20Node(config) {
    RED.nodes.createNode(this, config);
    const node = this;

    node.bridge     = RED.nodes.getNode(config.bridge);
    node.address    = typeof config.address === 'number'
      ? config.address  // legacy saves stored decimal numbers
      : (parseInt(config.address, 16) || 0);  // editor stores hex strings
    node.moduleName = config.moduleName || '';
    node.typeId     = config.typeId ? parseInt(config.typeId) : null;

    if (!node.bridge) {
      node.status({ fill: 'red', shape: 'ring', text: 'no bridge' });
      node.error('velbus-pir-20: no bridge configured');
      return;
    }
    if (!node.address || node.address < 1 || node.address > 254) {
      node.status({ fill: 'red', shape: 'ring', text: 'invalid address' });
      node.error('velbus-pir-20: invalid address ' + node.address);
      return;
    }

    const typeDesc      = node.typeId !== null ? (PIR_TYPES_20[node.typeId] || null) : null;
    const hasTempSensor = typeDesc ? typeDesc.hasTempSensor : false;
    const bitmask       = typeDesc ? typeDesc.bitmask : [
      'dark', 'light', 'motion1', 'ldMotion1', 'motion2', 'ldMotion2', 'absence',
    ];
    // Lockable channel numbers (temp alarm bits are not lockable on VMBPIRO-20)
    const lockableChannels = typeDesc ? Object.keys(typeDesc.channels).map(Number) : [1,2,3,4,5,6,7];

    // Name retrieval state
    let _nameParts = {};
    let _nameTimer = null;

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

    const _addrHex = '0x' + node.address.toString(16).padStart(2, '0').toUpperCase();

    function setStatus(text, fill, shape) {
      const label = node.moduleName ? node.moduleName + ' (' + _addrHex + ')' : _addrHex;
      node.status({ fill: fill || 'green', shape: shape || 'dot', text: label + ' ' + text });
    }

    // ── Firmware check on 0xFF ────────────────────────────────────────────

    function handleModuleType(body) {
      if (body.length < 8) return; // V2 always 8 bytes
      const typeId  = body[1];
      const mapVer  = body[4];
      const buildHi = body[5];
      const buildLo = body[6];
      const build   = buildHi * 100 + buildLo;
      const canFD   = !!(body[7] & 0x20);

      const desc = PIR_TYPES_20[typeId];
      if (!desc) {
        node.status({ fill: 'red', shape: 'ring', text: 'unknown type 0x' + typeId.toString(16) });
        node.error('velbus-pir-20: unrecognised module type 0x' + typeId.toString(16));
        return;
      }

      if (desc.minMapVer !== null && mapVer < desc.minMapVer) {
        node.status({ fill: 'red', shape: 'ring',
          text: desc.name + ' map v' + mapVer + ' < min v' + desc.minMapVer });
        node.error('velbus-pir-20: firmware map version ' + mapVer + ' below minimum');
        return;
      }

      node.moduleName = node.moduleName || desc.name;
      setStatus('build ' + build + (canFD ? ' CAN FD' : ''), 'grey', 'dot');

      // Request name
      setTimeout(() => {
        node.bridge.send(pkt(0xF8, node.address, [0xEF, 0xFF]));
        _nameTimer = setTimeout(assembleName, 2000);
      }, 100);
    }

    // ── Packet handler ────────────────────────────────────────────────────

    function onPacket(raw) {
      const p = parsePkt(raw);
      if (!p) return;
      // Note: no address re-check here. The bridge routes frames to this
      // listener, including subaddress frames mapped to the primary address
      // (e.g. GPO-20 thermostat status from subaddress 0x34).

      const { cmd, body, rtr: isRtr } = p;

      if (isRtr) return;

      switch (cmd) {

        // ── 0xFF  Module type ─────────────────────────────────────────────
        case 0xFF: {
          handleModuleType(body);
          break;
        }

        // ── 0x00  Channel status ──────────────────────────────────────────
        case 0x00: {
          if (body.length < 4) return;
          // body[0]=cmd, body[1]=pressed, body[2]=released, body[3]=long
          const pressed     = activeFromBitmask(body[1], bitmask);
          const released    = activeFromBitmask(body[2], bitmask);
          const longPressed = activeFromBitmask(body[3], bitmask);
          const on = pressed.length > 0 || longPressed.length > 0;

          const payload = { type: 'channel', on, pressed, released, longPressed };

          if (pressed.length) {
            setStatus(pressed.join(',') + ' on');
          } else if (released.length) {
            setStatus(released.join(',') + ' off');
          }

          node.send([{ payload }, null]);
          break;
        }

        // ── 0xED  Module status ───────────────────────────────────────────
        case 0xED: {
          if (body.length < 8) return;
          // body[0]=cmd, body[1]=channel bitmask, body[2-3]=light hi/lo
          // body[4]=locked/test, body[5]=prog disabled, body[6]=alarm&program
          // body[7]=auto-send interval
          const channels   = decodeFromBitmask(body[1], bitmask);
          const lightRaw   = (body[2] << 8) | body[3];
          const testMode   = !!(body[4] & 0x80);

          // Locked status only covers lockable channels (bits 0-5 on VMBPIRO-20)
          const lockedBitmask = body[4] & 0x3F;
          const locked = decodeFromBitmask(lockedBitmask, bitmask.slice(0, 6));

          const progBitmask = body[5] & 0x3F;
          const progDisabled = decodeFromBitmask(progBitmask, bitmask.slice(0, 6));

          const progByte = body[6];
          const program = ['none', 'summer', 'winter', 'holiday'][progByte & 0x03];
          const alarm1Active  = !!(progByte & 0x04);
          const alarm2Active  = !!(progByte & 0x10);
          const sunriseEnabled = !!(progByte & 0x40);
          const sunsetEnabled  = !!(progByte & 0x80);

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
            autoSendInterval: body[7],
          };
          node.send([{ payload }, null]);
          break;
        }

        // ── 0xA9  Light raw value ─────────────────────────────────────────
        case 0xA9: {
          if (body.length < 3) return;
          const raw = (body[1] << 8) | body[2];
          const payload = { type: 'light', on: raw > 0, raw };
          node.send([{ payload }, null]);
          break;
        }

        // ── 0xE6  Temperature ─────────────────────────────────────────────
        case 0xE6: {
          if (!hasTempSensor) return;
          if (body.length < 3) return;
          const current = tempFrom16(body[1], body[2]);
          const min = body.length >= 5 ? tempFrom16(body[3], body[4]) : null;
          const max = body.length >= 7 ? tempFrom16(body[5], body[6]) : null;

          const payload = { type: 'temperature', current };
          if (min !== null) payload.min = min;
          if (max !== null) payload.max = max;
          node.send([null, { payload }]);
          break;
        }

        // ── 0xE8  Temperature settings ────────────────────────────────────
        // VMBPIRO-20 uses multi-part glass-panel-style format but only
        // calibration and alarm fields are meaningful. Parse part 1 only.
        case 0xE8: {
          if (!hasTempSensor) return;
          if (body.length < 8) return;
          // body[0]=cmd, body[1]=current set, body[2]=comfort heat,
          // body[3]=day heat, body[4]=night heat, body[5]=safe heat,
          // body[6]=boost diff, body[7]=hysteresis
          // For VMBPIRO-20 only body[5] (safe=lowAlarm) and body[2] (comfort=highAlarm)
          // are actually meaningful as alarm thresholds — but we emit all received fields
          // and let the user decide. The calibration is in 0xC6.
          const payload = {
            type:    'temp_settings',
            current: signed05(body[1]),
            comfort: signed05(body[2]),
            day:     signed05(body[3]),
            night:   signed05(body[4]),
            safe:    signed05(body[5]),
          };
          node.send([null, { payload }]);
          break;
        }

        // ── 0xF0/F1/F2  Sensor name ───────────────────────────────────────
        case 0xF0:
        case 0xF1:
        case 0xF2: {
          if (!hasTempSensor) return;
          // body[0]=cmd, body[1]=sensor bit number, body[2..]=chars
          const part = cmd - 0xF0;
          _nameParts[part] = Array.from(body).slice(2);
          let text = '';
          for (let i = 2; i < body.length; i++) {
            if (body[i] === 0 || body[i] === 0xFF) break;
            text += String.fromCharCode(body[i]);
          }
          if (part === 2) assembleName();
          node.send([null, { payload: { type: 'name_part', part, text } }]);
          break;
        }

        default:
          break;
      }
    }

    node.bridge.register(node.address, onPacket);

    // Startup RTR — triggers 0xFF response which drives firmware check and name retrieval
    setTimeout(function() {
      node.bridge.send(rtrPkt(node.address), true);
    }, 500);

    // ── Input commands ────────────────────────────────────────────────────

    node.on('input', function(msg) {
      const cmd = msg.payload && msg.payload.cmd;
      if (!cmd) return;

      if (cmd === 'get_status') {
        node.bridge.send(pkt(0xFB, node.address, [0xFA, 0x00]));
        return;
      }
      if (cmd === 'get_light') {
        const interval = parseInt(msg.payload.interval) || 0;
        node.bridge.send(pkt(0xF8, node.address, [0xAA, interval]));
        return;
      }
      if (cmd === 'get_temp') {
        if (!hasTempSensor) { node.warn('velbus-pir-20: this module has no temperature sensor'); return; }
        const interval = parseInt(msg.payload.interval) || 0;
        node.bridge.send(pkt(0xF8, node.address, [0xE5, interval]));
        return;
      }
      if (cmd === 'get_temp_settings') {
        if (!hasTempSensor) { node.warn('velbus-pir-20: this module has no temperature sensor'); return; }
        node.bridge.send(pkt(0xF8, node.address, [0xE7, 0x00]));
        return;
      }
      if (cmd === 'test_on')  { node.bridge.send(pkt(0xF8, node.address, [0xB5, 0x01])); return; }
      if (cmd === 'test_off') { node.bridge.send(pkt(0xF8, node.address, [0xB5, 0x00])); return; }

      // Lock / unlock by channel number
      if (cmd === 'lock') {
        const ch = parseInt(msg.payload.channel) || 0xFF;
        const duration = parseInt(msg.payload.duration) || 0xFFFFFF;
        const hi = (duration >> 16) & 0xFF;
        const mid = (duration >> 8) & 0xFF;
        const lo = duration & 0xFF;
        node.bridge.send(pkt(0xF8, node.address, [0x12, ch, hi, mid, lo]));
        return;
      }
      if (cmd === 'unlock') {
        const ch = parseInt(msg.payload.channel) || 0xFF;
        node.bridge.send(pkt(0xF8, node.address, [0x13, ch]));
        return;
      }

      node.warn('velbus-pir-20: unknown cmd: ' + cmd);
    });

    // ── Cleanup ───────────────────────────────────────────────────────────

    node.on('close', function() {
      if (_nameTimer) { clearTimeout(_nameTimer); _nameTimer = null; }
      node.bridge.deregister(node.address, onPacket);
    });

    setStatus('ready', 'grey', 'dot');
  }

  RED.nodes.registerType('velbus-pir-20', VelbusPir20Node);
};

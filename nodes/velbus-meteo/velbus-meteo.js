'use strict';

const { pkt, rtrPkt, parsePkt } = require('../../lib/velbus-utils');

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function activeFromBitmask(byte, count) {
  const active = [];
  for (let i = 0; i < count; i++) {
    if (byte & (1 << i)) active.push('alarm' + (i + 1));
  }
  return active;
}

function decodeBitmask(byte, count) {
  const result = {};
  for (let i = 0; i < count; i++) {
    result['alarm' + (i + 1)] = !!(byte & (1 << i));
  }
  return result;
}

function tempFrom16(hi, lo) {
  const raw = (hi << 8) | lo;
  return (raw > 32767 ? raw - 65536 : raw) / 512;  // °C × 512, 0.0625° res
}

// ─────────────────────────────────────────────────────────────────────────────
// Node
// ─────────────────────────────────────────────────────────────────────────────

module.exports = function(RED) {

  function VelbusMeteoNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;

    node.bridge  = RED.nodes.getNode(config.bridge);
    node.address = typeof config.address === 'number'
      ? config.address  // legacy saves stored decimal numbers
      : (parseInt(config.address, 16) || 0);  // editor stores hex strings

    if (!node.bridge) {
      node.status({ fill: 'red', shape: 'ring', text: 'no bridge' });
      node.error('velbus-meteo: no bridge configured');
      return;
    }
    if (!node.address || node.address < 1 || node.address > 254) {
      node.status({ fill: 'red', shape: 'ring', text: 'invalid address' });
      node.error('velbus-meteo: invalid address ' + node.address);
      return;
    }

    const _addrHex = '0x' + node.address.toString(16).padStart(2, '0').toUpperCase();

    function setStatus(text, fill, shape) {
      node.status({ fill: fill || 'green', shape: shape || 'dot',
        text: _addrHex + ' ' + text });
    }

    // Alarm channel names — keyed by bitmask position (0-7)
    const _alarmNames = {};
    const _nameParts  = {};  // keyed by alarmBit then part (0/1/2)

    function assembleNames() {
      for (let bit = 0; bit < 8; bit++) {
        const mask = 1 << bit;
        const parts = _nameParts[mask];
        if (!parts) continue;
        const bytes = [
          ...(parts[0] || []),
          ...(parts[1] || []),
          ...(parts[2] || []),
        ].filter(b => b !== 0 && b !== 0xFF);
        const name = String.fromCharCode(...bytes).trim();
        if (name) _alarmNames[bit] = name;
      }
    }

    // ── Packet handler ────────────────────────────────────────────────────

    function onPacket(raw) {
      const p = parsePkt(raw);
      if (!p || p.rtr) return;
      if (p.addr !== node.address) return;

      const { cmd, body } = p;

      switch (cmd) {

        // ── 0x00  Alarm output events ─────────────────────────────────────
        case 0x00: {
          if (body.length < 4) return;
          // body[0]=cmd, body[1]=pressed, body[2]=released, body[3]=longPressed
          const pressed     = activeFromBitmask(body[1], 8);
          const released    = activeFromBitmask(body[2], 8);
          const longPressed = activeFromBitmask(body[3], 8);
          const on = pressed.length > 0 || longPressed.length > 0;

          const payload = { type: 'alarm', on, pressed, released, longPressed };
          if (pressed.length) setStatus('alarm: ' + pressed.join(','));
          node.send([{ payload }, null]);
          break;
        }

        // ── 0xED  Module status ───────────────────────────────────────────
        case 0xED: {
          if (body.length < 7) return;
          // body[0]=0xED, body[1]=alarm bitmask, body[2]=locked, body[3]=prog-disabled
          // body[4]=clock alarm & program, body[5]=auto-send interval, body[6]=test mode
          const alarms      = decodeBitmask(body[1], 8);
          const locked      = decodeBitmask(body[2], 8);
          const progDisabled = decodeBitmask(body[3], 8);

          const progByte = body[4];
          const program = ['none', 'group1', 'group2', 'group3'][progByte & 0x03];
          const alarm1Active   = !!(progByte & 0x04);
          const alarm2Active   = !!(progByte & 0x10);
          const sunriseEnabled = !!(progByte & 0x40);
          const sunsetEnabled  = !!(progByte & 0x80);

          const autoSendInterval = body[5];
          const testMode         = !!(body[6] & 0x80);

          const on = Object.values(alarms).some(v => v);
          const payload = {
            type: 'status',
            on,
            alarms,
            locked,
            progDisabled,
            program,
            clockAlarms: { alarm1Active, alarm2Active },
            sunrise: sunriseEnabled,
            sunset:  sunsetEnabled,
            autoSendInterval,
            testMode,
          };
          node.send([{ payload }, null]);
          break;
        }

        // ── 0xE6  Temperature ─────────────────────────────────────────────
        case 0xE6: {
          if (body.length < 3) return;
          // body[0]=0xE6, body[1-2]=current, body[3-4]=min, body[5-6]=max
          const current = tempFrom16(body[1], body[2]);
          const min = body.length >= 5 ? tempFrom16(body[3], body[4]) : null;
          const max = body.length >= 7 ? tempFrom16(body[5], body[6]) : null;

          const payload = { type: 'temperature', current };
          if (min !== null) payload.min = min;
          if (max !== null) payload.max = max;
          node.send([null, { payload }]);
          break;
        }

        // ── 0xA9  Rain / light / wind raw values ─────────────────────────
        case 0xA9: {
          if (body.length < 7) return;
          // body[0]=0xA9, body[1-2]=rain, body[3-4]=light, body[5-6]=wind
          const rainRaw  = (body[1] << 8) | body[2];
          const lightRaw = (body[3] << 8) | body[4];
          const windRaw  = (body[5] << 8) | body[6];

          const payload = {
            type:  'meteo',
            rain:  rainRaw  / 10,   // mm/h
            light: lightRaw,        // lux
            wind:  windRaw  / 10,   // km/h
            raw: { rain: rainRaw, light: lightRaw, wind: windRaw },
          };
          setStatus('wind:' + payload.wind.toFixed(1) + ' rain:' + payload.rain.toFixed(1));
          node.send([null, { payload }]);
          break;
        }

        // ── 0xAC  Sensor text string ──────────────────────────────────────
        case 0xAC: {
          if (body.length < 4) return;
          // body[0]=0xAC, body[1]=sensor bitmask, body[2]=start position, body[3..]=chars
          const sensorByte = body[1];
          const sensor = sensorByte === 0x02 ? 'rain'
                       : sensorByte === 0x04 ? 'light'
                       : sensorByte === 0x08 ? 'wind'
                       : 'unknown';
          const startPos = body[2];
          let text = '';
          for (let i = 3; i < body.length; i++) {
            if (body[i] === 0) break;
            text += String.fromCharCode(body[i]);
          }
          const payload = { type: 'meteo_text', sensor, startPos, text };
          node.send([null, { payload }]);
          break;
        }

        // ── 0xF0/F1/F2  Alarm channel name parts ─────────────────────────
        case 0xF0:
        case 0xF1:
        case 0xF2: {
          // body[0]=cmd, body[1]=channel bitmask, body[2..]=chars
          const mask = body[1];
          const part = cmd - 0xF0;
          if (!_nameParts[mask]) _nameParts[mask] = {};
          _nameParts[mask][part] = Array.from(body).slice(2);
          if (part === 2) assembleNames();
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

      // Request temperature — DB2=0x00 means temp, interval in seconds
      if (cmd === 'get_temp') {
        const interval = parseInt(msg.payload.interval) || 0;
        node.bridge.send(pkt(0xF8, node.address, [0xE5, 0x00, interval]));
        return;
      }

      // Request sensor (rain/light/wind) — DB2=sensor bitmask, DB3=interval
      if (cmd === 'get_meteo') {
        const sensorMap = { rain: 0x02, light: 0x04, wind: 0x08 };
        const sensor = msg.payload.sensor || 'all';
        let mask = 0;
        if (sensor === 'all') {
          mask = 0x02 | 0x04 | 0x08;
        } else if (typeof sensor === 'string' && sensorMap[sensor]) {
          mask = sensorMap[sensor];
        } else {
          mask = 0x0E; // all three
        }
        const interval = parseInt(msg.payload.interval) || 0;
        node.bridge.send(pkt(0xF8, node.address, [0xE5, mask, interval]));
        return;
      }

      // Request alarm channel name — DB2=channel bitmask
      if (cmd === 'get_alarm_name') {
        const ch = parseInt(msg.payload.channel) || 0;
        const mask = ch >= 1 && ch <= 8 ? (1 << (ch - 1)) : 0xFF;
        node.bridge.send(pkt(0xF8, node.address, [0xEF, mask]));
        return;
      }

      if (cmd === 'test_on')  { node.bridge.send(pkt(0xF8, node.address, [0xB5, 0x01])); return; }
      if (cmd === 'test_off') { node.bridge.send(pkt(0xF8, node.address, [0xB5, 0x00])); return; }

      node.warn('velbus-meteo: unknown cmd: ' + cmd);
    });

    // ── Cleanup ───────────────────────────────────────────────────────────

    node.on('close', function() {
      node.bridge.deregister(node.address, onPacket);
    });

    setStatus('ready', 'grey', 'dot');
  }

  RED.nodes.registerType('velbus-meteo', VelbusMeteoNode);
};

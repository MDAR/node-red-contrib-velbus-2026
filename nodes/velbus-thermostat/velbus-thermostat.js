'use strict';

const { pkt, parsePkt } = require('../../lib/velbus-utils');

// ─────────────────────────────────────────────────────────────────────────────
// Thermostat mode constants
// ─────────────────────────────────────────────────────────────────────────────
const MODE_CMD = {
  comfort: 0xDB,
  day:     0xDC,
  night:   0xDD,
  safe:    0xDE,
};

const MODE_LABEL = {
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
// Node
// ─────────────────────────────────────────────────────────────────────────────
module.exports = function(RED) {

  function VelbusThermostatNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;

    node.bridge     = RED.nodes.getNode(config.bridge);
    node.address    = typeof config.address === 'number'
      ? config.address  // legacy saves stored decimal numbers
      : (parseInt(config.address, 16) || 0);  // editor stores hex strings
    node.moduleName = config.moduleName || '';

    if (!node.bridge) {
      node.status({ fill: 'red', shape: 'ring', text: 'no bridge' });
      node.error('velbus-thermostat: no bridge configured');
      return;
    }
    if (!node.address || node.address < 1 || node.address > 254) {
      node.status({ fill: 'red', shape: 'ring', text: 'invalid address' });
      node.error('velbus-thermostat: invalid address ' + node.address);
      return;
    }

    const _label = node.moduleName
      ? node.moduleName + ' (0x' + node.address.toString(16).padStart(2, '0').toUpperCase() + ')'
      : '0x' + node.address.toString(16).padStart(2, '0').toUpperCase();

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

    function setStatus(text, fill, shape) {
      node.status({ fill: fill || 'green', shape: shape || 'dot', text: _label + ' ' + text });
    }

    // ── Packet handler ───────────────────────────────────────────────────

    function onPacket(raw) {
      const p = parsePkt(raw);
      if (!p || p.rtr) return;
      // Note: no address re-check here. The bridge routes frames to this
      // listener, including subaddress frames mapped to the primary address
      // (e.g. GPO-20 thermostat status from subaddress 0x34).

      const { cmd, body } = p;

      switch (cmd) {

        // ── 0xEA  Thermostat status ────────────────────────────────────────
        case 0xEA: {
          if (body.length < 8) return;
          // body[0]=0xEA cmd
          // body[1]=DB2 operating mode
          // body[2]=DB3 program step mode
          // body[3]=DB4 output status (heater/cooler/pump/alarms)
          // body[4]=DB5 current temp (signed byte, resolution 0.5°)
          // body[5]=DB6 current target temp set (signed byte, resolution 0.5°)
          // body[6]=DB7 sleep timer high byte
          // body[7]=DB8 sleep timer low byte

          const opMode   = body[1];
          const modeBits = (opMode >> 4) & 0x07;
          const mode = modeBits === 4 ? 'comfort'
                     : modeBits === 2 ? 'day'
                     : modeBits === 1 ? 'night'
                     : 'safe';
          const heaterMode   = !(opMode & 0x80);           // bit7: 0=heater, 1=cooler
          // Bits 2-1: control state per GPO-20 protocol ed.3
          const ctlBits = (opMode >> 1) & 0x03;
          const controlState = ctlBits === 0 ? 'run'
                             : ctlBits === 1 ? 'manual'
                             : ctlBits === 2 ? 'sleep_timer'
                             : 'forced_safe_locked';
          const thermostatOn = ctlBits !== 3;              // legacy convenience flag

          const outByte  = body[3];
          // Full DATABYTE4 output status per VMBGPO-20 protocol ed.3:
          const heating    = !!(outByte & 0x01);
          const boostMode  = !!(outByte & 0x02);
          const pump       = !!(outByte & 0x04);
          const cooling    = !!(outByte & 0x08);
          const tempAlarm1 = !!(outByte & 0x10);
          const tempAlarm2 = !!(outByte & 0x20);
          const tempAlarm3 = !!(outByte & 0x40);
          const tempAlarm4 = !!(outByte & 0x80);

          const rawCurrent = body[4] > 127 ? body[4] - 256 : body[4];
          const rawTarget  = body[5] > 127 ? body[5] - 256 : body[5];

          const payload = {
            type: 'thermostat',
            sourceAddr: '0x' + p.addr.toString(16).padStart(2, '0').toUpperCase(),
            raw: [...raw].map(b => b.toString(16).padStart(2, '0').toUpperCase()).join(' '),
            currentTemp: rawCurrent * 0.5,
            targetTemp:  rawTarget  * 0.5,
            mode,
            heaterMode,
            heating,
            cooling,
            boostMode,
            pump,
            tempAlarm1,
            tempAlarm2,
            tempAlarm3,
            tempAlarm4,
            controlState,
            thermostatOn,
          };

          setStatus(
            (thermostatOn ? 'on' : 'off') + ' · ' +
            mode + ' · ' +
            (rawCurrent * 0.5).toFixed(1) + '°C → ' + (rawTarget * 0.5).toFixed(1) + '°C'
          );
          node.send([{ payload }, null]);
          break;
        }

        // ── 0xE6  Current temperature ─────────────────────────────────────
        case 0xE6: {
          if (body.length < 3) return;
          // body[0]=0xE6 cmd, body[1-2]=DB2-3 current (16-bit, /16 = °C at 0.0625° res)
          // body[3-4]=DB4-5 min, body[5-6]=DB6-7 max (optional)
          // 16-bit signed, °C × 512 (0.0625° resolution, low 5 bits unused)
          const t16 = (hi, lo) => { const r = (hi << 8) | lo; return (r > 32767 ? r - 65536 : r) / 512; };
          const current = t16(body[1], body[2]);
          const min = body.length >= 5 ? t16(body[3], body[4]) : null;
          const max = body.length >= 7 ? t16(body[5], body[6]) : null;

          const payload = { type: 'temperature', current };
          if (min !== null) payload.min = min;
          if (max !== null) payload.max = max;

          node.send([null, { payload }]);
          break;
        }

        // ── 0xE8  Temperature settings part 1 (heating presets) ──────────
        case 0xE8: {
          if (body.length < 9) return;
          // body[0]=0xE8 cmd, body[1]=DB2 current set, body[2]=DB3 comfort heat,
          // body[3]=DB4 day heat, body[4]=DB5 night heat, body[5]=DB6 safe heat,
          // body[6]=DB7 boost diff, body[7]=DB8 hysteresis
          // All signed bytes, resolution 0.5°
          function signed05(b) { return (b > 127 ? b - 256 : b) * 0.5; }
          const payload = {
            type:    'temp_settings',
            current: signed05(body[1]),
            comfort: signed05(body[2]),
            day:     signed05(body[3]),
            night:   signed05(body[4]),
            safe:    signed05(body[5]),
          };
          node.send([{ payload }, null]);
          break;
        }

        // ── 0xED  Module status (thermostat programme field) ──────────────
        case 0xED: {
          if (body.length < 7) return;
          // body[0]=0xED cmd, body[6]=DB7 alarm & program selection
          const progByte = body[6];
          const thermostatProgram = THERM_STATUS_LABEL[progByte & 0x03] || 'unknown';
          const alarm1Active = !!(progByte & 0x04);
          const alarm2Active = !!(progByte & 0x08);

          const payload = {
            type: 'programme',
            thermostatProgram,
            alarms: { alarm1Active, alarm2Active },
          };
          node.send([{ payload }, null]);
          break;
        }

        // ── 0xF0/F1/F2  Name part response ─────────────────────────────────
        case 0xF0:
        case 0xF1:
        case 0xF2: {
          // body[0]=cmd, body[1]=DB2 channel number, body[2..]=DB3.. chars
          const part = cmd - 0xF0;
          _nameParts[part] = Array.from(body).slice(2);
          if (part === 2) assembleName();
          break;
        }

        default: {
          // Unhandled command — emit raw on output 2 so subaddress channel
          // events (0x00 push-button status from the sensor sub carrying
          // heater/boost/pump/cooler/alarm states) are visible for analysis.
          const payload = {
            type: 'raw',
            sourceAddr: '0x' + p.addr.toString(16).padStart(2, '0').toUpperCase(),
            cmd: '0x' + cmd.toString(16).padStart(2, '0').toUpperCase(),
            raw: [...raw].map(b => b.toString(16).padStart(2, '0').toUpperCase()).join(' '),
          };
          node.send([null, { payload }]);
          break;
        }
      }
    }

    node.bridge.register(node.address, onPacket);

    // Auto-retrieve module name on startup
    setTimeout(function() {
      node.bridge.send(pkt(0xF8, node.address, [0xEF]));
      _nameTimer = setTimeout(assembleName, 2000);
    }, 500);

    // ── Input command handler ────────────────────────────────────────────

    node.on('input', function(msg) {
      const cmd = msg.payload && msg.payload.cmd;
      if (!cmd) return;

      // ── Mode switch ────────────────────────────────────────────────────
      if (MODE_CMD[cmd] !== undefined) {
        const sleep   = (msg.payload.sleepTime !== undefined)
          ? parseInt(msg.payload.sleepTime) : 0;
        const sleepHi = (sleep >> 8) & 0xFF;
        const sleepLo = sleep & 0xFF;
        node.bridge.send(pkt(0xF8, node.address, [MODE_CMD[cmd], sleepHi, sleepLo]));
        return;
      }

      // ── Set target temperature ─────────────────────────────────────────
      if (cmd === 'set_temp') {
        const pointer = (msg.payload.pointer !== undefined)
          ? parseInt(msg.payload.pointer) : 0;
        const tempRaw = Math.round((parseFloat(msg.payload.temp) || 0) * 100);
        const tempHi  = (tempRaw >> 8) & 0xFF;
        const tempLo  = tempRaw & 0xFF;
        node.bridge.send(pkt(0xF8, node.address, [0xE4, pointer, tempHi, tempLo]));
        return;
      }

      // ── Request thermostat status ──────────────────────────────────────
      if (cmd === 'get_thermostat') {
        node.bridge.send(pkt(0xF8, node.address, [0xE7]));
        return;
      }

      // ── Request temperature preset settings ────────────────────────────
      if (cmd === 'get_settings') {
        node.bridge.send(pkt(0xF8, node.address, [0xE5]));
        return;
      }

      // ── Request module status (thermostat programme field) ─────────────
      if (cmd === 'get_status') {
        node.bridge.send(pkt(0xFB, node.address, [0xFA]));
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

      node.warn('velbus-thermostat: unknown cmd: ' + cmd);
    });

    // ── Cleanup ──────────────────────────────────────────────────────────

    node.on('close', function() {
      if (_nameTimer) { clearTimeout(_nameTimer); _nameTimer = null; }
      node.bridge.deregister(node.address, onPacket);
    });

    setStatus('ready', 'grey', 'dot');
  }

  RED.nodes.registerType('velbus-thermostat', VelbusThermostatNode);
};

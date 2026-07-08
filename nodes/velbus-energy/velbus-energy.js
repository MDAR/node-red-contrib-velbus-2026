'use strict';

const { pkt, rtrPkt, parsePkt } = require('../../lib/velbus-utils');
const { ENERGY_TYPES_20, ENERGY_TYPE_IDS_20 } = require('../../lib/energy-types-20');

// ─────────────────────────────────────────────────────────────────────────────
// velbus-energy — VMBPSUMNGR-20 (power supply manager), type 0x04
//
// Source: protocol_vmbpsumngr_20.pdf (ed.1, 14/03/2025). This PDF is largely
// the same shared V2 "system" command block already implemented in
// velbus-clock (real-time clock, date, DST, sunrise/sunset, clock alarm) —
// none of that is reimplemented here; velbus-clock remains the single owner
// of broadcasting those. Only the genuinely energy/PSU-specific packets are
// handled below.
//
// Known PDF documentation issues, both worth remembering if re-checking
// against the source document directly:
//   - The document header reads "VMB8IN-20 PROTOCOL" throughout — an
//     un-retitled template artifact from a different module's document, not
//     a sign this file targets the wrong module.
//   - The 0xA3 (PSU values status) section labels three different byte
//     positions all as "DATABYTE6" (voltage high, amperage high, amperage
//     low) — internally inconsistent with its own stated 8-byte length.
//     Reconstructed below from the byte count and field descriptions as
//     DATABYTE5/6 = voltage hi/lo, DATABYTE7/8 = amperage hi/lo.
//   - 0xA0 (Warranty Counter Request)'s internal constant name is given as
//     "COMMAND_POWER_UP" — clearly a copy-paste artifact from the 0xAB
//     section just above it, not a sign this is actually the power-up
//     command. Treated here as a simple no-parameter trigger, per its
//     stated 1-byte length.
//
// NOT YET VERIFIED AGAINST REAL HARDWARE — this node has not been sent to a
// real VMBPSUMNGR-20. See the mock-harness verification note in this
// project's HANDOVER.md, section 11, for the testing method used instead.
// ─────────────────────────────────────────────────────────────────────────────

module.exports = function(RED) {

  function VelbusEnergyNode(config) {
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
      node.error('velbus-energy: no bridge configured');
      return;
    }
    if (!node.address || node.address < 1 || node.address > 254) {
      node.status({ fill: 'red', shape: 'ring', text: 'invalid address' });
      node.error('velbus-energy: invalid address ' + node.address);
      return;
    }

    // Running alarm state — 0x00 arrives as two separate partial bitmasks
    // (see the case 0x00 handler below), and 0xED conveniently repeats both
    // in one packet. Kept as node state so a partial 0x00 update doesn't
    // discard the other half of the picture.
    let _alarmState = {
      psu1Offline: false, psu2Offline: false, warrantyExpired: false,
      psu1Alarm1: false, psu2Alarm1: false, psuOutAlarm1: false,
      psu1Alarm2: false, psu1Alarm3: false, psu1Alarm4: false,
      psu2Alarm2: false, psu2Alarm3: false, psu2Alarm4: false,
      psuOutAlarm2: false,
    };

    function anyAlarmActive() {
      return Object.values(_alarmState).some(v => v);
    }

    // Name retrieval state — channel-keyed per the protocol (channels 1-10
    // declared, though only 1-3 are meaningful here: PSU1/PSU2/PSUOut).
    // Channel 1's name is used as the module's own display name, matching
    // the convention in velbus-sensor-20.
    let _nameParts = {};
    let _nameTimer = null;

    function assembleName(ch) {
      const bytes = [
        ...(_nameParts[ch] && _nameParts[ch][0] || []),
        ...(_nameParts[ch] && _nameParts[ch][1] || []),
        ...(_nameParts[ch] && _nameParts[ch][2] || []),
      ].filter(b => b !== 0 && b !== 0xFF);
      const name = String.fromCharCode(...bytes).trim();
      if (name && ch === 1) node.moduleName = name;
      return name;
    }

    const _addrHex = '0x' + node.address.toString(16).padStart(2, '0').toUpperCase();

    function setStatus(text, fill, shape) {
      const label = node.moduleName
        ? node.moduleName + ' (' + _addrHex + ')'
        : _addrHex;
      node.status({ fill: fill || 'green', shape: shape || 'dot', text: label + ' ' + text });
    }

    // ── Firmware/type check ───────────────────────────────────────────────

    function handleModuleType(body) {
      if (body.length < 8) return;
      const typeId = body[1];
      const build  = body[5] * 100 + body[6];
      const canFD  = !!(body[7] & 0x20);

      const desc = ENERGY_TYPES_20[typeId];
      if (!desc) {
        node.status({ fill: 'red', shape: 'ring',
          text: 'unknown type 0x' + typeId.toString(16) });
        node.error('velbus-energy: unrecognised module type 0x' + typeId.toString(16));
        return;
      }

      node.moduleName = node.moduleName || desc.name;
      setStatus('build ' + build + (canFD ? ' CAN FD' : ''), 'grey', 'dot');

      setTimeout(() => {
        node.bridge.send(pkt(0xF8, node.address, [0xEF, 0xFF]));
        _nameTimer = setTimeout(() => assembleName(1), 2000);
      }, 100);
    }

    // ── Packet handler ────────────────────────────────────────────────────

    function onPacket(raw) {
      const p = parsePkt(raw);
      if (!p || p.rtr) return;

      const { cmd, body } = p;

      switch (cmd) {

        // ── 0xFF  Module type ─────────────────────────────────────────────
        case 0xFF: {
          handleModuleType(body);
          break;
        }

        // ── 0x00  Alarm status (primary address = bitmask 1, sub-address1 =
        //          bitmask 2 — same command, discriminated by source address) ──
        // The PDF's own DATABYTE2/3/4 labels ("Channel just pressed" etc.)
        // are template leftovers from a different module and don't apply —
        // the actual meaning comes from the bitmask tables underneath them.
        case 0x00: {
          if (body.length < 4) return;
          const bits = body[1];

          if (p.addr === node.address) {
            // Primary address — alarm bitmask 1
            _alarmState.psu1Offline    = !!(bits & 0x01);
            _alarmState.psu2Offline    = !!(bits & 0x02);
            _alarmState.warrantyExpired = !!(bits & 0x04);
            _alarmState.psu1Alarm1     = !!(bits & 0x08);
            // bit 0x10 = PSU1 peak load >xx% — documented "not implemented"
            _alarmState.psu2Alarm1     = !!(bits & 0x20);
            // bit 0x40 = PSU2 peak load >xx% — documented "not implemented"
            _alarmState.psuOutAlarm1   = !!(bits & 0x80);
          } else {
            // Arrived via sub-address1 — alarm bitmask 2
            _alarmState.psu1Alarm2   = !!(bits & 0x01);
            _alarmState.psu1Alarm3   = !!(bits & 0x02);
            _alarmState.psu1Alarm4   = !!(bits & 0x04);
            _alarmState.psu2Alarm2   = !!(bits & 0x08);
            _alarmState.psu2Alarm3   = !!(bits & 0x10);
            _alarmState.psu2Alarm4   = !!(bits & 0x20);
            _alarmState.psuOutAlarm2 = !!(bits & 0x40);
            // bit 0x80 = PSUOut peak load >xx% — documented "not implemented"
          }

          const on = anyAlarmActive();
          const payload = { type: 'alarm', on, alarms: { ..._alarmState } };
          if (on) setStatus('alarm active', 'red');
          node.send([{ payload }, null]);
          break;
        }

        // ── 0xED  Module status — repeats both alarm bitmasks from 0x00 in
        //          one packet, plus load percentages and the shared
        //          program/clock-alarm/sunrise/sunset byte ─────────────────
        case 0xED: {
          if (body.length < 8) return;
          const bits1 = body[1];
          const bits2 = body[2];

          _alarmState.psu1Offline      = !!(bits1 & 0x01);
          _alarmState.psu2Offline      = !!(bits1 & 0x02);
          _alarmState.warrantyExpired  = !!(bits1 & 0x04);
          _alarmState.psu1Alarm1       = !!(bits1 & 0x08);
          _alarmState.psu2Alarm1       = !!(bits1 & 0x20);
          _alarmState.psuOutAlarm1     = !!(bits1 & 0x80);
          _alarmState.psu1Alarm2       = !!(bits2 & 0x01);
          _alarmState.psu1Alarm3       = !!(bits2 & 0x02);
          _alarmState.psu1Alarm4       = !!(bits2 & 0x04);
          _alarmState.psu2Alarm2       = !!(bits2 & 0x08);
          _alarmState.psu2Alarm3       = !!(bits2 & 0x10);
          _alarmState.psu2Alarm4       = !!(bits2 & 0x20);
          _alarmState.psuOutAlarm2     = !!(bits2 & 0x40);

          const psu1Load   = body[3];
          const psu2Load   = body[4];
          const psuOutLoad = body[5];

          const progByte = body[6];
          const program = ['none', 'group1', 'group2', 'group3'][progByte & 0x03];
          const clockAlarm1On    = !!(progByte & 0x04);
          const clockAlarm1Global = !!(progByte & 0x08);
          const clockAlarm2On    = !!(progByte & 0x10);
          const clockAlarm2Global = !!(progByte & 0x20);
          const sunriseEnabled   = !!(progByte & 0x40);
          const sunsetEnabled    = !!(progByte & 0x80);

          const autoSendInterval = body[7];
          const on = anyAlarmActive();

          const payload = {
            type: 'status',
            on,
            alarms: { ..._alarmState },
            psu1Load, psu2Load, psuOutLoad,
            program,
            clockAlarms: {
              alarm1: { on: clockAlarm1On, global: clockAlarm1Global },
              alarm2: { on: clockAlarm2On, global: clockAlarm2Global },
            },
            sunrise: sunriseEnabled,
            sunset:  sunsetEnabled,
            autoSendInterval,
          };
          setStatus('PSU1:' + psu1Load + '% PSU2:' + psu2Load + '% Out:' + psuOutLoad + '%',
            on ? 'red' : 'green');
          node.send([{ payload }, null]);
          break;
        }

        // ── 0xA1  Warranty counter status ─────────────────────────────────
        // 31-bit hours-in-operation value spans body[1]-body[3] plus the low
        // 7 bits of body[4]; bit 7 of body[4] is the expired flag. Byte
        // ordering (MSB-first) reasoned from the field description order in
        // the PDF ("1st/2nd/3rd byte of value" then "+7 bits") — not
        // independently confirmed against a captured real packet.
        case 0xA1: {
          if (body.length < 5) return;
          const hours = ((body[1] << 23) | (body[2] << 15) | (body[3] << 7) |
                         (body[4] & 0x7F)) >>> 0;
          const expired = !!(body[4] & 0x80);

          const payload = { type: 'warranty', hours, expired,
            limitHours: 87660, on: expired };
          if (expired) setStatus('WARRANTY EXPIRED', 'red');
          node.send([{ payload }, null]);
          break;
        }

        // ── 0xA2  PSU load status ──────────────────────────────────────────
        case 0xA2: {
          if (body.length < 5) return;
          const modeNames = { 1: 'balance', 2: 'boost', 3: 'backup' };
          const mode = modeNames[body[1]] || 'unknown';

          const payload = {
            type: 'psu_load',
            mode,
            psu1Load:   body[2],
            psu2Load:   body[3],
            psuOutLoad: body[4],
          };
          node.send([{ payload }, null]);
          break;
        }

        // ── 0xA3  PSU values status — one packet per rail (PSU1/PSU2/PSUOut) ─
        // See the file-level comment re: the PDF's own DATABYTE6 labelling
        // error — this reconstructs the intended 8-byte layout from the
        // stated field count and DLC, not from the PDF's literal (broken)
        // byte labels.
        case 0xA3: {
          if (body.length < 8) return;
          const channel     = (body[1] >> 4) & 0x0F;   // 1=PSU1, 2=PSU2, 3=PSUOut
          const wattageMSB  = body[1] & 0x0F;
          const wattageMW   = (wattageMSB << 16) | (body[2] << 8) | body[3];
          const voltageMV   = (body[4] << 8) | body[5];
          const amperageMA  = (body[6] << 8) | body[7];
          const channelName = { 1: 'PSU1', 2: 'PSU2', 3: 'PSUOut' }[channel] || 'unknown';

          const payload = {
            type: 'psu_values',
            channel, channelName,
            wattageMW, voltageMV, amperageMA,
            watts: wattageMW / 1000,
            volts: voltageMV / 1000,
            amps:  amperageMA / 1000,
          };
          node.send([{ payload }, null]);
          break;
        }

        // ── 0xF0/F1/F2  Channel name parts ─────────────────────────────────
        case 0xF0:
        case 0xF1:
        case 0xF2: {
          const ch   = body[1];
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

    // Startup RTR
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

      // Warranty counter request — single byte, no parameters.
      if (cmd === 'get_warranty') {
        node.bridge.send(pkt(0xF8, node.address, [0xA0]));
        return;
      }

      // Request channel name — DB2=channel number (1-10, 0xFF=all)
      if (cmd === 'get_name') {
        const ch = parseInt(msg.payload.channel) || 0xFF;
        node.bridge.send(pkt(0xF8, node.address, [0xEF, ch]));
        return;
      }

      node.warn('velbus-energy: unknown cmd: ' + cmd);
    });

    // ── Cleanup ───────────────────────────────────────────────────────────

    node.on('close', function() {
      if (_nameTimer) { clearTimeout(_nameTimer); _nameTimer = null; }
      node.bridge.deregister(node.address, onPacket);
    });

    setStatus('ready', 'grey', 'dot');
  }

  RED.nodes.registerType('velbus-energy', VelbusEnergyNode);
};

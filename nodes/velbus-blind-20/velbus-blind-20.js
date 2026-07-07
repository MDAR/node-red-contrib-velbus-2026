'use strict';

const { pkt, rtrPkt, parsePkt } = require('../../lib/velbus-utils');
const { BLIND_TYPES_20, BLIND_TYPE_IDS_20 } = require('../../lib/blind-types-20');

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

const BLIND_STATUS = { 0: 'off', 1: 'up', 2: 'down' };

const LOCK_STATUS = {
  0: 'normal', 1: 'inhibited', 2: 'inhibit_preset_down',
  3: 'inhibit_preset_up', 4: 'forced_down', 5: 'forced_up', 6: 'locked',
};

function make24(duration) {
  return [(duration >> 16) & 0xFF, (duration >> 8) & 0xFF, duration & 0xFF];
}

// ─────────────────────────────────────────────────────────────────────────────
// Node
// ─────────────────────────────────────────────────────────────────────────────

module.exports = function(RED) {

  function VelbusBlind20Node(config) {
    RED.nodes.createNode(this, config);
    const node = this;

    node.bridge     = RED.nodes.getNode(config.bridge);
    node.address    = typeof config.address === 'number'
      ? config.address  // legacy saves stored decimal numbers
      : (parseInt(config.address, 16) || 0);  // editor stores hex strings
    node.moduleName = config.moduleName || '';
    node.typeId     = config.typeId ? parseInt(config.typeId) : null;
    node.channel    = parseInt(config.channel) || 1;

    if (!node.bridge) {
      node.status({ fill: 'red', shape: 'ring', text: 'no bridge' });
      node.error('velbus-blind-20: no bridge configured');
      return;
    }
    if (!node.address || node.address < 1 || node.address > 254) {
      node.status({ fill: 'red', shape: 'ring', text: 'invalid address' });
      node.error('velbus-blind-20: invalid address ' + node.address);
      return;
    }

    const _addrHex = '0x' + node.address.toString(16).padStart(2, '0').toUpperCase();

    // Name retrieval
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
      const label = node.moduleName
        ? node.moduleName + ' ch' + node.channel + ' (' + _addrHex + ')'
        : _addrHex + ' ch' + node.channel;
      node.status({ fill: fill || 'green', shape: shape || 'dot', text: label + ' ' + text });
    }

    // ── Firmware check ────────────────────────────────────────────────────

    function handleModuleType(body) {
      if (body.length < 8) return;
      const typeId = body[1];
      const build  = body[5] * 100 + body[6];
      const canFD  = !!(body[7] & 0x20);

      const desc = BLIND_TYPES_20[typeId];
      if (!desc) {
        node.status({ fill: 'red', shape: 'ring',
          text: 'unknown type 0x' + typeId.toString(16) });
        return;
      }
      node.moduleName = node.moduleName || desc.name;
      setStatus('build ' + build + (canFD ? ' CAN FD' : ''), 'grey', 'dot');

      // Request name for this channel
      setTimeout(() => {
        node.bridge.send(pkt(0xF8, node.address, [0xEF, node.channel]));
        _nameTimer = setTimeout(assembleName, 2000);
      }, 100);
    }

    // ── Packet handler ────────────────────────────────────────────────────

    function onPacket(raw) {
      const p = parsePkt(raw);
      if (!p || p.rtr) return;
      if (p.addr !== node.address) return;

      const { cmd, body } = p;

      switch (cmd) {

        // ── 0xFF  Module type ─────────────────────────────────────────────
        case 0xFF: {
          handleModuleType(body);
          break;
        }

        // ── 0xEC  Module status — both channels in one packet ─────────────
        case 0xEC: {
          if (body.length < 8) return;
          // body[0]=0xEC
          // body[1]=DB2: bits0-3=ch1 status, bits4-7=ch2 status
          // body[2]=DB3: ch1 position (0-100%)
          // body[3]=DB4: ch2 position (0-100%)
          // body[4]=DB5: lock state bits0-3=ch1, bits4-7=ch2
          // body[5]=DB6: auto mode bits0-3=ch1, bits4-7=ch2
          // body[6]=DB7: program disabled bit0=ch1, bit4=ch2
          // body[7]=DB8: alarm & program selection (global)

          const ch = node.channel;
          const statusNibble = ch === 1 ? (body[1] & 0x0F) : ((body[1] >> 4) & 0x0F);
          const position     = ch === 1 ? body[2] : body[3];
          const lockNibble   = ch === 1 ? (body[4] & 0x0F) : ((body[4] >> 4) & 0x0F);
          const autoMode     = ch === 1 ? (body[5] & 0x0F) : ((body[5] >> 4) & 0x0F);
          const progDisabled = ch === 1 ? !!(body[6] & 0x01) : !!(body[6] & 0x10);

          const blindStatus = BLIND_STATUS[statusNibble] || 'unknown';
          const lockState   = LOCK_STATUS[lockNibble] || 'unknown';

          const alarmByte = body[7];
          const program        = ['none','summer','winter','holiday'][alarmByte & 0x03];
          const alarm1Active   = !!(alarmByte & 0x04);
          const alarm2Active   = !!(alarmByte & 0x10);
          const sunriseEnabled = !!(alarmByte & 0x40);
          const sunsetEnabled  = !!(alarmByte & 0x80);

          const on = blindStatus !== 'off';
          setStatus(blindStatus + ' ' + position + '%');

          const payload = {
            type:         'blind_status',
            channel:      ch,
            on,
            status:       blindStatus,
            position,
            lockState,
            autoMode,
            progDisabled,
            program,
            alarms: { alarm1Active, alarm2Active },
            sunrise: sunriseEnabled,
            sunset:  sunsetEnabled,
          };
          node.send([{ payload }]);
          break;
        }

        // ── 0xF0/F1/F2  Channel name parts ───────────────────────────────
        case 0xF0:
        case 0xF1:
        case 0xF2: {
          // body[0]=cmd, body[1]=channel number (1 or 2), body[2..]=chars
          if (body[1] !== node.channel) return;
          const part = cmd - 0xF0;
          _nameParts[part] = Array.from(body).slice(2);
          if (part === 2) assembleName();
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

      const ch = node.channel; // 1, 2, or caller can override via msg.payload.channel

      if (cmd === 'get_status') {
        node.bridge.send(pkt(0xFB, node.address, [0xFA, 0x00]));
        return;
      }
      if (cmd === 'stop') {
        node.bridge.send(pkt(0xF8, node.address, [0x04, ch]));
        return;
      }
      if (cmd === 'up') {
        // Note: 0xFFFFFF NOT allowed for timeout on VMB2BLE-20
        const timeout = Math.min(parseInt(msg.payload.timeout) || 0, 0xFFFFFE);
        node.bridge.send(pkt(0xF8, node.address, [0x05, ch, ...make24(timeout)]));
        return;
      }
      if (cmd === 'down') {
        const timeout = Math.min(parseInt(msg.payload.timeout) || 0, 0xFFFFFE);
        node.bridge.send(pkt(0xF8, node.address, [0x06, ch, ...make24(timeout)]));
        return;
      }
      if (cmd === 'position') {
        const pos = Math.max(0, Math.min(100, parseInt(msg.payload.position) || 0));
        node.bridge.send(pkt(0xF8, node.address, [0x1C, ch, pos]));
        return;
      }
      if (cmd === 'lock') {
        const duration = parseInt(msg.payload.duration) || 0xFFFFFF;
        node.bridge.send(pkt(0xF8, node.address, [0x1A, ch, ...make24(duration)]));
        return;
      }
      if (cmd === 'unlock') {
        node.bridge.send(pkt(0xF8, node.address, [0x1B, ch]));
        return;
      }
      if (cmd === 'forced_up') {
        const duration = parseInt(msg.payload.duration) || 0xFFFFFF;
        node.bridge.send(pkt(0xF8, node.address, [0x12, ch, ...make24(duration)]));
        return;
      }
      if (cmd === 'cancel_forced_up') {
        node.bridge.send(pkt(0xF8, node.address, [0x13, ch]));
        return;
      }
      if (cmd === 'forced_down') {
        const duration = parseInt(msg.payload.duration) || 0xFFFFFF;
        node.bridge.send(pkt(0xF8, node.address, [0x14, ch, ...make24(duration)]));
        return;
      }
      if (cmd === 'cancel_forced_down') {
        node.bridge.send(pkt(0xF8, node.address, [0x15, ch]));
        return;
      }
      if (cmd === 'inhibit') {
        const duration = parseInt(msg.payload.duration) || 0xFFFFFF;
        node.bridge.send(pkt(0xF8, node.address, [0x16, ch, ...make24(duration)]));
        return;
      }
      if (cmd === 'cancel_inhibit') {
        node.bridge.send(pkt(0xF8, node.address, [0x17, ch]));
        return;
      }
      if (cmd === 'inhibit_preset_up') {
        const duration = parseInt(msg.payload.duration) || 0xFFFFFF;
        node.bridge.send(pkt(0xF8, node.address, [0x18, ch, ...make24(duration)]));
        return;
      }
      if (cmd === 'inhibit_preset_down') {
        const duration = parseInt(msg.payload.duration) || 0xFFFFFF;
        node.bridge.send(pkt(0xF8, node.address, [0x19, ch, ...make24(duration)]));
        return;
      }
      if (cmd === 'auto_mode') {
        const mode = parseInt(msg.payload.mode) || 0;
        node.bridge.send(pkt(0xF8, node.address, [0xB3, ch, mode]));
        return;
      }
      if (cmd === 'enable_program') {
        node.bridge.send(pkt(0xF8, node.address, [0xB2, ch]));
        return;
      }
      if (cmd === 'disable_program') {
        const duration = parseInt(msg.payload.duration) || 0xFFFFFF;
        node.bridge.send(pkt(0xF8, node.address, [0xB1, ch, ...make24(duration)]));
        return;
      }
      if (cmd === 'get_name') {
        node.bridge.send(pkt(0xF8, node.address, [0xEF, ch]));
        return;
      }

      node.warn('velbus-blind-20: unknown cmd: ' + cmd);
    });

    // ── Cleanup ───────────────────────────────────────────────────────────

    node.on('close', function() {
      if (_nameTimer) { clearTimeout(_nameTimer); _nameTimer = null; }
      node.bridge.deregister(node.address, onPacket);
    });

    setStatus('ready', 'grey', 'dot');
  }

  RED.nodes.registerType('velbus-blind-20', VelbusBlind20Node);
};

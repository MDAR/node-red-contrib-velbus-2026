'use strict';

const { pkt, parsePkt } = require('../../lib/velbus-utils');
const { BLIND_TYPES_S, BLIND_TYPE_IDS_S } = require('../../lib/blind-types-s');

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

  function VelbusBlindSNode(config) {
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
      node.error('velbus-blind-s: no bridge configured');
      return;
    }
    if (!node.address || node.address < 1 || node.address > 254) {
      node.status({ fill: 'red', shape: 'ring', text: 'invalid address' });
      node.error('velbus-blind-s: invalid address ' + node.address);
      return;
    }

    const typeDesc = node.typeId !== null ? (BLIND_TYPES_S[node.typeId] || null) : null;
    // Channel bit: ch1=0x01, ch2=0x02 for both VMB1BLS and VMB2BLE
    const chBit = typeDesc ? (typeDesc.channelBits[node.channel] || 0x01) : 0x01;

    // 0x00 relay event bitmask for this channel
    // ch1: up=bit0, down=bit1; ch2: up=bit2, down=bit3
    const relayUpBit   = node.channel === 1 ? 0x01 : 0x04;
    const relayDownBit = node.channel === 1 ? 0x02 : 0x08;

    const _addrHex = '0x' + node.address.toString(16).padStart(2, '0').toUpperCase();
    function setStatus(text, fill, shape) {
      const label = node.moduleName
        ? node.moduleName + ' ch' + node.channel + ' (' + _addrHex + ')'
        : _addrHex + ' ch' + node.channel;
      node.status({ fill: fill || 'green', shape: shape || 'dot', text: label + ' ' + text });
    }

    // ── Packet handler ────────────────────────────────────────────────────

    function onPacket(raw) {
      const p = parsePkt(raw);
      if (!p || p.rtr) return;
      if (p.addr !== node.address) return;

      const { cmd, body } = p;

      switch (cmd) {

        // ── 0x00  Relay switch events ─────────────────────────────────────
        case 0x00: {
          if (body.length < 4) return;
          // body[0]=cmd, body[1]=switched on, body[2]=switched off, body[3]=0x00
          const pressedByte   = body[1];
          const releasedByte  = body[2];

          const upOn    = !!(pressedByte  & relayUpBit);
          const upOff   = !!(releasedByte & relayUpBit);
          const downOn  = !!(pressedByte  & relayDownBit);
          const downOff = !!(releasedByte & relayDownBit);

          if (!upOn && !upOff && !downOn && !downOff) return;

          const direction = upOn ? 'up' : downOn ? 'down' : null;
          const stopped   = upOff || downOff;
          if (direction) setStatus(direction);
          else if (stopped) setStatus('stopped');

          const payload = {
            type:      'blind_event',
            channel:   node.channel,
            upOn,
            upOff,
            downOn,
            downOff,
            moving:    direction,
          };
          node.send([{ payload }, null]);
          break;
        }

        // ── 0xEC  Blind status ────────────────────────────────────────────
        case 0xEC: {
          if (body.length < 8) return;
          // body[0]=0xEC, body[1]=channel bit, body[2]=default timeout (seconds),
          // body[3]=blind status, body[4]=LED status, body[5]=position (0-100%),
          // body[6]=lock/inhibit/forced state, body[7]=alarm & auto mode

          if (body[1] !== chBit) return;

          const blindStatus   = BLIND_STATUS[body[3]] || 'unknown';
          const position      = body[5];  // 0=up, 100=down
          const lockState     = LOCK_STATUS[body[6] & 0x07] || 'unknown';

          const alarmByte = body[7];
          const autoMode       = alarmByte & 0x03;
          const alarm1Active   = !!(alarmByte & 0x04);
          const alarm2Active   = !!(alarmByte & 0x10);
          const sunriseEnabled = !!(alarmByte & 0x40);
          const sunsetEnabled  = !!(alarmByte & 0x80);

          const ledByte = body[4];
          const led = {
            downOn:        !!(ledByte & 0x80),
            downSlowBlink: !!(ledByte & 0x40),
            downFastBlink: !!(ledByte & 0x20),
            downVFastBlink:!!(ledByte & 0x10),
            upOn:          !!(ledByte & 0x08),
            upSlowBlink:   !!(ledByte & 0x04),
            upFastBlink:   !!(ledByte & 0x02),
            upVFastBlink:  !!(ledByte & 0x01),
          };

          const on = blindStatus !== 'off';
          setStatus(blindStatus + ' ' + position + '%');

          const payload = {
            type:      'blind_status',
            channel:   node.channel,
            on,
            status:    blindStatus,
            position,
            lockState,
            autoMode,
            alarms: { alarm1Active, alarm2Active },
            sunrise: sunriseEnabled,
            sunset:  sunsetEnabled,
            led,
          };
          node.send([null, { payload }]);
          break;
        }

        // ── 0xF0/F1/F2  Blind name parts ─────────────────────────────────
        case 0xF0:
        case 0xF1:
        case 0xF2: {
          // body[0]=cmd, body[1]=channel bit, body[2..]=chars
          if (body[1] !== chBit) return;
          let text = '';
          for (let i = 2; i < body.length; i++) {
            if (body[i] === 0 || body[i] === 0xFF) break;
            text += String.fromCharCode(body[i]);
          }
          if (text && cmd === 0xF0) node.moduleName = text;
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
        node.bridge.send(pkt(0xFB, node.address, [0xFA, chBit]));
        return;
      }
      if (cmd === 'stop') {
        node.bridge.send(pkt(0xF8, node.address, [0x04, chBit]));
        return;
      }
      if (cmd === 'up') {
        const timeout = parseInt(msg.payload.timeout) || 0;
        node.bridge.send(pkt(0xF8, node.address, [0x05, chBit, ...make24(timeout)]));
        return;
      }
      if (cmd === 'down') {
        const timeout = parseInt(msg.payload.timeout) || 0;
        node.bridge.send(pkt(0xF8, node.address, [0x06, chBit, ...make24(timeout)]));
        return;
      }
      if (cmd === 'position') {
        const pos = Math.max(0, Math.min(100, parseInt(msg.payload.position) || 0));
        node.bridge.send(pkt(0xF8, node.address, [0x1C, chBit, pos]));
        return;
      }
      if (cmd === 'lock') {
        const duration = parseInt(msg.payload.duration) || 0xFFFFFF;
        node.bridge.send(pkt(0xF8, node.address, [0x1A, chBit, ...make24(duration)]));
        return;
      }
      if (cmd === 'unlock') {
        node.bridge.send(pkt(0xF8, node.address, [0x1B, chBit]));
        return;
      }
      if (cmd === 'forced_up') {
        const duration = parseInt(msg.payload.duration) || 0xFFFFFF;
        node.bridge.send(pkt(0xF8, node.address, [0x12, chBit, ...make24(duration)]));
        return;
      }
      if (cmd === 'cancel_forced_up') {
        node.bridge.send(pkt(0xF8, node.address, [0x13, chBit]));
        return;
      }
      if (cmd === 'forced_down') {
        const duration = parseInt(msg.payload.duration) || 0xFFFFFF;
        node.bridge.send(pkt(0xF8, node.address, [0x14, chBit, ...make24(duration)]));
        return;
      }
      if (cmd === 'cancel_forced_down') {
        node.bridge.send(pkt(0xF8, node.address, [0x15, chBit]));
        return;
      }
      if (cmd === 'inhibit') {
        const duration = parseInt(msg.payload.duration) || 0xFFFFFF;
        node.bridge.send(pkt(0xF8, node.address, [0x16, chBit, ...make24(duration)]));
        return;
      }
      if (cmd === 'cancel_inhibit') {
        node.bridge.send(pkt(0xF8, node.address, [0x17, chBit]));
        return;
      }
      if (cmd === 'inhibit_preset_up') {
        const duration = parseInt(msg.payload.duration) || 0xFFFFFF;
        node.bridge.send(pkt(0xF8, node.address, [0x18, chBit, ...make24(duration)]));
        return;
      }
      if (cmd === 'inhibit_preset_down') {
        const duration = parseInt(msg.payload.duration) || 0xFFFFFF;
        node.bridge.send(pkt(0xF8, node.address, [0x19, chBit, ...make24(duration)]));
        return;
      }
      if (cmd === 'auto_mode') {
        const mode = parseInt(msg.payload.mode) || 0; // 0=disabled, 1-3=mode
        node.bridge.send(pkt(0xF8, node.address, [0xB3, chBit, mode]));
        return;
      }
      if (cmd === 'get_name') {
        node.bridge.send(pkt(0xF8, node.address, [0xEF, chBit]));
        return;
      }

      node.warn('velbus-blind-s: unknown cmd: ' + cmd);
    });

    // ── Cleanup ───────────────────────────────────────────────────────────

    node.on('close', function() {
      node.bridge.deregister(node.address, onPacket);
    });

    setStatus('ready', 'grey', 'dot');
  }

  RED.nodes.registerType('velbus-blind-s', VelbusBlindSNode);
};

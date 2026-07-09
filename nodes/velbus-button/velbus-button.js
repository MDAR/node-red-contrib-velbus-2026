'use strict';

const { parsePkt } = require('../../lib/velbus-utils');

// ─────────────────────────────────────────────────────────────────────────────
// Button module type registry
// ─────────────────────────────────────────────────────────────────────────────
const BUTTON_TYPES = {
  0x01: { name: 'VMB8PB',    channels: 8, series: 'original' },
  0x16: { name: 'VMB8PBU',   channels: 8, series: 'original' },
  0x17: { name: 'VMB6PBN',   channels: 6, series: 'original' },
  0x1C: { name: 'VMB4PB',    channels: 4, series: 'original' },
  0x20: { name: 'VMB6PB-20', channels: 6, series: 'v2'       },
};

const BUTTON_TYPE_IDS = new Set(Object.keys(BUTTON_TYPES).map(k => parseInt(k)));

// ─────────────────────────────────────────────────────────────────────────────
// Channel bitmask helper
// ─────────────────────────────────────────────────────────────────────────────
function bitsToChannels(byte1, byte2, byte3, byte4) {
  const channels = [];
  const bytes = [byte1 || 0, byte2 || 0, byte3 || 0, byte4 || 0];
  for (let b = 0; b < 4; b++) {
    for (let bit = 0; bit < 8; bit++) {
      if (bytes[b] & (1 << bit)) channels.push(b * 8 + bit + 1);
    }
  }
  return channels;
}

// ─────────────────────────────────────────────────────────────────────────────
// Node
// ─────────────────────────────────────────────────────────────────────────────
module.exports = function(RED) {

  function VelbusButtonNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;

    node.bridge       = RED.nodes.getNode(config.bridge);
    node.address      = typeof config.address === 'number'
      ? config.address  // legacy saves stored decimal numbers
      : (parseInt(config.address, 16) || 0);  // editor stores hex strings
    node.channelCount = parseInt(config.channelCount) || 8;
    node.moduleName   = config.moduleName || '';
    node.typeId       = config.typeId ? parseInt(config.typeId) : null;

    if (!node.bridge) {
      node.status({ fill: 'red', shape: 'ring', text: 'no bridge' });
      node.error('velbus-button: no bridge configured');
      return;
    }
    if (!node.address || node.address < 1 || node.address > 254) {
      node.status({ fill: 'red', shape: 'ring', text: 'invalid address' });
      node.error('velbus-button: invalid address ' + node.address);
      return;
    }

    const _label = node.moduleName
      ? node.moduleName + ' (0x' + node.address.toString(16).padStart(2, '0').toUpperCase() + ')'
      : '0x' + node.address.toString(16).padStart(2, '0').toUpperCase();

    function setStatus(text, fill, shape) {
      node.status({ fill: fill || 'green', shape: shape || 'dot', text: _label + ' ' + text });
    }

    // ── Packet handler ───────────────────────────────────────────────────

    function onPacket(raw) {
      const p = parsePkt(raw);
      if (!p || p.rtr) return;
      if (p.addr !== node.address) return;

      const { cmd, body } = p;

      // 0x00 — button press / release / long-press
      if (cmd === 0x00) {
        if (body.length < 3) return;

        // body[0]=0x00 cmd, body[1]=DB2 pressed, body[2]=DB3 released, body[3]=DB4 long
        const pressed     = bitsToChannels(body[1]);
        const released    = bitsToChannels(body[2]);
        const longPressed = body.length >= 4 ? bitsToChannels(body[3]) : [];

        const on = pressed.length > 0 || longPressed.length > 0;

        const payload = {
          type:        'button',
          on,
          pressed,
          released,
          longPressed,
        };

        setStatus(
          pressed.length     ? 'pressed ch' + pressed.join(',')
          : longPressed.length ? 'long ch' + longPressed.join(',')
          : 'released ch' + released.join(',')
        );

        node.send({ payload });
      }
    }

    node.bridge.register(node.address, onPacket);

    // ── Cleanup ──────────────────────────────────────────────────────────

    node.on('close', function() {
      node.bridge.deregister(node.address, onPacket);
    });

    setStatus('ready', 'grey', 'dot');
  }

  RED.nodes.registerType('velbus-button', VelbusButtonNode);
};

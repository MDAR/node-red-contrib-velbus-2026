'use strict';

const { pkt, parsePkt } = require('../../lib/velbus-utils');

// ─────────────────────────────────────────────────────────────────────────────
// Button module type registry
//
// Every field below was checked against the actual protocol PDF for that
// specific type — NOT assumed from a sibling type "probably" matching. Real,
// confirmed divergences found while building this out (09/07/2026):
//
//   - VMB8PB (0x01) has NO Lock/Unlock command and a completely different,
//     simpler 0xED status format (LED on/blink state only) — no locked/
//     enabled/inverted/program bits at all. It is the exception, not most
//     other types lacking these features.
//   - VMB4RF (0x1A) has the Lock/Unlock command, but its module STATUS uses
//     command byte 0xB4, not 0xED — and even that has a different field at
//     DATABYTE4 ("learn transmitter mode" instead of normal/inverted). Its
//     rich status is deliberately NOT decoded here as a result — decoding
//     0xED for this type would simply never fire, since it never sends one.
//   - VMBVP01 (DoorBird module) uses a shorter, different 0xED layout again
//     (just a channel on/off bitmask, no locked/enabled/inverted/program
//     fields) — also not decoded here, kept to plain button events with
//     fixed semantic channel labels instead (see channelLabels below).
//   - The 0xF0/F1/F2 channel-name "which channel is this part for" selector
//     byte is NOT consistent across types — some use a bitmask (one bit set
//     per channel), others a literal 1-based channel number. Getting this
//     wrong silently corrupts every name from channel 3 onward (channels
//     1-2 happen to produce the same byte value under both conventions,
//     which would have masked the bug in casual testing).
//   - VMB4PD's naming mechanism exists ("push button name request") but its
//     exact byte convention isn't confirmed from the document text — left
//     with plain numbered channels rather than guessing.
//
// hasLock         — module accepts Lock channel (0x12) / Unlock channel (0x13)
// hasRichStatus   — module's 0xED matches the locked/enabled/inverted/program
//                   layout (confirmed identical across every type that has it)
// nameStyle       — 'bitmask' | 'number' | null (null = not implemented for
//                   this type, see VMB4PD/VMBVP01 notes above)
// channelLabels   — fixed semantic channel names (VMBVP01 only) — these are
//                   hardware-fixed functions, not VelbusLink-configurable
//                   names, so they don't come from 0xF0/F1/F2 at all
// ─────────────────────────────────────────────────────────────────────────────
const BUTTON_TYPES = {
  0x01: { name: 'VMB8PB',    channels: 8, series: 'original', hasLock: false, hasRichStatus: false, nameStyle: null },
  0x16: { name: 'VMB8PBU',   channels: 8, series: 'original', hasLock: true,  hasRichStatus: true,  nameStyle: 'bitmask' },
  0x17: { name: 'VMB6PBN',   channels: 6, series: 'original', hasLock: true,  hasRichStatus: true,  nameStyle: 'bitmask' },
  // FIXED 09/07/2026 — this entry was previously keyed 0x1C, which is not a
  // real Velbus type byte at all (confirmed against the official type list:
  // it simply doesn't appear there). The correct value is 0x44, matching
  // velbus-scan.js's ALL_TYPES/NODE_SUGGESTION, which have always had this
  // right — only this file's own registry was wrong. A real VMB4PB scanned
  // correctly by velbus-scan would never have matched this file's lookup at
  // all, silently disabling every type-specific feature for it.
  0x44: { name: 'VMB4PB',    channels: 4, series: 'original', hasLock: true,  hasRichStatus: true,  nameStyle: 'number' },
  // FIXED 09/07/2026 — previously keyed 0x20, which actually belongs to
  // VMBGP4 (a glass panel type, already correctly registered separately in
  // lib/glass-panel-types.js and velbus-scan.js). Correct value is 0x4C.
  0x4C: { name: 'VMB6PB-20', channels: 6, series: 'v2',       hasLock: true,  hasRichStatus: true,  nameStyle: 'number' },
  0x0A: { name: 'VMB8IR',    channels: 8, series: 'original', hasLock: false, hasRichStatus: false, nameStyle: 'bitmask' },
  0x0B: { name: 'VMB4PD',    channels: 4, series: 'original', hasLock: false, hasRichStatus: false, nameStyle: null },
  0x1A: { name: 'VMB4RF',    channels: 4, series: 'original', hasLock: true,  hasRichStatus: false, nameStyle: 'bitmask' },
  0x30: { name: 'VMBRFR8S',  channels: 8, series: 'original', hasLock: true,  hasRichStatus: true,  nameStyle: 'bitmask' },
  0x33: { name: 'VMBVP01',   channels: 8, series: 'original', hasLock: false, hasRichStatus: false, nameStyle: null,
          channelLabels: { 1: 'Motion 1', 2: 'Motion 2', 3: 'Bell 1', 4: 'Bell 2',
                            5: 'Door 1', 6: 'Door 2', 7: 'Virtual button 1', 8: 'Virtual button 2' } },
  0x42: { name: 'VMBKP',     channels: 8, series: 'v2',       hasLock: true,  hasRichStatus: true,  nameStyle: 'number' },
  0x43: { name: 'VMBIN',     channels: 1, series: 'original', hasLock: true,  hasRichStatus: true,  nameStyle: 'number' },
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

// Decodes the 0xF0/F1/F2 "which channel is this name-part for" selector byte.
// 'bitmask': one bit set (e.g. 0b00000100 = channel 3).
// 'number': a literal 1-based channel number (e.g. 3 = channel 3).
// These diverge starting at channel 3 — channels 1-2 produce the same byte
// value under both conventions, which would mask this being wrong in
// casual testing with only a couple of channels named.
function nameChannelFromByte(byte, style) {
  if (style === 'number') return byte;
  if (style === 'bitmask') {
    for (let i = 0; i < 8; i++) {
      if (byte & (1 << i)) return i + 1;
    }
    return null;
  }
  return null;
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

    // Type descriptor drives which optional features actually apply — see
    // the registry comment above for why these are per-type, not blanket.
    const _type = BUTTON_TYPES[node.typeId] || null;

    const _label = node.moduleName
      ? node.moduleName + ' (0x' + node.address.toString(16).padStart(2, '0').toUpperCase() + ')'
      : '0x' + node.address.toString(16).padStart(2, '0').toUpperCase();

    function setStatus(text, fill, shape) {
      node.status({ fill: fill || 'green', shape: shape || 'dot', text: _label + ' ' + text });
    }

    // Named-channel state, assembled from 0xF0/F1/F2 where the type supports
    // it (nameStyle !== null). VMBVP01's channelLabels are fixed/hardware,
    // not assembled from the bus, and take priority if both somehow exist.
    let _names = {};

    function applyLabel(ch) {
      if (_type && _type.channelLabels && _type.channelLabels[ch]) {
        return { channel: ch, label: _type.channelLabels[ch] };
      }
      if (_names[ch]) return { channel: ch, label: _names[ch] };
      return ch;
    }

    function withLabels(channels) {
      if (!_type || (!_type.channelLabels && Object.keys(_names).length === 0)) return channels;
      return channels.map(applyLabel);
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
          pressed:     withLabels(pressed),
          released:    withLabels(released),
          longPressed: withLabels(longPressed),
        };

        setStatus(
          pressed.length     ? 'pressed ch' + pressed.join(',')
          : longPressed.length ? 'long ch' + longPressed.join(',')
          : 'released ch' + released.join(',')
        );

        node.send([{ payload }, null]);
        return;
      }

      // 0xED — rich module status (locked/enabled/inverted/program) — only
      // for types confirmed to actually send this exact layout. See the
      // registry comment: VMB8PB has a different, simpler 0xED; VMB4RF's
      // status is a different command byte entirely (0xB4); VMBVP01's 0xED
      // is shorter again. This handler simply never fires for those types,
      // rather than risk misreading whatever they do send as this shape.
      if (cmd === 0xED && _type && _type.hasRichStatus) {
        if (body.length < 7) return;

        const pressedBits  = body[1];
        const enabledBits  = body[2];
        const invertedBits = body[3];
        const lockedBits   = body[4];
        const progDisBits  = body[5];
        const progByte     = body[6];

        const channels = [];
        for (let i = 0; i < _type.channels; i++) {
          const bit = 1 << i;
          channels.push({
            channel:         i + 1,
            pressed:         !!(pressedBits & bit),
            enabled:         !!(enabledBits & bit),
            inverted:        !(invertedBits & bit),  // bit=1 is "normal", bit=0 is "inverted" per protocol
            locked:          !!(lockedBits & bit),
            programDisabled: !!(progDisBits & bit),
          });
        }

        const program = ['none', 'group1', 'group2', 'group3'][progByte & 0x03];

        const payload = {
          type: 'status',
          channels,
          program,
        };

        node.send([{ payload }, null]);
        return;
      }

      // 0xF0/0xF1/0xF2 — channel name parts, where this type supports it
      if ((cmd === 0xF0 || cmd === 0xF1 || cmd === 0xF2) && _type && _type.nameStyle) {
        if (body.length < 2) return;
        const ch = nameChannelFromByte(body[1], _type.nameStyle);
        if (!ch) return;

        if (!node._nameParts) node._nameParts = {};
        if (!node._nameParts[ch]) node._nameParts[ch] = {};
        const part = cmd - 0xF0;
        node._nameParts[ch][part] = Array.from(body).slice(2);

        if (part === 2) {
          const bytes = [
            ...(node._nameParts[ch][0] || []),
            ...(node._nameParts[ch][1] || []),
            ...(node._nameParts[ch][2] || []),
          ].filter(b => b !== 0 && b !== 0xFF);
          const name = String.fromCharCode(...bytes).trim();
          if (name) _names[ch] = name;
        }
        return;
      }
    }

    node.bridge.register(node.address, onPacket);

    // Request channel names on startup, where supported
    if (_type && _type.nameStyle) {
      setTimeout(function() {
        node.bridge.send(pkt(0xF8, node.address, [0xEF, 0xFF]));
      }, 500);
    }

    // ── Input ────────────────────────────────────────────────────────────

    node.on('input', function(msg) {
      const inp = (msg && msg.payload && typeof msg.payload === 'object') ? msg.payload : {};
      const cmd = inp.cmd;
      if (!cmd) return;

      if (cmd === 'get_name') {
        const ch = inp.channel !== undefined ? parseInt(inp.channel) : 0xFF;
        node.bridge.send(pkt(0xF8, node.address, [0xEF, ch]));
        return;
      }

      if (cmd === 'get_status') {
        node.bridge.send(pkt(0xFB, node.address, [0xFA, 0x00]));
        return;
      }

      if (cmd === 'lock' || cmd === 'unlock') {
        if (!_type || !_type.hasLock) {
          const warnMsg = 'velbus-button: ' + (_type ? _type.name : 'this module type') +
            ' does not support lock/unlock (no such command in its protocol) — sending nothing.';
          node.warn(warnMsg);
          node.send([null, { payload: { type: 'warning', message: warnMsg } }]);
          return;
        }

        const ch = inp.channel !== undefined ? parseInt(inp.channel) : 0xFF;

        if (cmd === 'unlock') {
          node.bridge.send(pkt(0xFB, node.address, [0x13, ch]));
        } else {
          const duration = inp.duration === undefined ? -1 : parseInt(inp.duration);
          const t = duration < 0 ? [0xFF, 0xFF, 0xFF] : [
            (duration >> 16) & 0xFF, (duration >> 8) & 0xFF, duration & 0xFF,
          ];
          node.bridge.send(pkt(0xFB, node.address, [0x12, ch, ...t]));
        }
        setStatus(cmd + ' ch' + (ch === 0xFF ? 'all' : ch));
        return;
      }

      node.warn('velbus-button: unknown cmd: ' + cmd);
    });

    // ── Cleanup ──────────────────────────────────────────────────────────

    node.on('close', function() {
      node.bridge.deregister(node.address, onPacket);
    });

    setStatus('ready', 'grey', 'dot');
  }

  RED.nodes.registerType('velbus-button', VelbusButtonNode);
};

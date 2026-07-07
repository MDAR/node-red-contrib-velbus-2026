'use strict';

const { pkt, parsePkt } = require('../../lib/velbus-utils');
const { BLIND_TYPES, BLIND_TYPE_IDS } = require('../../lib/blind-types');

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

// VMB1BL: 0x00 bitmask uses bits 0-1 for relays, bits 4-5 for local buttons
// VMB2BL: 0x00 bitmask bits 0-1=ch1 relays, 2-3=ch2 relays,
//          4-5=ch1 local buttons, 6-7=ch2 local buttons
function decodeBlindEvent(pressedByte, releasedByte, longByte, typeDesc) {
  const events = [];
  const masks = typeDesc.channelMasks;

  for (const [chStr, mask] of Object.entries(masks)) {
    const ch = parseInt(chStr);
    const upBit   = mask & 0x01 ? 0x01 : (mask >> 2) & 0x01 ? 0x04 : 0;
    const downBit = mask & 0x02 ? 0x02 : (mask >> 2) & 0x02 ? 0x08 : 0;

    // Relay state changes
    if (pressedByte & upBit)    events.push({ channel: ch, event: 'relay_up_on' });
    if (releasedByte & upBit)   events.push({ channel: ch, event: 'relay_up_off' });
    if (pressedByte & downBit)  events.push({ channel: ch, event: 'relay_down_on' });
    if (releasedByte & downBit) events.push({ channel: ch, event: 'relay_down_off' });
  }

  // Local button events (if module has them)
  if (typeDesc.hasLocalButtons) {
    // VMB1BL: up=bit4, down=bit5
    // VMB2BL: ch1 up=bit4, ch1 down=bit5, ch2 up=bit6, ch2 down=bit7
    const btnBases = typeDesc.channels === 1
      ? [{ ch: 1, upBit: 0x10, downBit: 0x20 }]
      : [{ ch: 1, upBit: 0x10, downBit: 0x20 }, { ch: 2, upBit: 0x40, downBit: 0x80 }];

    for (const { ch, upBit: ub, downBit: db } of btnBases) {
      if (pressedByte & ub)  events.push({ channel: ch, event: 'btn_up_pressed' });
      if (releasedByte & ub) events.push({ channel: ch, event: 'btn_up_released' });
      if (longByte & ub)     events.push({ channel: ch, event: 'btn_up_long' });
      if (pressedByte & db)  events.push({ channel: ch, event: 'btn_down_pressed' });
      if (releasedByte & db) events.push({ channel: ch, event: 'btn_down_released' });
      if (longByte & db)     events.push({ channel: ch, event: 'btn_down_long' });
    }
  }

  return events;
}

const TIMEOUT_LABELS = { 0: '15s', 1: '30s', 2: '1min', 3: '2min' };
const BLIND_STATUS   = { 0: 'off', 1: 'up', 2: 'down' };

// ─────────────────────────────────────────────────────────────────────────────
// Node
// ─────────────────────────────────────────────────────────────────────────────

module.exports = function(RED) {

  function VelbusBlindNode(config) {
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
      node.error('velbus-blind: no bridge configured');
      return;
    }
    if (!node.address || node.address < 1 || node.address > 254) {
      node.status({ fill: 'red', shape: 'ring', text: 'invalid address' });
      node.error('velbus-blind: invalid address ' + node.address);
      return;
    }

    const typeDesc = node.typeId !== null ? (BLIND_TYPES[node.typeId] || null) : null;
    const chMask   = typeDesc ? (typeDesc.channelMasks[node.channel] || 0x03) : 0x03;

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

        // ── 0x00  Relay events and local button events ────────────────────
        case 0x00: {
          if (body.length < 4) return;
          // body[0]=cmd, body[1]=pressed, body[2]=released, body[3]=longPressed
          if (!typeDesc) return;
          const events = decodeBlindEvent(body[1], body[2], body[3], typeDesc);
          if (!events.length) return;

          // Filter to events relevant to this node's channel
          const myEvents = events.filter(e => e.channel === node.channel);
          if (!myEvents.length) return;

          // Determine overall motion state from relay events
          const relayOn  = myEvents.filter(e => e.event === 'relay_up_on' || e.event === 'relay_down_on');
          const relayOff = myEvents.filter(e => e.event === 'relay_up_off' || e.event === 'relay_down_off');
          const moving   = relayOn.some(e => e.event === 'relay_up_on') ? 'up'
                         : relayOn.some(e => e.event === 'relay_down_on') ? 'down'
                         : null;
          if (moving) setStatus(moving);
          else if (relayOff.length) setStatus('stopped');

          const payload = {
            type:   'blind_event',
            channel: node.channel,
            events: myEvents,
          };
          node.send([{ payload }]);
          break;
        }

        // ── 0xEC  Blind status ────────────────────────────────────────────
        case 0xEC: {
          if (body.length < 8) return;
          // body[0]=0xEC, body[1]=channel mask, body[2]=timeout setting,
          // body[3]=blind status, body[4]=LED status,
          // body[5-7]=24-bit current delay time remaining
          const statusMask = body[1];

          // Only process if this packet is for our channel
          if (statusMask !== chMask) return;

          const timeoutSetting = TIMEOUT_LABELS[body[2]] || body[2] + 's';
          const blindStatus    = BLIND_STATUS[body[3]] || 'unknown';
          const ledByte        = body[4];
          const delayRemaining = (body[5] << 16) | (body[6] << 8) | body[7];

          const ledStatus = {
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
          setStatus(blindStatus);

          const payload = {
            type:            'blind_status',
            channel:         node.channel,
            on,
            status:          blindStatus,
            timeoutSetting,
            delayRemaining,
            led:             ledStatus,
          };
          node.send([{ payload }]);
          break;
        }

        // ── 0xF0/F1/F2  Blind name parts ─────────────────────────────────
        case 0xF0:
        case 0xF1:
        case 0xF2: {
          // body[0]=cmd, body[1]=channel mask, body[2..]=chars
          if (body[1] !== chMask) return;
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
        node.bridge.send(pkt(0xFB, node.address, [0xFA, chMask]));
        return;
      }

      if (cmd === 'stop') {
        node.bridge.send(pkt(0xF8, node.address, [0x04, chMask]));
        return;
      }

      if (cmd === 'up') {
        const timeout = parseInt(msg.payload.timeout) || 0;
        const hi = (timeout >> 16) & 0xFF;
        const mid = (timeout >> 8) & 0xFF;
        const lo = timeout & 0xFF;
        node.bridge.send(pkt(0xF8, node.address, [0x05, chMask, hi, mid, lo]));
        return;
      }

      if (cmd === 'down') {
        const timeout = parseInt(msg.payload.timeout) || 0;
        const hi = (timeout >> 16) & 0xFF;
        const mid = (timeout >> 8) & 0xFF;
        const lo = timeout & 0xFF;
        node.bridge.send(pkt(0xF8, node.address, [0x06, chMask, hi, mid, lo]));
        return;
      }

      if (cmd === 'get_name') {
        node.bridge.send(pkt(0xF8, node.address, [0xEF, chMask]));
        return;
      }

      node.warn('velbus-blind: unknown cmd: ' + cmd);
    });

    // ── Cleanup ───────────────────────────────────────────────────────────

    node.on('close', function() {
      node.bridge.deregister(node.address, onPacket);
    });

    setStatus('ready', 'grey', 'dot');
  }

  RED.nodes.registerType('velbus-blind', VelbusBlindNode);
};

'use strict';

const { pkt, rtrPkt, parsePkt } = require('../../lib/velbus-utils');
const { SENSOR_TYPES_20, SENSOR_TYPE_IDS_20 } = require('../../lib/sensor-types-20');

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function activeFromBitmask(byte) {
  const active = [];
  for (let i = 0; i < 8; i++) {
    if (byte & (1 << i)) active.push(i + 1);
  }
  return active;
}

// ─────────────────────────────────────────────────────────────────────────────
// Node
// ─────────────────────────────────────────────────────────────────────────────

module.exports = function(RED) {

  function VelbusSensor20Node(config) {
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
      node.error('velbus-sensor-20: no bridge configured');
      return;
    }
    if (!node.address || node.address < 1 || node.address > 254) {
      node.status({ fill: 'red', shape: 'ring', text: 'invalid address' });
      node.error('velbus-sensor-20: invalid address ' + node.address);
      return;
    }

    const typeDesc = node.typeId !== null ? (SENSOR_TYPES_20[node.typeId] || null) : null;

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
      const label = node.moduleName
        ? node.moduleName + ' (' + _addrHex + ')'
        : _addrHex;
      node.status({ fill: fill || 'green', shape: shape || 'dot', text: label + ' ' + text });
    }

    // ── Firmware check ────────────────────────────────────────────────────

    function handleModuleType(body) {
      if (body.length < 8) return;
      const typeId  = body[1];
      const mapVer  = body[4];
      const build   = body[5] * 100 + body[6];
      const canFD   = !!(body[7] & 0x20);

      const desc = SENSOR_TYPES_20[typeId];
      if (!desc) {
        node.status({ fill: 'red', shape: 'ring',
          text: 'unknown type 0x' + typeId.toString(16) });
        node.error('velbus-sensor-20: unrecognised module type 0x' + typeId.toString(16));
        return;
      }

      node.moduleName = node.moduleName || desc.name;
      setStatus('build ' + build + (canFD ? ' CAN FD' : ''), 'grey', 'dot');

      // Request name for all channels
      setTimeout(() => {
        node.bridge.send(pkt(0xF8, node.address, [0xEF, 0xFF]));
        _nameTimer = setTimeout(assembleName, 2000);
      }, 100);
    }

    // ── Packet handler ────────────────────────────────────────────────────

    function onPacket(raw) {
      const p = parsePkt(raw);
      if (!p || p.rtr) return;
      // Note: no address re-check here. The bridge routes frames to this
      // listener, including subaddress frames mapped to the primary address
      // (e.g. GPO-20 thermostat status from subaddress 0x34).

      const { cmd, body } = p;

      switch (cmd) {

        // ── 0xFF  Module type ─────────────────────────────────────────────
        case 0xFF: {
          handleModuleType(body);
          break;
        }

        // ── 0x00  Channel events ──────────────────────────────────────────
        case 0x00: {
          if (body.length < 4) return;
          // body[0]=cmd, body[1]=pressed, body[2]=released, body[3]=longPressed
          // Note: may arrive from primary address OR a subaddress (bridge routes both)
          const pressed     = activeFromBitmask(body[1]);
          const released    = activeFromBitmask(body[2]);
          const longPressed = activeFromBitmask(body[3]);
          const on = pressed.length > 0 || longPressed.length > 0;

          // Determine channel offset from source address
          // Primary=ch1-8, sub1=ch9-16, sub2=ch17-24, sub3=ch25-32
          // Bridge delivers all under primary address via subaddress routing
          // We receive the raw packet, so p.addr tells us the source
          // For now emit raw bitmask channels 1-8 — subaddress offsetting
          // requires knowing which subaddress fired (handled via p.addr)
          const srcAddr = p.addr;
          const payload = {
            type:        'channel',
            on,
            pressed,
            released,
            longPressed,
            sourceAddress: '0x' + srcAddr.toString(16).padStart(2,'0').toUpperCase(),
          };

          if (pressed.length) setStatus('ch' + pressed.join(',') + ' on');
          node.send([{ payload }, null]);
          break;
        }

        // ── 0xED  Module status (primary — 8 bytes) ───────────────────────
        case 0xED: {
          if (body.length < 8) {
            // Subaddress status — 5 bytes
            if (body.length < 5) return;
            // body[0]=0xED, body[1]=alarm channel status, body[2]=enabled,
            // body[3]=locked, body[4]=prog-disabled
            const payload = {
              type:         'sub_status',
              channels:     activeFromBitmask(body[1]),
              enabled:      activeFromBitmask(body[2]),
              locked:       activeFromBitmask(body[3]),
              progDisabled: activeFromBitmask(body[4]),
            };
            node.send([{ payload }, null]);
            return;
          }
          // Primary address — 8 bytes
          // body[0]=0xED, body[1]=channel status, body[2]=enabled/disabled,
          // body[3]=normal/inverted, body[4]=locked, body[5]=prog-disabled,
          // body[6]=alarm&program, body[7]=auto-send interval
          const progByte = body[6];
          const program = ['none', 'group1', 'group2', 'group3'][progByte & 0x03];
          const alarm1Active   = !!(progByte & 0x04);
          const alarm2Active   = !!(progByte & 0x10);
          const sunriseEnabled = !!(progByte & 0x40);
          const sunsetEnabled  = !!(progByte & 0x80);

          const on = body[1] !== 0;
          const payload = {
            type:          'status',
            on,
            channels:      activeFromBitmask(body[1]),
            enabled:       activeFromBitmask(body[2]),
            normal:        activeFromBitmask(body[3]),
            locked:        activeFromBitmask(body[4]),
            progDisabled:  activeFromBitmask(body[5]),
            program,
            alarms: { alarm1Active, alarm2Active },
            sunrise: sunriseEnabled,
            sunset:  sunsetEnabled,
            autoSendInterval: body[7],
          };
          node.send([{ payload }, null]);
          break;
        }

        // ── 0xA4  Energy counter value ────────────────────────────────────
        case 0xA4: {
          if (body.length < 8) return;
          // body[0]=0xA4
          // body[1]: bits4-7=channel(0-7), bits0-3=power high nibble
          // body[2-3]: power low bytes → 20-bit total in Watts
          // body[4-7]: 32-bit energy in Wh/litres/ml
          const channel  = ((body[1] >> 4) & 0x0F) + 1;  // 1-8
          const powerHi  = body[1] & 0x0F;                // bits 19-16
          const powerW   = (powerHi << 16) | (body[2] << 8) | body[3]; // 20-bit
          const energyWh = ((body[4] << 24) | (body[5] << 16) |
                            (body[6] <<  8) |  body[7]) >>> 0;

          const payload = {
            type:      'energy',
            channel,
            powerW,
            energyWh,
          };
          node.send([null, { payload }]);
          break;
        }

        // ── 0xF0/F1/F2  Channel name parts ───────────────────────────────
        case 0xF0:
        case 0xF1:
        case 0xF2: {
          // body[0]=cmd, body[1]=channel number (1-32), body[2..]=chars
          const ch   = body[1];
          const part = cmd - 0xF0;
          if (!_nameParts[ch]) _nameParts[ch] = {};
          _nameParts[ch][part] = Array.from(body).slice(2);
          // Assemble only channel 1 name for module display name
          if (ch === 1 && part === 2) assembleName();
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

      // Request energy counter — DB2=channel bitmask (ch1-8), DB3=interval
      if (cmd === 'get_counter') {
        const chMask = parseInt(msg.payload.channels) || 0xFF;
        const interval = parseInt(msg.payload.interval) || 0;
        node.bridge.send(pkt(0xF8, node.address, [0xBD, chMask, interval]));
        return;
      }

      // Load counter — DB2=channel number (0-7), DB3=don't care, DB4-7=32-bit value
      if (cmd === 'load_counter') {
        const ch    = (parseInt(msg.payload.channel) || 1) - 1; // 0-indexed
        const value = parseInt(msg.payload.value) || 0;
        const b4 = (value >>> 24) & 0xFF;
        const b5 = (value >>> 16) & 0xFF;
        const b6 = (value >>>  8) & 0xFF;
        const b7 =  value         & 0xFF;
        node.bridge.send(pkt(0xF8, node.address, [0xAD, ch, 0x00, b4, b5, b6, b7]));
        return;
      }

      // Lock channel — DB2=channel number (1-32, 0xFF=all), 24-bit duration
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

      // Request channel name — DB2=channel number (1-32, 0xFF=all)
      if (cmd === 'get_name') {
        const ch = parseInt(msg.payload.channel) || 0xFF;
        node.bridge.send(pkt(0xF8, node.address, [0xEF, ch]));
        return;
      }

      node.warn('velbus-sensor-20: unknown cmd: ' + cmd);
    });

    // ── Cleanup ───────────────────────────────────────────────────────────

    node.on('close', function() {
      if (_nameTimer) { clearTimeout(_nameTimer); _nameTimer = null; }
      node.bridge.deregister(node.address, onPacket);
    });

    setStatus('ready', 'grey', 'dot');
  }

  RED.nodes.registerType('velbus-sensor-20', VelbusSensor20Node);
};

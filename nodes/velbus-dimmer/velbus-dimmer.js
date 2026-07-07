'use strict';

const { pkt, rtrPkt, parsePkt } = require('../../lib/velbus-utils');
const { DIMMER_TYPES, DIMMER_TYPE_IDS } = require('../../lib/dimmer-types');

module.exports = function(RED) {

  function VelbusDimmerNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;

    node.bridge       = RED.nodes.getNode(config.bridge);
    node.moduleAddr   = parseInt(config.moduleAddr, 16);
    node.startChannel = parseInt(config.startChannel) || 1;
    node.channelCount = parseInt(config.channelCount) || 1;
    node.nameOverride = config.name || '';

    if (!node.bridge) {
      node.error('velbus-dimmer: no bridge configured');
      return;
    }
    if (isNaN(node.moduleAddr) || node.moduleAddr < 1 || node.moduleAddr > 0xFE) {
      node.error('velbus-dimmer: invalid module address');
      return;
    }

    // State keyed by channel number (1-N)
    // Original series: dim value is 0-100%
    let _channelState = {};
    // { on, level (0-100), percent (0.0-100.0), relayState, thermal }

    let _moduleInfo = null;
    let _velbusName = '';
    let _nameParts  = {};
    let _blocked    = false;
    let _nameTimer  = null;

    // ── Helpers ───────────────────────────────────────────────────────────

    function addrHex(a) {
      return '0x' + a.toString(16).padStart(2, '0').toUpperCase();
    }

    function displayName() {
      if (node.nameOverride) return node.nameOverride;
      if (_velbusName)       return _velbusName;
      if (_moduleInfo)       return _moduleInfo.name;
      return addrHex(node.moduleAddr);
    }

    function statusPrefix() {
      return displayName() + ' (' + addrHex(node.moduleAddr) + ')';
    }

    function setStatus(text, fill, shape) {
      node.status({ fill: fill || 'grey', shape: shape || 'dot', text });
    }

    // Original series: dim value is 0-100 integer percentage
    function decodeModeStatus(modeByte, statusByte) {
      const mode = modeByte & 0x03;
      if (mode === 0x03) return 'forced_off';
      if (mode === 0x02) return 'forced_on';
      if (mode === 0x01) return 'inhibited';
      const s = statusByte & 0x03;
      if (s === 0x03) return 'timer_running';
      if (s === 0x01) return 'on';
      return 'off';
    }

    function decodeThermal(statusByte) {
      // bits 4-5: temp band (0=normal, 1=warm, 2=hot, 3=very hot)
      // bit 3: load type (0=leading edge, 1=trailing edge)
      // bits 1-2: error bits
      return {
        tempBand: (statusByte >> 4) & 0x03,
        loadType: (statusByte >> 3) & 0x01,
        error:    (statusByte >> 1) & 0x03
      };
    }

    // ── Name retrieval ────────────────────────────────────────────────────

    function requestName() {
      node.bridge.send(pkt(0xF8, node.moduleAddr, [0xEF, 0xFF]));
      _nameTimer = setTimeout(assembleName, 2000);
    }

    function assembleName() {
      if (_nameTimer) { clearTimeout(_nameTimer); _nameTimer = null; }
      const raw = [
        ...(_nameParts[1] || []),
        ...(_nameParts[2] || []),
        ...(_nameParts[3] || [])
      ];
      const name = raw
        .filter(c => c !== 0xFF && c !== 0x00)
        .map(c => String.fromCharCode(c))
        .join('')
        .trim();
      if (name) {
        _velbusName = name;
        node.log('velbus-dimmer: module name: ' + name);
      }
      requestStatus();
    }

    function requestStatus() {
      // Original series: 0xFA + channel bit
      const typeInfo = _moduleInfo;
      if (typeInfo && typeInfo.channelModel === 'single') {
        node.bridge.send(pkt(0xFB, node.moduleAddr, [0xFA, 0x01]));
      } else {
        // VMB4DC — request each channel
        for (let i = 0; i < node.channelCount; i++) {
          const ch    = node.startChannel + i;
          const chBit = 1 << (ch - 1);
          node.bridge.send(pkt(0xFB, node.moduleAddr, [0xFA, chBit]));
        }
      }
      setStatus(statusPrefix() + ' online', 'grey');
    }

    // ── 0xFF Firmware check ───────────────────────────────────────────────

    function handleModuleType(body) {
      const typeId = body[1];

      if (!DIMMER_TYPE_IDS.has(typeId)) {
        const msg = '⚠ ' + statusPrefix() + ' unknown type ' + addrHex(typeId);
        setStatus(msg, 'red');
        node.error('velbus-dimmer: ' + msg);
        node.send([null, { payload: {
          topic:   'module_unknown',
          address: addrHex(node.moduleAddr),
          typeId:  addrHex(typeId),
          message: 'Unrecognised module type — is this the right node? For -20 series use velbus-dimmer-20'
        }}]);
        _blocked = true;
        return;
      }

      const typeInfo = DIMMER_TYPES[typeId];
      const serial   = body.length >= 4 ? (body[2] << 8 | body[3]) : null;
      const mapVer   = body.length >= 5 ? body[4] : null;
      const buildHi  = body.length >= 6 ? body[5] : null;
      const buildLo  = body.length >= 7 ? body[6] : null;
      const build    = (buildHi !== null && buildLo !== null)
                       ? (buildHi * 100 + buildLo) : null;

      _moduleInfo = { ...typeInfo, typeId, serial, build, memoryMapVersion: mapVer };

      const minVer = typeInfo.minMemoryMapVersion;
      if (minVer !== null && mapVer !== null && mapVer < minVer) {
        const msg = '⚠ ' + statusPrefix() + ' firmware too old (map v' + mapVer + ', need v' + minVer + ')';
        setStatus(msg, 'red');
        node.error('velbus-dimmer: ' + msg);
        node.send([null, { payload: {
          topic:            'firmware_incompatible',
          address:          addrHex(node.moduleAddr),
          module:           typeInfo.name,
          memoryMapVersion: mapVer,
          minimumRequired:  minVer,
          message:          'Firmware too old — update module firmware before use'
        }}]);
        _blocked = true;
        return;
      }

      if (minVer === null) {
        setStatus(statusPrefix() + ' map v' + mapVer + ' (unverified)', 'yellow');
        node.warn('velbus-dimmer: ' + addrHex(node.moduleAddr) + ' ' + typeInfo.name +
          ' map v' + mapVer + ' — minimum version unverified, proceeding');
      }

      _blocked = false;

      node.send([{ payload: {
        topic:            'module_online',
        address:          addrHex(node.moduleAddr),
        module:           typeInfo.name,
        typeId:           addrHex(typeId),
        channels:         typeInfo.channels,
        serial,
        build,
        memoryMapVersion: mapVer
      }}, null]);

      node.log('velbus-dimmer: ' + typeInfo.name + ' at ' + addrHex(node.moduleAddr) +
        ' serial ' + (serial ? serial.toString(16).toUpperCase() : '?') +
        ' build ' + build + ' map v' + mapVer);

      requestName();
    }

    // ── Packet handler ────────────────────────────────────────────────────

    function onPacket(raw) {
      const p = parsePkt(raw);
      if (!p) return;
      const { body, cmd, rtr } = p;

      if (cmd === 0xFF && !rtr && body.length >= 2) {
        handleModuleType(body);
        return;
      }

      if (_blocked) return;

      if ((cmd === 0xF0 || cmd === 0xF1 || cmd === 0xF2) && body.length >= 2) {
        const part = cmd - 0xEF;
        _nameParts[part] = body.slice(2);
        if (part === 3) assembleName();
        return;
      }

      // ── 0xB8 Dimmer status (original series) ─────────────────────────
      // byte 1: cmd (0xB8)
      // byte 2: channel bit (VMBDMI/R: 0x01; VMB4DC: bitmask)
      // byte 3: mode/status byte
      // byte 4: dim value 0-100
      // byte 5: status byte 2 (VMBDMI/R: thermal; VMB4DC: unused)
      // bytes 6-7: timer high/low (16-bit seconds)
      if (cmd === 0xB8 && body.length >= 5) {
        const typeInfo   = _moduleInfo;
        const chByte     = body[1];
        const modeByte   = body[2];
        const dimValue   = body[3]; // 0-100
        const statusByte = body[4];
        const timerSec   = body.length >= 7 ? ((body[5] << 8) | body[6]) : 0;
        const relayState = decodeModeStatus(modeByte, statusByte);

        if (typeInfo && typeInfo.channelModel === 'single') {
          // VMBDMI / VMBDMI-R — single channel, chByte always 0x01
          const ch = 1;
          if (ch < node.startChannel || ch >= node.startChannel + node.channelCount) return;

          const thermal = typeInfo.hasThermal ? decodeThermal(statusByte) : null;
          _channelState[ch] = {
            on:           dimValue > 0 && relayState === 'on',
            level:        dimValue,
            percent:      dimValue * 1.0,
            relayState,
            timerRemaining: timerSec,
            thermal
          };

          const isWarning = ['forced_on', 'forced_off', 'inhibited'].includes(relayState);
          setStatus(statusPrefix() + ' ' + (dimValue > 0 ? dimValue + '%' : 'off'),
            isWarning ? 'yellow' : (dimValue > 0 ? 'green' : 'grey'));

          node.send([{ payload: {
            topic:          'dimmer_status',
            address:        addrHex(node.moduleAddr),
            module:         displayName(),
            channel:        ch,
            state:          relayState,
            on:             dimValue > 0 && relayState === 'on',
            level:          dimValue,
            percent:        dimValue * 1.0,
            timerRemaining: timerSec,
            thermal,
            timestamp:      Date.now()
          }}, isWarning ? { payload: {
            topic:   'dimmer_state_warning',
            address: addrHex(node.moduleAddr),
            module:  displayName(),
            channel: ch,
            state:   relayState,
            message: 'Channel ' + ch + ' is in ' + relayState
          }} : null]);

        } else {
          // VMB4DC — chByte is a bitmask
          for (let i = 0; i < 4; i++) {
            const b  = 1 << i;
            const ch = i + 1;
            if (!(chByte & b)) continue;
            if (ch < node.startChannel || ch >= node.startChannel + node.channelCount) continue;

            _channelState[ch] = {
              on:      dimValue > 0 && relayState === 'on',
              level:   dimValue,
              percent: dimValue * 1.0,
              relayState,
              timerRemaining: timerSec
            };

            const isWarning = ['forced_on', 'forced_off', 'inhibited'].includes(relayState);
            setStatus(statusPrefix() + ' ch' + ch + ' ' + (dimValue > 0 ? dimValue + '%' : 'off'),
              isWarning ? 'yellow' : (dimValue > 0 ? 'green' : 'grey'));

            node.send([{ payload: {
              topic:          'dimmer_status',
              address:        addrHex(node.moduleAddr),
              module:         displayName(),
              channel:        ch,
              state:          relayState,
              on:             dimValue > 0 && relayState === 'on',
              level:          dimValue,
              percent:        dimValue * 1.0,
              timerRemaining: timerSec,
              timestamp:      Date.now()
            }}, isWarning ? { payload: {
              topic:   'dimmer_state_warning',
              address: addrHex(node.moduleAddr),
              module:  displayName(),
              channel: ch,
              state:   relayState,
              message: 'Channel ' + ch + ' is in ' + relayState
            }} : null]);
          }
        }
      }
    }

    // ── Input: command encoder ────────────────────────────────────────────

    node.on('input', function(msg) {
      if (_blocked) {
        node.warn('velbus-dimmer: commands blocked — firmware incompatible or unknown module');
        return;
      }

      const inp = msg.payload;
      if (!inp || typeof inp !== 'object') return;

      const addr = inp.address !== undefined
        ? (typeof inp.address === 'string' ? parseInt(inp.address, 16) : inp.address)
        : node.moduleAddr;

      const typeInfo = _moduleInfo;

      // Channel handling:
      // VMBDMI/R: single channel, chBit always 0x01
      // VMB4DC: bitmask, or 0xFF for all
      let chBit;
      if (typeInfo && typeInfo.channelModel === 'single') {
        chBit = 0x01;
      } else if (inp.channel === 'all' || inp.channel === 0 || inp.channel === 255) {
        chBit = 0x0F; // all 4 channels
      } else if (typeof inp.channel === 'number' && inp.channel >= 1 && inp.channel <= 4) {
        chBit = 1 << (inp.channel - 1);
      } else {
        node.warn('velbus-dimmer: missing or invalid channel');
        return;
      }

      const cmd      = inp.cmd || '';
      const dur      = inp.duration || 0;
      const dimspeed = inp.dimspeed || 0; // 16-bit seconds

      function clampPct(v) {
        return Math.max(0, Math.min(100, Math.round(v)));
      }

      function timer16(sec) {
        if (!sec || sec === 0) return [0, 0];
        if (sec < 0) return [0xFF, 0xFF];
        return [(sec >> 8) & 0xFF, sec & 0xFF];
      }

      const s16 = timer16(dimspeed);

      function timer24(sec) {
        if (!sec || sec === 0) return [0, 0, 0];
        if (sec < 0) return [0xFF, 0xFF, 0xFF];
        return [(sec >> 16) & 0xFF, (sec >> 8) & 0xFF, sec & 0xFF];
      }

      const t = timer24(dur);
      let packet = null;

      switch (cmd) {
        case 'set': {
          let level;
          if (typeof inp.level === 'number') {
            level = clampPct(inp.level);
          } else if (typeof inp.percent === 'number') {
            level = clampPct(inp.percent);
          } else {
            node.warn('velbus-dimmer: set command requires level or percent (0-100)');
            return;
          }
          packet = pkt(0xF8, addr, [0x07, chBit, level, ...s16]);
          break;
        }
        case 'on': {
          if (inp.level !== undefined || inp.percent !== undefined) {
            const level = clampPct(inp.level !== undefined ? inp.level : inp.percent);
            packet = pkt(0xF8, addr, [0x07, chBit, level, ...s16]);
          } else {
            packet = pkt(0xF8, addr, [0x11, chBit, ...s16]);
          }
          break;
        }
        case 'off':
          packet = pkt(0xF8, addr, [0x07, chBit, 0x00, ...s16]);
          break;
        case 'restore':
          packet = pkt(0xF8, addr, [0x11, chBit, ...s16]);
          break;
        case 'timer':
          packet = pkt(0xF8, addr, [0x08, chBit, ...t]);
          break;
        case 'forced_on':
          packet = pkt(0xF8, addr, [0x14, chBit, ...t]);
          break;
        case 'forced_off':
          packet = pkt(0xF8, addr, [0x12, chBit, ...t]);
          break;
        case 'cancel_forced_on':
          packet = pkt(0xF8, addr, [0x15, chBit]);
          break;
        case 'cancel_forced_off':
          packet = pkt(0xF8, addr, [0x13, chBit]);
          break;
        case 'inhibit':
          packet = pkt(0xF8, addr, [0x16, chBit, ...t]);
          break;
        case 'cancel_inhibit':
          packet = pkt(0xF8, addr, [0x17, chBit]);
          break;
        case 'stop':
          packet = pkt(0xF8, addr, [0x10, chBit]);
          break;
        case 'status':
          packet = pkt(0xFB, node.moduleAddr, [0xFA, chBit]);
          break;
        default:
          node.warn('velbus-dimmer: unknown command: ' + cmd);
          return;
      }

      if (packet) node.bridge.send(packet);
    });

    // ── Startup ───────────────────────────────────────────────────────────

    node.bridge.register(node.moduleAddr, onPacket);

    setTimeout(() => {
      node.bridge.send(rtrPkt(node.moduleAddr), true);
    }, 500);

    setStatus('connecting…', 'grey');

    // ── Cleanup ───────────────────────────────────────────────────────────

    node.on('close', function() {
      if (_nameTimer) clearTimeout(_nameTimer);
      node.bridge.deregister(node.moduleAddr, onPacket);
    });
  }

  RED.nodes.registerType('velbus-dimmer', VelbusDimmerNode);
};

'use strict';

const { pkt, rtrPkt, parsePkt } = require('../../lib/velbus-utils');
const { DIMMER_TYPES_20, DIMMER_TYPE_IDS_20, LEDPWM_TYPE_IDS, DEVICE_TYPE_NAMES } = require('../../lib/dimmer-types-20');

module.exports = function(RED) {

  function VelbusDimmer20Node(config) {
    RED.nodes.createNode(this, config);
    const node = this;

    node.bridge       = RED.nodes.getNode(config.bridge);
    node.moduleAddr   = parseInt(config.moduleAddr, 16);
    node.startChannel = parseInt(config.startChannel) || 1;
    node.channelCount = parseInt(config.channelCount) || 4;
    node.nameOverride = config.name || '';
    node.ledMode      = config.ledMode || 'single'; // VMB4LEDPWM-20 only

    if (!node.bridge) {
      node.error('velbus-dimmer-20: no bridge configured');
      return;
    }
    if (isNaN(node.moduleAddr) || node.moduleAddr < 1 || node.moduleAddr > 0xFE) {
      node.error('velbus-dimmer-20: invalid module address');
      return;
    }

    // State keyed by channel number (1-N)
    let _channelState = {};
    // { on, level, percent, inhibited, forcedOn, forcedOff, programDisabled, error }

    let _moduleInfo   = null;
    let _velbusName   = '';
    let _nameParts    = {};
    let _blocked      = false;
    let _nameTimer    = null;
    let _alarmProgram = null;

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

    // Convert raw 0-254 to percentage 0.0-100.0
    function rawToPercent(raw) {
      return Math.round((raw / 254) * 1000) / 10; // one decimal place
    }

    function channelStateStr(s) {
      if (!s) return 'unknown';
      if (s.forcedOff)  return 'forced_off';
      if (s.forcedOn)   return 'forced_on';
      if (s.inhibited)  return 'inhibited';
      if (s.error)      return 'error';
      return s.on ? 'on' : 'off';
    }

    function decodeAlarmProgram(b) {
      return {
        program:      b & 0x03,
        alarm1:       !!(b & 0x04),
        alarm1Global: !!(b & 0x08),
        alarm2:       !!(b & 0x10),
        alarm2Global: !!(b & 0x20),
        sunrise:      !!(b & 0x40),
        sunset:       !!(b & 0x80)
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
        node.log('velbus-dimmer-20: module name: ' + name);
      }
      requestStatus();
    }

    function requestStatus() {
      // 0xFA + 0x00 requests full module status
      node.bridge.send(pkt(0xFB, node.moduleAddr, [0xFA, 0x00]));
      setStatus(statusPrefix() + ' online', 'grey');
    }

    // ── 0xFF Firmware check ───────────────────────────────────────────────

    function handleModuleType(body) {
      const typeId = body[1];

      if (!DIMMER_TYPE_IDS_20.has(typeId)) {
        const msg = '⚠ ' + statusPrefix() + ' unknown type ' + addrHex(typeId);
        setStatus(msg, 'red');
        node.error('velbus-dimmer-20: ' + msg);
        node.send([null, { payload: {
          topic:   'module_unknown',
          address: addrHex(node.moduleAddr),
          typeId:  addrHex(typeId),
          message: 'Unrecognised module type — is this a -20 series dimmer/output module?'
        }}]);
        _blocked = true;
        return;
      }

      const typeInfo = DIMMER_TYPES_20[typeId];
      const serial   = body.length >= 4 ? (body[2] << 8 | body[3]) : null;
      const mapVer   = body.length >= 5 ? body[4] : null;
      const buildHi  = body.length >= 6 ? body[5] : null;
      const buildLo  = body.length >= 7 ? body[6] : null;
      const build    = (buildHi !== null && buildLo !== null)
                       ? (buildHi * 100 + buildLo) : null;
      const props    = body.length >= 8 ? body[7] : null;
      const canFD    = props !== null ? !!(props & 0x20) : false;

      _moduleInfo = { ...typeInfo, typeId, serial, build, memoryMapVersion: mapVer, canFD };

      const minVer = typeInfo.minMemoryMapVersion;
      if (minVer !== null && mapVer !== null && mapVer < minVer) {
        const msg = '⚠ ' + statusPrefix() + ' firmware too old (map v' + mapVer + ', need v' + minVer + ')';
        setStatus(msg, 'red');
        node.error('velbus-dimmer-20: ' + msg);
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
        node.warn('velbus-dimmer-20: ' + addrHex(node.moduleAddr) + ' ' + typeInfo.name +
          ' map v' + mapVer + ' — minimum version unverified, proceeding');
      }

      _blocked = false;

      node.send([{ payload: {
        topic:            'module_online',
        address:          addrHex(node.moduleAddr),
        module:           typeInfo.name,
        typeId:           addrHex(typeId),
        outputType:       typeInfo.outputType,
        dimCurve:         typeInfo.dimCurve,
        channels:         typeInfo.channels,
        serial,
        build,
        memoryMapVersion: mapVer,
        canFD,
        ledMode: LEDPWM_TYPE_IDS.has(typeId) ? node.ledMode : null
      }}, null]);

      node.log('velbus-dimmer-20: ' + typeInfo.name + ' at ' + addrHex(node.moduleAddr) +
        ' serial ' + (serial ? serial.toString(16).toUpperCase() : '?') +
        ' build ' + build + ' map v' + mapVer +
        ' (' + typeInfo.outputType + ', ' + typeInfo.dimCurve + ')');

      requestName();
    }

    // ── Emit channel state message ────────────────────────────────────────

    function emitChannel(ch) {
      const s     = _channelState[ch];
      if (!s) return;
      const state = channelStateStr(s);
      const isActive  = s.on && !s.forcedOff && !s.inhibited;
      const isWarning = ['forced_off', 'inhibited', 'error'].includes(state);
      const isForcedOn = state === 'forced_on';

      setStatus(statusPrefix() + ' ch' + ch + ' ' + (s.on ? Math.round(s.percent) + '%' : 'off'),
        isWarning ? 'yellow' : (isActive || isForcedOn ? 'green' : 'grey'));

      const typeInfo = _moduleInfo || {};
      const payload = {
        topic:          'dimmer_status',
        address:        addrHex(node.moduleAddr),
        module:         displayName(),
        outputType:     typeInfo.outputType || null,
        dimCurve:       typeInfo.dimCurve   || null,
        channel:        ch,
        state,
        on:             s.on,
        level:          s.level,
        percent:        s.percent,
        inhibited:      s.inhibited,
        forcedOn:       s.forcedOn,
        forcedOff:      s.forcedOff,
        programDisabled:s.programDisabled,
        error:          s.error,
        alarmProgram:   _alarmProgram,
        timestamp:      Date.now()
      };

      let warnMsg = null;
      if (isWarning) {
        warnMsg = {
          topic:   'dimmer_state_warning',
          address: addrHex(node.moduleAddr),
          module:  displayName(),
          channel: ch,
          state,
          message: 'Channel ' + ch + ' is in ' + state + ' — commands may be ignored by module'
        };
      }

      node.send([{ payload }, warnMsg ? { payload: warnMsg } : null]);
    }

    // ── Packet handler ────────────────────────────────────────────────────

    function onPacket(raw) {
      const p = parsePkt(raw);
      if (!p) return;
      const { body, cmd, rtr } = p;

      // ── 0xFF Module type ──────────────────────────────────────────────
      if (cmd === 0xFF && !rtr && body.length >= 2) {
        handleModuleType(body);
        return;
      }

      if (_blocked) return;

      // ── 0xF0/0xF1/0xF2 Name parts ────────────────────────────────────
      if ((cmd === 0xF0 || cmd === 0xF1 || cmd === 0xF2) && body.length >= 2) {
        const part = cmd - 0xEF;
        _nameParts[part] = body.slice(2);
        if (part === 3) assembleName();
        return;
      }

      // ── 0xEE Module status (V2 dimmer bitmask format) ─────────────────
      // byte 1: cmd (0xEE)
      // byte 2: ch 1-8 on/off bitmask
      // byte 3: ch 1-8 inhibited bitmask
      // byte 4: ch 1-8 forced_on bitmask
      // byte 5: ch 1-8 forced_off bitmask
      // byte 6: ch 1-8 program disabled bitmask
      // byte 7: ch 1-8 error bitmask
      // byte 8: alarm & program selection
      if (cmd === 0xEE && body.length >= 8) {
        const onBits        = body[1];
        const inhibBits     = body[2];
        const forcedOnBits  = body[3];
        const forcedOffBits = body[4];
        const progDisBits   = body[5];
        const errorBits     = body[6];
        const alarmProg     = body[7];

        _alarmProgram = decodeAlarmProgram(alarmProg);

        for (let i = 0; i < 8; i++) {
          const ch = i + 1;
          if (ch < node.startChannel || ch >= node.startChannel + node.channelCount) continue;
          const b = 1 << i;

          const prev = _channelState[ch] || {};
          _channelState[ch] = {
            on:             !!(onBits & b),
            level:          prev.level   !== undefined ? prev.level   : 0,
            percent:        prev.percent !== undefined ? prev.percent : 0,
            inhibited:      !!(inhibBits & b),
            forcedOn:       !!(forcedOnBits & b),
            forcedOff:      !!(forcedOffBits & b),
            programDisabled:!!(progDisBits & b),
            error:          !!(errorBits & b)
          };
          emitChannel(ch);
        }
        return;
      }

      // ── 0xE8 Device settings reply (settings API) ──────────────────────
      // Reply to a 0xE7 device settings request. Used here to read the
      // per-channel "Device Type" (settings index 25) that determines
      // VMB4LEDPWM-20 grouping mode — see A.0.2 in the commissioning
      // roadmap Appendix A and the doc comment in dimmer-types-20.js.
      // byte 1: cmd (0xE8)
      // byte 2: channel (1-4)
      // byte 3: setting index
      // byte 4: value
      if (cmd === 0xE8 && body.length >= 4) {
        const dtChannel    = body[1];
        const settingIndex = body[2];
        const value        = body[3];

        if (settingIndex === 25) {
          const deviceType     = value;
          const deviceTypeName = DEVICE_TYPE_NAMES[deviceType] ||
            ('unknown (' + addrHex(deviceType) + ')');

          let detectedGroupMode = null;
          if (LEDPWM_TYPE_IDS.has(_moduleInfo && _moduleInfo.typeId)) {
            if (deviceType === 0x08)      detectedGroupMode = 'rgbw';
            else if (deviceType === 0xF0) detectedGroupMode = 'rgb';
            else                          detectedGroupMode = 'single';
          }

          node.log('velbus-dimmer-20: ' + statusPrefix() + ' ch' + dtChannel +
            ' device type ' + addrHex(deviceType) + ' (' + deviceTypeName + ')' +
            (detectedGroupMode ? ' — detected grouping mode: ' + detectedGroupMode : ''));

          const payload = {
            topic:            'device_type',
            address:          addrHex(node.moduleAddr),
            module:           displayName(),
            channel:          dtChannel,
            settingIndex,
            deviceType:       addrHex(deviceType),
            deviceTypeName,
            detectedGroupMode
          };

          let warnMsg = null;
          if (detectedGroupMode && dtChannel === 1 && detectedGroupMode !== node.ledMode) {
            const msg = 'Node config ledMode ("' + node.ledMode + '") does not match ' +
              statusPrefix() + '\u2019s actual Device Type setting ("' + detectedGroupMode +
              '"). Update the node config to match, or re-check the physical wiring.';
            warnMsg = {
              topic:              'ledmode_mismatch',
              address:            addrHex(node.moduleAddr),
              module:             displayName(),
              configuredLedMode:  node.ledMode,
              detectedGroupMode,
              message:            msg
            };
            node.warn('velbus-dimmer-20: ' + msg);
          }

          node.send([{ payload }, warnMsg ? { payload: warnMsg } : null]);
        }
        return;
      }

      // ── 0xA5 Dim level (up to 4 channels packed) ──────────────────────
      // byte 1: cmd (0xA5)
      // byte 2: channel number (1-based)
      // byte 3: dim value (0-254)
      // (repeated for up to 4 channels: bytes 4+5, 6+7, 8+9)
      if (cmd === 0xA5 && body.length >= 3) {
        let i = 1;
        while (i + 1 < body.length) {
          const ch  = body[i];
          const val = body[i + 1];
          i += 2;

          if (ch < node.startChannel || ch >= node.startChannel + node.channelCount) continue;
          if (ch < 1 || ch > 8) continue;

          const pct = rawToPercent(val);
          if (_channelState[ch]) {
            _channelState[ch].level   = val;
            _channelState[ch].percent = pct;
            _channelState[ch].on      = val > 0;
          } else {
            _channelState[ch] = {
              on: val > 0, level: val, percent: pct,
              inhibited: false, forcedOn: false, forcedOff: false,
              programDisabled: false, error: false
            };
          }
          emitChannel(ch);
        }
        return;
      }

      // ── 0x00 Dim level broadcast (spontaneous) ────────────────────────
      // Sent when a dim level changes (button press, scene, timer etc.)
      // Same format as 0xA5
      if (cmd === 0x00 && body.length >= 3) {
        let i = 1;
        while (i + 1 < body.length) {
          const ch  = body[i];
          const val = body[i + 1];
          i += 2;

          if (ch < node.startChannel || ch >= node.startChannel + node.channelCount) continue;
          if (ch < 1 || ch > 8) continue;

          const pct = rawToPercent(val);
          if (_channelState[ch]) {
            _channelState[ch].level   = val;
            _channelState[ch].percent = pct;
            _channelState[ch].on      = val > 0;
          } else {
            _channelState[ch] = {
              on: val > 0, level: val, percent: pct,
              inhibited: false, forcedOn: false, forcedOff: false,
              programDisabled: false, error: false
            };
          }
          emitChannel(ch);
        }
      }
    }

    // ── Input: command encoder ────────────────────────────────────────────

    node.on('input', function(msg) {
      if (_blocked) {
        node.warn('velbus-dimmer-20: commands blocked — firmware incompatible or unknown module');
        return;
      }

      const inp = msg.payload;
      if (!inp || typeof inp !== 'object') return;

      const addr = inp.address !== undefined
        ? (typeof inp.address === 'string' ? parseInt(inp.address, 16) : inp.address)
        : node.moduleAddr;

      // Channel: 1-N, or 'all'/0/255 for all channels
      let ch;
      if (inp.channel === 'all' || inp.channel === 0 || inp.channel === 255) {
        ch = 0xFF;
      } else if (typeof inp.channel === 'number' && inp.channel >= 1 && inp.channel <= 8) {
        ch = inp.channel;
      } else {
        node.warn('velbus-dimmer-20: missing or invalid channel');
        return;
      }

      const cmd     = inp.cmd || '';
      const dur     = inp.duration || 0;
      const fadeMode = typeof inp.fadeMode === 'number' ? inp.fadeMode : 0; // 0=direct,1=rate,2=time

      function timer24(sec) {
        if (!sec || sec === 0) return [0, 0, 0];
        if (sec < 0) return [0xFF, 0xFF, 0xFF];
        return [(sec >> 16) & 0xFF, (sec >> 8) & 0xFF, sec & 0xFF];
      }

      // Clamp a level value to 0-254
      function clampLevel(v) {
        if (typeof v === 'number') return Math.max(0, Math.min(254, Math.round(v)));
        return 0;
      }

      // Convert percentage 0-100 to raw 0-254
      function pctToRaw(pct) {
        return clampLevel(Math.round((pct / 100) * 254));
      }

      const t = timer24(dur);
      let packet = null;

      switch (cmd) {
        case 'set': {
          // Accept level (raw 0-254) or percent (0-100)
          let raw;
          if (typeof inp.level === 'number') {
            raw = clampLevel(inp.level);
          } else if (typeof inp.percent === 'number') {
            raw = pctToRaw(inp.percent);
          } else {
            node.warn('velbus-dimmer-20: set command requires level (0-254) or percent (0-100)');
            return;
          }
          packet = pkt(0xF8, addr, [0x07, ch, raw, fadeMode]);
          break;
        }
        case 'on': {
          // Restore to last non-zero level — send 0xFA level request (module restores)
          // Or if a level/percent is provided, use that
          if (inp.level !== undefined || inp.percent !== undefined) {
            const raw = inp.level !== undefined ? clampLevel(inp.level) : pctToRaw(inp.percent);
            packet = pkt(0xF8, addr, [0x07, ch, raw, fadeMode]);
          } else {
            packet = pkt(0xF8, addr, [0x11, ch]); // restore last level
          }
          break;
        }
        case 'off':
          packet = pkt(0xF8, addr, [0x07, ch, 0x00, fadeMode]);
          break;
        case 'restore':
          packet = pkt(0xF8, addr, [0x11, ch]);
          break;
        case 'timer':
          packet = pkt(0xF8, addr, [0x08, ch, ...t]);
          break;
        case 'forced_on':
          packet = pkt(0xF8, addr, [0x14, ch, ...t]);
          break;
        case 'forced_off':
          packet = pkt(0xF8, addr, [0x12, ch, ...t]);
          break;
        case 'cancel_forced_on':
          packet = pkt(0xF8, addr, [0x15, ch]);
          break;
        case 'cancel_forced_off':
          packet = pkt(0xF8, addr, [0x13, ch]);
          break;
        case 'inhibit':
          packet = pkt(0xF8, addr, [0x16, ch, ...t]);
          break;
        case 'cancel_inhibit':
          packet = pkt(0xF8, addr, [0x17, ch]);
          break;
        case 'status':
          packet = pkt(0xFB, node.moduleAddr, [0xFA, 0x00]);
          break;
        case 'get_device_type':
          // Settings API read — reports actual grouping mode on output 1,
          // warns on output 2 if it disagrees with configured ledMode.
          // Read-only: never writes. See 0xE8 handler above.
          packet = pkt(0xF8, addr, [0xE7, ch, 0x00, 25]);
          break;
        case 'scene': {
          // Scenes 0-15
          const scene = typeof inp.scene === 'number' ? Math.max(0, Math.min(15, inp.scene)) : 0;
          packet = pkt(0xF8, addr, [0x1D, ch, scene]);
          break;
        }
        case 'rgbw': {
          // RGBW colour command (0x1E) — VMB4LEDPWM-20 in 'rgb' or 'rgbw' mode only
          // Requires ledMode to be set correctly in node config.
          if (!LEDPWM_TYPE_IDS.has(_moduleInfo && _moduleInfo.typeId)) {
            node.warn('velbus-dimmer-20: rgbw command is only valid for VMB4LEDPWM-20');
            return;
          }
          if (node.ledMode === 'single') {
            node.warn('velbus-dimmer-20: rgbw command sent but ledMode is set to "single".' +
              ' Update ledMode in node config to "rgb" or "rgbw" to enable colour commands.');
            return;
          }
          // R, G, B, W: accept 0-254 (raw) or 0-100 (percent via inp.percent object)
          function toRaw(v) { return Math.max(0, Math.min(254, Math.round(v))); }
          const r = typeof inp.r === 'number' ? toRaw(inp.r) : 0;
          const g = typeof inp.g === 'number' ? toRaw(inp.g) : 0;
          const b = typeof inp.b === 'number' ? toRaw(inp.b) : 0;
          const w = typeof inp.w === 'number' ? toRaw(inp.w) : 0;
          const group = typeof inp.group === 'number' ? inp.group : 0xFF; // 0xFF = all groups
          const fm    = typeof inp.fadeMode === 'number' ? inp.fadeMode : 0;
          packet = pkt(0xF8, addr, [0x1E, group, r, g, b, w, fm]);
          break;
        }
        default:
          node.warn('velbus-dimmer-20: unknown command: ' + cmd);
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

  RED.nodes.registerType('velbus-dimmer-20', VelbusDimmer20Node);
};

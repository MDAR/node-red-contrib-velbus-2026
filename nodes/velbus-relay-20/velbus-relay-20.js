'use strict';

const { pkt, rtrPkt, parsePkt } = require('../../lib/velbus-utils');
const { RELAY_TYPES_20, RELAY_TYPE_IDS_20 } = require('../../lib/relay-types-20');

module.exports = function(RED) {

  function VelbusRelay20Node(config) {
    RED.nodes.createNode(this, config);
    const node = this;

    // Config
    node.bridge       = RED.nodes.getNode(config.bridge);
    node.moduleAddr   = parseInt(config.moduleAddr, 16);
    node.startChannel = parseInt(config.startChannel) || 1;
    node.channelCount = parseInt(config.channelCount) || 4;
    node.nameOverride = config.name || '';

    if (!node.bridge) {
      node.error('velbus-relay-20: no bridge configured');
      return;
    }
    if (isNaN(node.moduleAddr) || node.moduleAddr < 1 || node.moduleAddr > 0xFE) {
      node.error('velbus-relay-20: invalid module address');
      return;
    }

    // State — V2 modules send one 0xFB packet for the whole module
    // channelState keyed by channel number (1-8)
    let _channelState = {};  // { [ch]: { on, inhibited, forcedOn, forcedOff, programDisabled, timerRunning } }
    let _moduleInfo   = null;
    let _velbusName   = '';
    let _nameParts    = {};
    let _blocked      = false;
    let _nameTimer    = null;
    let _alarmProgram = null; // byte 8 of 0xFB

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

    function channelState(chNum) {
      const s = _channelState[chNum];
      if (!s) return 'unknown';
      if (s.forcedOff)  return 'forced_off';
      if (s.forcedOn)   return 'forced_on';
      if (s.inhibited)  return 'inhibited';
      if (s.timerRunning) return 'timer_running';
      return s.on ? 'on' : 'off';
    }

    function decodeAlarmProgram(b) {
      return {
        program:       b & 0x03,           // 0=none, 1=summer, 2=winter, 3=holiday
        alarm1:        !!(b & 0x04),
        alarm1Global:  !!(b & 0x08),
        alarm2:        !!(b & 0x10),
        alarm2Global:  !!(b & 0x20),
        sunrise:       !!(b & 0x40),
        sunset:        !!(b & 0x80)
      };
    }

    // ── Name retrieval ────────────────────────────────────────────────────

    function requestName() {
      // Priority 0xF8 (command) not 0xFB (status) — critical
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
        node.log('velbus-relay-20: module name: ' + name);
      }
      requestStatus();
    }

    function requestStatus() {
      // V2: 0xFA with don't-care byte requests full module status (all channels in one 0xFB)
      node.bridge.send(pkt(0xFB, node.moduleAddr, [0xFA, 0x00]));
      setStatus(statusPrefix() + ' online', 'grey');
    }

    // ── 0xFF Firmware check ───────────────────────────────────────────────

    function handleModuleType(body) {
      const typeId = body[1];

      if (!RELAY_TYPE_IDS_20.has(typeId)) {
        const msg = '⚠ ' + statusPrefix() + ' unknown type ' + addrHex(typeId);
        setStatus(msg, 'red');
        node.error('velbus-relay-20: ' + msg);
        node.send([null, { payload: {
          topic:   'module_unknown',
          address: addrHex(node.moduleAddr),
          typeId:  addrHex(typeId),
          message: 'Unrecognised module type — is this a -20 series relay?'
        }}]);
        _blocked = true;
        return;
      }

      const typeInfo = RELAY_TYPES_20[typeId];
      const serial   = body.length >= 4 ? (body[2] << 8 | body[3]) : null;
      const mapVer   = body.length >= 5 ? body[4] : null;
      const buildHi  = body.length >= 6 ? body[5] : null;
      const buildLo  = body.length >= 7 ? body[6] : null;
      const build    = (buildHi !== null && buildLo !== null)
                       ? (buildHi * 100 + buildLo) : null;
      // Byte 8 = properties (CAN FD, terminator, HW ver)
      const props    = body.length >= 8 ? body[7] : null;
      const canFD    = props !== null ? !!(props & 0x20) : false;

      _moduleInfo = { ...typeInfo, typeId, serial, build, memoryMapVersion: mapVer, canFD };

      const minVer = typeInfo.minMemoryMapVersion;
      if (minVer !== null && mapVer !== null && mapVer < minVer) {
        const msg = '⚠ ' + statusPrefix() + ' firmware too old (map v' + mapVer + ', need v' + minVer + ')';
        setStatus(msg, 'red');
        node.error('velbus-relay-20: ' + msg);
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
        node.warn('velbus-relay-20: ' + addrHex(node.moduleAddr) + ' ' + typeInfo.name +
          ' map v' + mapVer + ' — minimum version unverified, proceeding');
      }

      _blocked = false;

      node.send([{ payload: {
        topic:            'module_online',
        address:          addrHex(node.moduleAddr),
        module:           typeInfo.name,
        typeId:           addrHex(typeId),
        serial,
        build,
        memoryMapVersion: mapVer,
        canFD
      }}, null]);

      node.log('velbus-relay-20: ' + typeInfo.name + ' at ' + addrHex(node.moduleAddr) +
        ' serial ' + (serial ? serial.toString(16).toUpperCase() : '?') +
        ' build ' + build + ' map v' + mapVer);

      requestName();
    }

    // ── Packet handler ────────────────────────────────────────────────────

    function onPacket(raw) {
      const p = parsePkt(raw);
      if (!p) return;
      const { pri, body, cmd, rtr } = p;

      // ── 0xFF Module type ─────────────────────────────────────────────────
      if (cmd === 0xFF && !rtr && body.length >= 2) {
        handleModuleType(body);
        return;
      }

      if (_blocked) return;

      // ── 0xF0/0xF1/0xF2 Channel name parts ───────────────────────────────
      if ((cmd === 0xF0 || cmd === 0xF1 || cmd === 0xF2) && body.length >= 2) {
        const part = cmd - 0xEF;
        _nameParts[part] = body.slice(2);
        if (part === 3) assembleName();
        return;
      }

      // ── 0xFB Module status (V2 bitmask format) ───────────────────────────
      // One packet covers all channels: separate bitmask bytes per condition
      if (cmd === 0xFB && body.length >= 8) {
        const onBits       = body[1];
        const inhibBits    = body[2];
        const forcedOnBits = body[3];
        const forcedOffBits= body[4];
        const progDisBits  = body[5];
        const timerBits    = body[6];
        const alarmProg    = body[7];

        _alarmProgram = decodeAlarmProgram(alarmProg);

        const changedChannels = [];

        for (let i = 0; i < 8; i++) {
          const ch = i + 1;
          if (ch < node.startChannel || ch >= node.startChannel + node.channelCount) continue;

          const b = 1 << i;
          const newState = {
            on:             !!(onBits & b),
            inhibited:      !!(inhibBits & b),
            forcedOn:       !!(forcedOnBits & b),
            forcedOff:      !!(forcedOffBits & b),
            programDisabled:!!(progDisBits & b),
            timerRunning:   !!(timerBits & b)
          };
          _channelState[ch] = newState;
          changedChannels.push(ch);
        }

        // Emit one status message per channel in range
        for (const ch of changedChannels) {
          const s     = _channelState[ch];
          const state = channelState(ch);
          const isActive = ['on','timer_running','forced_on'].includes(state);
          const isWarning = ['forced_off','inhibited'].includes(state);

          setStatus(statusPrefix() + ' ch' + ch + ' ' + state,
            isWarning ? 'yellow' : (isActive ? 'green' : 'grey'));

          const payload = {
            topic:          'relay_status',
            address:        addrHex(node.moduleAddr),
            module:         displayName(),
            channel:        ch,
            state,
            on:             s.on,
            inhibited:      s.inhibited,
            forcedOn:       s.forcedOn,
            forcedOff:      s.forcedOff,
            programDisabled:s.programDisabled,
            timerRunning:   s.timerRunning,
            alarmProgram:   _alarmProgram,
            timestamp:      Date.now()
          };

          let warnMsg = null;
          if (isWarning) {
            warnMsg = {
              topic:   'relay_state_warning',
              address: addrHex(node.moduleAddr),
              module:  displayName(),
              channel: ch,
              state,
              message: 'Channel ' + ch + ' is in ' + state + ' — direct commands will be ignored by module'
            };
          }

          node.send([{ payload }, warnMsg ? { payload: warnMsg } : null]);
        }
        return;
      }

      // ── 0x00 Channel switched broadcast ──────────────────────────────────
      // Fires on local push-button-driven switches. Confirmed against
      // protocol_vmb4ryld_20_vmb4ryno_20_vmb1rys_20.pdf: SID10-SID9=00 =
      // highest priority = 0xF8 (see packetprotocol README priority table).
      // The previous `pri === 0xFB` check required the opposite (lowest
      // priority) and silently dropped every one of these broadcasts —
      // nothing else in this file gates on priority, and this cmd byte has
      // only one defined meaning for a relay module, so no filter is needed.
      if (cmd === 0x00 && body.length >= 4) {
        const onBits  = body[1];
        const offBits = body[2];

        for (let i = 0; i < 8; i++) {
          const b  = 1 << i;
          const ch = i + 1;
          if (ch < node.startChannel || ch >= node.startChannel + node.channelCount) continue;

          if (onBits & b) {
            node.send([{ payload: {
              topic: 'relay_switched', address: addrHex(node.moduleAddr),
              module: displayName(), channel: ch, state: 'on'
            }}, null]);
          }
          if (offBits & b) {
            node.send([{ payload: {
              topic: 'relay_switched', address: addrHex(node.moduleAddr),
              module: displayName(), channel: ch, state: 'off'
            }}, null]);
          }
        }
      }
    }

    // ── Input: command encoder ────────────────────────────────────────────
    // V2: channel is a number (1-8) or 0xFF for all — NOT a bitmask

    node.on('input', function(msg) {
      if (_blocked) {
        node.warn('velbus-relay-20: commands blocked — firmware incompatible or unknown module');
        return;
      }

      const inp = msg.payload;
      if (!inp || typeof inp !== 'object') return;

      const addr = inp.address !== undefined
        ? (typeof inp.address === 'string' ? parseInt(inp.address, 16) : inp.address)
        : node.moduleAddr;

      // Channel: 1-8, or 0 / 'all' / 255 for broadcast to all channels
      let ch;
      if (inp.channel === 'all' || inp.channel === 0 || inp.channel === 255) {
        ch = 0xFF;
      } else if (typeof inp.channel === 'number' && inp.channel >= 1 && inp.channel <= 8) {
        ch = inp.channel;
      } else {
        node.warn('velbus-relay-20: missing or invalid channel in command');
        return;
      }

      const cmd = inp.cmd || '';
      const dur = inp.duration || 0;

      // Warn if specific channel is in forced/inhibited state
      if (ch !== 0xFF) {
        const cs = _channelState[ch];
        if (cs) {
          const state = channelState(ch);
          if (['forced_on', 'forced_off', 'inhibited'].includes(state)) {
            const cancelCmds = ['cancel_forced_on', 'cancel_forced_off', 'cancel_inhibit',
                                'forced_on', 'forced_off', 'inhibit'];
            if (!cancelCmds.includes(cmd)) {
              node.warn('velbus-relay-20 ' + addrHex(addr) + ' ch' + ch +
                ': channel is in ' + state + ' — command may be ignored by module');
            }
          }
        }
      }

      function timer24(sec) {
        if (!sec || sec === 0) return [0, 0, 0];
        if (sec < 0) return [0xFF, 0xFF, 0xFF];
        return [(sec >> 16) & 0xFF, (sec >> 8) & 0xFF, sec & 0xFF];
      }

      const t = timer24(dur);
      let packet = null;

      switch (cmd) {
        case 'on':                packet = pkt(0xF8, addr, [0x02, ch]);         break;
        case 'off':               packet = pkt(0xF8, addr, [0x01, ch]);         break;
        case 'toggle': {
          const cs = ch !== 0xFF ? _channelState[ch] : null;
          const isOn = cs && cs.on;
          packet = pkt(0xF8, addr, [isOn ? 0x01 : 0x02, ch]);
          break;
        }
        case 'timer':             packet = pkt(0xF8, addr, [0x03, ch, ...t]);   break;
        case 'interval_timer':
          // REMOVED v0.7.9 — there is no live bus command for a blink/interval
          // timer on the V2 relay series. Confirmed against the official
          // protocol PDF (VMB4RYLD-20/VMB4RYNO-20/VMB1RYS-20, ed.3): the
          // received-command list has no equivalent to the original series'
          // 0x0D "Start relay blinking timer". An "interval timer running"
          // status bit exists (0xFB DATABYTE7), but it can only be triggered
          // by writing a Program Step (0xC0/0xC2, Action code 22 — Start/Stop
          // interval timer — Time-out/Pulse time/Pause time/Relay channel)
          // linked to a button or scenario. That is commissioning-agent-level
          // memory work, out of scope for this node's live command set.
          node.warn('velbus-relay-20: interval_timer is not a live bus command on V2 relays. ' +
            'It requires writing a Program Step (Action code 22) to module memory — ' +
            'see the node help for detail.');
          return;
        case 'forced_on':         packet = pkt(0xF8, addr, [0x14, ch, ...t]);   break;
        case 'forced_off':        packet = pkt(0xF8, addr, [0x12, ch, ...t]);   break;
        case 'cancel_forced_on':  packet = pkt(0xF8, addr, [0x15, ch]);         break;
        case 'cancel_forced_off': packet = pkt(0xF8, addr, [0x13, ch]);         break;
        case 'inhibit':           packet = pkt(0xF8, addr, [0x16, ch, ...t]);   break;
        case 'cancel_inhibit':    packet = pkt(0xF8, addr, [0x17, ch]);         break;
        case 'status':            packet = pkt(0xFB, node.moduleAddr, [0xFA, 0x00]); break;
        default:
          node.warn('velbus-relay-20: unknown command: ' + cmd);
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

  RED.nodes.registerType('velbus-relay-20', VelbusRelay20Node);
};

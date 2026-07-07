'use strict';

const { pkt, rtrPkt, parsePkt } = require('../../lib/velbus-utils');
const { RELAY_TYPES, RELAY_TYPE_IDS } = require('../../lib/relay-types');

module.exports = function(RED) {

  function VelbusRelayNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;

    // Config
    node.bridge       = RED.nodes.getNode(config.bridge);
    node.moduleAddr   = parseInt(config.moduleAddr, 16);
    node.startChannel = parseInt(config.startChannel) || 1;
    node.channelCount = parseInt(config.channelCount) || 4;
    node.nameOverride = config.name || '';  // Node-RED label override

    if (!node.bridge) {
      node.error('velbus-relay: no bridge configured');
      return;
    }
    if (isNaN(node.moduleAddr) || node.moduleAddr < 1 || node.moduleAddr > 0xFE) {
      node.error('velbus-relay: invalid module address');
      return;
    }

    // State
    let _channelState  = {};   // { [chBit]: { relayState, ledState, timerRemaining } }
    let _moduleInfo    = null; // populated on 0xFF
    let _velbusName    = '';   // name retrieved from hardware via 0xEF
    let _nameParts     = {};   // { 1: chars1-6, 2: chars7-12, 3: chars13-16 }
    let _blocked       = false; // true if firmware check failed — hard block
    let _nameTimer     = null;

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

    function modeStr(mode, status) {
      const m = mode & 0x03;
      if (m === 0x03) return 'forced_off';
      if (m === 0x02) return 'forced_on';
      if (m === 0x01) return 'inhibited';
      const s = status & 0x03;
      if (s === 0x03) return 'timer_running';
      if (s === 0x01) return 'on';
      return 'off';
    }

    function decodeLed(ledByte) {
      if (ledByte & 0x80) return 'on';
      if (ledByte & 0x40) return 'slow_blink';
      if (ledByte & 0x20) return 'fast_blink';
      if (ledByte & 0x10) return 'very_fast_blink';
      return 'off';
    }

    function buildStateMsg(chBit, state) {
      return {
        topic:          'relay_status',
        address:        addrHex(node.moduleAddr),
        module:         displayName(),
        channel:        Math.log2(chBit) + 1,
        channelBit:     addrHex(chBit),
        state:          state.relayState,
        on:             state.relayState === 'on' || state.relayState === 'timer_running' || state.relayState === 'forced_on',
        timerRemaining: state.timerRemaining || 0,
        ledState:       state.ledState || 'off',
        timestamp:      Date.now()
      };
    }

    // ── Name retrieval ────────────────────────────────────────────────────

    function requestName() {
      // Send 0xEF with channel 0xFF = module name request
      // Priority 0xF8 (command) not 0xFB (status) — critical
      const p = pkt(0xF8, node.moduleAddr, [0xEF, 0xFF]);
      node.bridge.send(p);
      // Timeout — use whatever was received after 2s
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
        node.log('velbus-relay: module name retrieved: ' + name);
      }
      // Now request status
      requestStatus();
    }

    function requestStatus() {
      for (let i = 0; i < node.channelCount; i++) {
        const ch    = node.startChannel + i;
        const chBit = 1 << (ch - 1);
        node.bridge.send(pkt(0xFB, node.moduleAddr, [0xFA, chBit]));
      }
      setStatus(statusPrefix() + ' online', 'grey');
    }

    // ── 0xFF Firmware check ───────────────────────────────────────────────

    function handleModuleType(body) {
      const typeId = body[1];

      // Stage 1: type recognised?
      if (!RELAY_TYPE_IDS.has(typeId)) {
        const msg = '⚠ ' + statusPrefix() + ' unknown type ' + addrHex(typeId);
        setStatus(msg, 'red');
        node.error('velbus-relay: ' + msg);
        node.send([null, { payload: {
          topic:   'module_unknown',
          address: addrHex(node.moduleAddr),
          typeId:  addrHex(typeId),
          message: 'Unrecognised module type — is this the right node for this module?'
        }}]);
        _blocked = true;
        return;
      }

      const typeInfo = RELAY_TYPES[typeId];
      const serial   = body.length >= 4 ? (body[2] << 8 | body[3]) : null;
      const mapVer   = body.length >= 5 ? body[4] : null;
      const buildHi  = body.length >= 6 ? body[5] : null;
      const buildLo  = body.length >= 7 ? body[6] : null;
      const build    = (buildHi !== null && buildLo !== null)
                       ? (buildHi * 100 + buildLo) : null;

      _moduleInfo = { ...typeInfo, typeId, serial, build, memoryMapVersion: mapVer };

      // Stage 2: memory map version check
      const minVer = typeInfo.minMemoryMapVersion;
      if (minVer !== null && mapVer !== null && mapVer < minVer) {
        const msg = '⚠ ' + statusPrefix() + ' firmware too old (map v' + mapVer + ', need v' + minVer + ')';
        setStatus(msg, 'red');
        node.error('velbus-relay: ' + msg);
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

      // Stage 2b: unverified (null minimum)
      if (minVer === null) {
        setStatus(statusPrefix() + ' map v' + mapVer + ' (unverified)', 'yellow');
        node.warn('velbus-relay: ' + addrHex(node.moduleAddr) + ' ' + typeInfo.name +
          ' map v' + mapVer + ' — minimum version unverified, proceeding');
      }

      // Stage 3: pass — emit module_online, retrieve name
      _blocked = false;

      node.send([{ payload: {
        topic:            'module_online',
        address:          addrHex(node.moduleAddr),
        module:           typeInfo.name,
        typeId:           addrHex(typeId),
        serial,
        build,
        memoryMapVersion: mapVer
      }}, null]);

      node.log('velbus-relay: ' + typeInfo.name + ' at ' + addrHex(node.moduleAddr) +
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

      // All remaining packets blocked if firmware check failed
      if (_blocked) return;

      // ── 0xF0/0xF1/0xF2 Channel name parts ───────────────────────────────
      if ((cmd === 0xF0 || cmd === 0xF1 || cmd === 0xF2) && body.length >= 2) {
        const part = cmd - 0xEF; // 0xF0=1, 0xF1=2, 0xF2=3
        _nameParts[part] = body.slice(2); // skip cmd + channel bytes
        if (part === 3) assembleName();
        return;
      }

      // ── 0xFB Relay status (original series per-channel format) ───────────
      if (cmd === 0xFB && body.length >= 8) {
        const chBit     = body[1];
        const modeVal   = body[2];
        const statusVal = body[3];
        const ledByte   = body[4];
        const timerSec  = (body[5] << 16) | (body[6] << 8) | body[7];
        const relayState = modeStr(modeVal, statusVal);
        const ledState   = decodeLed(ledByte);

        const ch = Math.log2(chBit) + 1;
        if (ch < node.startChannel || ch >= node.startChannel + node.channelCount) return;

        _channelState[chBit] = { relayState, ledState, timerRemaining: timerSec };

        const stateMsg = buildStateMsg(chBit, _channelState[chBit]);
        let warnMsg = null;

        if (['forced_on', 'forced_off', 'inhibited'].includes(relayState)) {
          warnMsg = {
            topic:   'relay_state_warning',
            address: addrHex(node.moduleAddr),
            module:  displayName(),
            channel: ch,
            state:   relayState,
            message: 'Channel ' + ch + ' is in ' + relayState + ' — direct commands will be ignored by module'
          };
          setStatus(statusPrefix() + ' ch' + ch + ' ' + relayState, 'yellow');
        } else {
          setStatus(statusPrefix() + ' ch' + ch + ' ' + relayState,
            relayState === 'on' ? 'green' : 'grey');
        }

        node.send([{ payload: stateMsg }, warnMsg ? { payload: warnMsg } : null]);
        return;
      }

      // ── 0x00 Channel switched broadcast ──────────────────────────────────
      // Fires on every pulse edge during interval_timer blinking, and on
      // every local push-button-driven switch. Confirmed against
      // protocol_vmb4ryld_10.pdf: SID10-SID9=00 = highest priority = 0xF8
      // (see packetprotocol README priority table). The previous `pri ===
      // 0xFB` check required the opposite (lowest priority) and silently
      // dropped every one of these broadcasts — nothing else in this file
      // gates on priority, and this cmd byte has only one defined meaning
      // for a relay module, so no filter is needed at all.
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
              module: displayName(), channel: ch, channelBit: addrHex(b), state: 'on'
            }}, null]);
          }
          if (offBits & b) {
            node.send([{ payload: {
              topic: 'relay_switched', address: addrHex(node.moduleAddr),
              module: displayName(), channel: ch, channelBit: addrHex(b), state: 'off'
            }}, null]);
          }
        }
      }
    }

    // ── Input: command encoder ────────────────────────────────────────────

    node.on('input', function(msg) {
      if (_blocked) {
        node.warn('velbus-relay: commands blocked — firmware incompatible or unknown module');
        return;
      }

      const inp = msg.payload;
      if (!inp || typeof inp !== 'object') return;

      const addr = inp.address !== undefined
        ? (typeof inp.address === 'string' ? parseInt(inp.address, 16) : inp.address)
        : node.moduleAddr;

      let chBit;
      if (typeof inp.channel === 'number' && inp.channel >= 1 && inp.channel <= 8) {
        chBit = 1 << (inp.channel - 1);
      } else if (typeof inp.channelBit === 'number') {
        chBit = inp.channelBit;
      } else {
        node.warn('velbus-relay: missing channel in command');
        return;
      }

      const cmd = inp.cmd || '';
      const dur = inp.duration || 0;

      const cs = _channelState[chBit];
      if (cs && ['forced_on', 'forced_off', 'inhibited'].includes(cs.relayState)) {
        const cancelCmds = ['cancel_forced_on', 'cancel_forced_off', 'cancel_inhibit',
                            'forced_on', 'forced_off', 'inhibit'];
        if (!cancelCmds.includes(cmd)) {
          node.warn('velbus-relay ' + addrHex(addr) + ' ch' + inp.channel +
            ': channel is in ' + cs.relayState + ' — command may be ignored by module');
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
        case 'on':                packet = pkt(0xF8, addr, [0x02, chBit]);         break;
        case 'off':               packet = pkt(0xF8, addr, [0x01, chBit]);         break;
        case 'toggle': {
          const isOn = cs && cs.relayState === 'on';
          packet = pkt(0xF8, addr, [isOn ? 0x01 : 0x02, chBit]);
          break;
        }
        case 'timer':             packet = pkt(0xF8, addr, [0x03, chBit, ...t]);   break;
        case 'interval_timer': {
          // 'Start relay blinking timer' (0x0D) — confirmed against the official
          // protocol PDFs for every module this node covers (VMB4RYLD/-10,
          // VMB4RYNO/-10, VMB1RYNO, VMB1RYNOS, VMB1RYS): DLC=5, body is
          // [0x0D, chBit, 24-bit delay time] — ONE time parameter, not three.
          // There is no live bus command for a configurable pulse/pause rate —
          // the module blinks at its own fixed rate for the given duration.
          // duration: 0=skip (module ignores), -1 or 0xFFFFFF=permanent blinking.
          packet = pkt(0xF8, addr, [0x0D, chBit, ...t]);
          break;
        }
        case 'forced_on':         packet = pkt(0xF8, addr, [0x14, chBit, ...t]);   break;
        case 'forced_off':        packet = pkt(0xF8, addr, [0x12, chBit, ...t]);   break;
        case 'cancel_forced_on':  packet = pkt(0xF8, addr, [0x15, chBit]);         break;
        case 'cancel_forced_off': packet = pkt(0xF8, addr, [0x13, chBit]);         break;
        case 'inhibit':           packet = pkt(0xF8, addr, [0x16, chBit, ...t]);   break;
        case 'cancel_inhibit':    packet = pkt(0xF8, addr, [0x17, chBit]);         break;
        case 'status':            packet = pkt(0xFB, addr, [0xFA, chBit]);         break;
        default:
          node.warn('velbus-relay: unknown command: ' + cmd);
          return;
      }

      if (packet) node.bridge.send(packet);
    });

    // ── Startup ───────────────────────────────────────────────────────────

    node.bridge.register(node.moduleAddr, onPacket);

    // Send RTR scan after short delay — triggers 0xFF and 0xB0 from module
    // startup=true flags this as a startup packet — will be queued if scan in progress
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

  RED.nodes.registerType('velbus-relay', VelbusRelayNode);
};

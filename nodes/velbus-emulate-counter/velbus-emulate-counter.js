'use strict';

const { pkt, parsePkt } = require('../../lib/velbus-utils');

// ─────────────────────────────────────────────────────────────────────────────
// velbus-emulate-counter — emulates a VMB7IN (pulse-counting utility meter
// interface: electricity, gas, or water, via the same generic packet format).
//
// Purpose, confirmed through extensive real-world evaluation (see HANDOVER.md
// section 18): let third-party data (MQTT, Modbus, anything Node-RED can
// reach) appear on the Velbus bus as a genuine module, so VelbusLink can
// discover it, assign it to a real OLED Counter page (VMBGPOD/VMBELO), and
// display it natively — not via a single scrolling Memo-Text banner.
//
// Same module-emulator role as velbus-emulate-button-io/-dimmer: this node
// RECEIVES nothing meaningful from VelbusLink to act on (no write-back is
// expected in practice — confirmed decision, not an oversight: "I am NOT
// seeing a situation where VelbusLink would write back the settings, so
// whatever the Node is declaring, can come from its own config"), and
// TRANSMITS live counter data fed from this node's own Node-RED input.
//
// Persistence is deliberately simpler than velbus-emulate-button-io/-dimmer:
// no context()-based persistence at all. The memory image is rebuilt fresh
// from this node's own config at every startup — the config itself already
// persists via the flow's own JSON, so a second persistence layer would be
// redundant. Live counter values (cumulative + current rate) always reset
// on restart — confirmed: "values are flushed as we'd be looking at the
// upstream device to provide those or the installer will have to persist
// them" — this node's job is to relay, not to remember.
//
// Confirmed memory layout (version 3, build 1424+, applicable since the
// real confirmed build 2306 is higher): each of the 4 counters has one
// combined enable+scale byte (0 = disabled; bits 5-0 = base 1-63, ×100;
// bits 7-6 = multiplier ×1/×2.5/×0.05/×0.01) followed immediately by its
// 32-bit cumulative value, at 0x00E4/E9/EE/F3. One shared units byte
// (2 bits per counter: reserved/liter/m3/kWh) at 0x03FE. One shared
// auto-send-interval byte at 0x00F8. All confirmed by direct VLP decode
// against a real configured VMB7IN, not just the protocol document's text.
// ─────────────────────────────────────────────────────────────────────────────

const TYPE_BYTE = 0x22; // VMB7IN, confirmed from protocol_vmb7in.txt
const BUILD_YEAR = 0x23, BUILD_WEEK = 0x06; // real build 2306, confirmed from a real VLP

const MULTIPLIERS = [1, 2.5, 0.05, 0.01]; // indexed by bits 7-6 of the scale byte
const UNIT_NAMES = ['reserved', 'liter', 'm3', 'kWh'];

// Given a desired pulses-per-unit value, find the closest achievable
// (base, multiplierIndex) encoding — not every integer is exactly
// representable, confirmed from a real installation using two different
// multiplier tiers across its four counters. Returns the exact match if
// one exists, otherwise the closest achievable value with a warning flag.
function encodeScale(pulsesPerUnit) {
  if (!pulsesPerUnit || pulsesPerUnit <= 0) return { byte: 0x00, achieved: 0, exact: true }; // disabled
  let best = null;
  for (let mIdx = 0; mIdx < MULTIPLIERS.length; mIdx++) {
    for (let base = 1; base <= 63; base++) {
      const achieved = base * 100 * MULTIPLIERS[mIdx];
      const diff = Math.abs(achieved - pulsesPerUnit);
      if (!best || diff < best.diff) {
        best = { byte: (mIdx << 6) | base, achieved, diff, exact: diff < 1e-9 };
      }
      if (best.exact) break;
    }
    if (best && best.exact) break;
  }
  return best;
}

module.exports = function(RED) {
  function VelbusEmulateCounterNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;

    node.bridge = RED.nodes.getNode(config.bridge);
    node.address = parseInt(config.address, 16) || 0;
    node.serial = parseInt(config.serial, 16) || 0x0001;

    if (!node.bridge) {
      node.status({ fill: 'red', shape: 'ring', text: 'no bridge' });
      node.error('velbus-emulate-counter: no bridge configured');
      return;
    }
    if (!node.address || node.address < 1 || node.address > 254) {
      node.status({ fill: 'red', shape: 'ring', text: 'invalid address' });
      node.error('velbus-emulate-counter: invalid address ' + node.address);
      return;
    }

    const _label = (config.moduleName || 'VMB7IN') +
      ' (0x' + node.address.toString(16).padStart(2, '0').toUpperCase() + ')';

    function setStatus(text, fill, shape) {
      node.status({ fill: fill || 'blue', shape: shape || 'dot', text: _label + ' ' + text });
    }

    // ── Per-counter config, from the node's own declared settings ──────────
    const _counters = [1, 2, 3, 4].map(function(i) {
      const pulsesPerUnit = parseFloat(config['counter' + i + 'PulsesPerUnit']) || 0;
      const unit = parseInt(config['counter' + i + 'Unit']) || 0; // index into UNIT_NAMES
      const name = (config['counter' + i + 'Name'] || ('Counter ' + i)).slice(0, 16);
      const scale = encodeScale(pulsesPerUnit);
      return { enabled: scale.byte !== 0x00, scaleByte: scale.byte, unit, name, cumulative: null, currentRate: null };
    });

    // ── Auto-send mode ───────────────────────────────────────────────────
    // Real hardware: 10-255s fixed interval / 5-9s on-change-min-interval /
    // 1-4s on-change-disabled (poll-only). 'oninject' is a Node-RED-native
    // addition, not a real hardware mode — requested explicitly: "data
    // arrives at node and gets sent" with no throttling. For the STORED
    // auto-send byte (0x00F8, in case VelbusLink ever reads it), represented
    // as the closest real equivalent (on-change, 5s) since there's no real
    // byte value for "immediate, unthrottled" — the actual broadcast
    // behaviour genuinely is immediate/unthrottled regardless of what the
    // stored byte says, since nothing in this design expects VelbusLink to
    // rely on that byte's exact meaning without also receiving the broadcasts.
    const autoSendMode = config.autoSendMode || 'oninject'; // 'fixed' | 'onchange' | 'disabled' | 'oninject'
    const autoSendSeconds = Math.max(
      autoSendMode === 'fixed' ? 10 : 5,
      Math.min(autoSendMode === 'fixed' ? 255 : 9, parseInt(config.autoSendSeconds) || (autoSendMode === 'fixed' ? 60 : 5))
    );
    let _autoSendByte;
    if (autoSendMode === 'fixed') _autoSendByte = autoSendSeconds;
    else if (autoSendMode === 'onchange') _autoSendByte = autoSendSeconds;
    else if (autoSendMode === 'disabled') _autoSendByte = Math.min(4, Math.max(1, autoSendSeconds));
    else _autoSendByte = 5; // oninject — closest real-mode representation only, see comment above

    // ── Memory image — rebuilt fresh from config every startup, no
    // context()-based persistence (see the file-level comment for why).
    const _memory = new Uint8Array(1024).fill(0xFF);

    function writeName(base, name) {
      for (let i = 0; i < 16; i++) _memory[base + i] = i < name.length ? name.charCodeAt(i) : 0xFF;
    }

    (function initMemory() {
      _counters.forEach(function(c, idx) {
        writeName(idx * 0x10, c.name); // channel name block, 0x0000+
        const scaleAddr = 0x00E4 + idx * 5;
        _memory[scaleAddr] = c.scaleByte;
        // cumulative left at 0xFFFFFFFF (blank) until real data arrives —
        // matches a genuinely fresh/unconfigured module, confirmed from a
        // real VLP showing exactly this blank state before data is fed in.
      });
      _memory[0x00F8] = _autoSendByte;
      let unitsByte = 0x00;
      _counters.forEach(function(c, idx) { unitsByte |= (c.unit & 0x03) << (idx * 2); });
      _memory[0x03FE] = unitsByte;
    })();

    // ── Live data → wire format conversion ──────────────────────────────
    // Reversing the module's own documented formulas (protocol_vmb7in.txt):
    //   Counter value in Units = rawPulses / (base*100*multiplier)
    //   Power in W    = 3.6e9 / (periodMs * base*100*multiplier)   [kWh]
    //   Flow in l/h   = 3.6e6 / (periodMs * base*100*multiplier)   [liter]
    //   Flow in m3/h  = 3.6e6 / (periodMs * base*100*multiplier)   [m3]
    // The rate constant genuinely differs by 1000x between Power and Flow —
    // caught by this node's own round-trip test before shipping: an early
    // version used the Power constant universally, which gave wildly wrong
    // results for liter/m3 counters (a period value clamped to the field's
    // maximum instead of a sensible number). Fixed by keying the constant
    // to the counter's own configured unit (UNIT_NAMES index: 3=kWh uses
    // the Power constant, 1/2=liter/m3 use the Flow constant).
    function toWireValues(counter) {
      const mIdx = (counter.scaleByte >> 6) & 0x03;
      const base = counter.scaleByte & 0x3F;
      const scaleFactor = base * 100 * MULTIPLIERS[mIdx];
      const rateConstant = counter.unit === 3 ? 3600 * 1000 * 1000 : 3600 * 1000; // kWh vs liter/m3
      const rawPulses = counter.cumulative == null ? 0xFFFFFFFF :
        Math.max(0, Math.min(0xFFFFFFFF, Math.round(counter.cumulative * scaleFactor)));
      let periodMs;
      if (counter.currentRate == null || counter.currentRate <= 0) {
        periodMs = 0xFFFF; // overflow — no recent pulse / rate unavailable, matches real "no flow" behaviour
      } else {
        const raw = rateConstant / (counter.currentRate * scaleFactor);
        periodMs = Math.max(0, Math.min(0xFFFE, Math.round(raw))); // 0xFFFF reserved for overflow
      }
      return { rawPulses, periodMs };
    }

    function sendCounterStatus(idx) {
      const c = _counters[idx];
      if (!c.enabled) return;
      const base = c.scaleByte & 0x3F;
      const { rawPulses, periodMs } = toWireValues(c);
      const db2 = (base << 2) | idx; // base scale in bits 7-2, channel in bits 1-0 — confirmed
                                      // same base value as the memory byte's bits 5-0, just
                                      // shifted; the multiplier is NOT re-sent live, VelbusLink
                                      // is expected to already know it from a memory read.
      node.bridge.send(pkt(0xFB, node.address, [
        0xBE, db2,
        (rawPulses >>> 24) & 0xFF, (rawPulses >>> 16) & 0xFF, (rawPulses >>> 8) & 0xFF, rawPulses & 0xFF,
        (periodMs >> 8) & 0xFF, periodMs & 0xFF,
      ]));
    }

    function sendIdentification() {
      // 7 bytes, no terminator — confirmed same shape as VMB4DC, not VMB4PB.
      node.bridge.send(pkt(0xFB, node.address, [
        0xFF, TYPE_BYTE,
        (node.serial >> 8) & 0xFF, node.serial & 0xFF,
        0x00, // memory map version
        BUILD_YEAR, BUILD_WEEK,
      ]));
    }

    function sendMemoryBlock(addr) {
      node.bridge.send(pkt(0xFB, node.address, [
        0xCC, (addr >> 8) & 0xFF, addr & 0xFF,
        _memory[addr], _memory[addr + 1], _memory[addr + 2], _memory[addr + 3],
      ]));
    }

    function sendMemoryByte(addr) {
      node.bridge.send(pkt(0xFB, node.address, [0xFE, (addr >> 8) & 0xFF, addr & 0xFF, _memory[addr]]));
    }

    function sendMemoryDump() {
      for (let addr = 0; addr < 1024; addr += 4) sendMemoryBlock(addr);
    }

    // ── Auto-send scheduling ─────────────────────────────────────────────
    let _fixedInterval = null;
    let _lastSentAt = [0, 0, 0, 0];    // for on-change throttling
    let _lastSentValue = [null, null, null, null];

    if (autoSendMode === 'fixed') {
      _fixedInterval = setInterval(function() {
        _counters.forEach(function(c, idx) { if (c.enabled) sendCounterStatus(idx); });
      }, autoSendSeconds * 1000);
    }

    function onNewData(idx) {
      const c = _counters[idx];
      if (!c.enabled) return;

      if (autoSendMode === 'oninject') {
        sendCounterStatus(idx);
        return;
      }
      if (autoSendMode === 'disabled') {
        return; // poll-only — 0xBD is the only way to get a reading
      }
      if (autoSendMode === 'onchange') {
        const changed = c.cumulative !== _lastSentValue[idx];
        const now = Date.now();
        if (changed && (now - _lastSentAt[idx]) >= autoSendSeconds * 1000) {
          sendCounterStatus(idx);
          _lastSentAt[idx] = now;
          _lastSentValue[idx] = c.cumulative;
        }
        return;
      }
      // 'fixed' mode: data is stored, the interval timer picks it up — no
      // immediate send here, matching real hardware's fixed-interval mode.
    }

    // ── Packet handler ───────────────────────────────────────────────────
    function onPacket(raw) {
      const p = parsePkt(raw);
      if (!p) return;
      if (p.addr !== node.address) return; // pure data source, no bus-wide
                                            // listening needed — unlike
                                            // velbus-emulate-button-io/-dimmer,
                                            // this module never reacts to
                                            // other modules' events.

      if (p.rtr) { sendIdentification(); return; }

      const { cmd, body } = p;

      if (cmd === 0xBD) { // counter status request
        if (body.length < 2) return;
        const chBit = body[1];
        for (let i = 0; i < 4; i++) if (chBit & (1 << i)) sendCounterStatus(i);
        return;
      }

      if (cmd === 0xCB) { sendMemoryDump(); return; }

      if (cmd === 0xC9) {
        if (body.length < 3) return;
        const addr = (body[1] << 8) | body[2];
        if (addr > 0x03FC) return;
        sendMemoryBlock(addr);
        return;
      }

      if (cmd === 0xFD) {
        if (body.length < 3) return;
        const addr = (body[1] << 8) | body[2];
        if (addr > 0x03FF) return;
        sendMemoryByte(addr);
        return;
      }

      if (cmd === 0xFC) {
        // Accepted for robustness (matches velbus-emulate-button-io/-dimmer's
        // confirmed acknowledgment requirement) even though no write-back is
        // expected in practice for this node — costs little, avoids any risk
        // of a repeat of the "VelbusLink stalls with no ack" bug if it ever
        // does attempt something incidental (e.g. a name edit).
        if (body.length < 4) return;
        const addr = (body[1] << 8) | body[2];
        if (addr > 0x03FF) return;
        _memory[addr] = body[3];
        sendMemoryByte(addr);
        return;
      }

      if (cmd === 0xCA) {
        if (body.length < 7) return;
        const addr = (body[1] << 8) | body[2];
        if (addr > 0x03FC) return;
        _memory[addr] = body[3]; _memory[addr+1] = body[4]; _memory[addr+2] = body[5]; _memory[addr+3] = body[6];
        sendMemoryBlock(addr);
        return;
      }
    }

    node.bridge.register(node.address, onPacket);
    setStatus('ready', 'grey');

    // ── Input — live data from the harvesting flow ──────────────────────
    // { channel: 1-4, cumulative?: number, currentRate?: number } — either
    // field optional, updates only what's provided. Deliberately not a
    // rigid "must send both together" shape, since upstream MQTT/Modbus
    // sources commonly publish these as independent topics/registers
    // arriving at different times.
    node.on('input', function(msg) {
      const inp = (msg && msg.payload && typeof msg.payload === 'object') ? msg.payload : {};
      const ch = parseInt(inp.channel);
      if (!ch || ch < 1 || ch > 4) {
        node.warn('velbus-emulate-counter: input requires "channel": 1-4');
        return;
      }
      const idx = ch - 1;
      const c = _counters[idx];
      if (!c.enabled) {
        node.warn('velbus-emulate-counter: channel ' + ch + ' is not enabled in this node\'s config');
        return;
      }

      let updated = false;
      if (typeof inp.cumulative === 'number') { c.cumulative = inp.cumulative; updated = true; }
      if (typeof inp.currentRate === 'number') { c.currentRate = inp.currentRate; updated = true; }
      if (!updated) {
        node.warn('velbus-emulate-counter: input requires "cumulative" and/or "currentRate"');
        return;
      }

      setStatus('ch' + ch + ' cum=' + (c.cumulative == null ? '-' : c.cumulative) +
        ' rate=' + (c.currentRate == null ? '-' : c.currentRate), 'green');
      onNewData(idx);
    });

    node.on('close', function() {
      if (_fixedInterval) clearInterval(_fixedInterval);
      node.bridge.deregister(node.address, onPacket);
    });
  }

  RED.nodes.registerType('velbus-emulate-counter', VelbusEmulateCounterNode);
};

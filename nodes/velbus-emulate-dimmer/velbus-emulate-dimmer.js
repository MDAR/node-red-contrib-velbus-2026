'use strict';

const { pkt, parsePkt } = require('../../lib/velbus-utils');

// ─────────────────────────────────────────────────────────────────────────────
// velbus-emulate-dimmer — emulates a VMB4DC (4-channel original-series dimmer).
//
// Same role as velbus-emulate-button-io: this is a MODULE EMULATOR, playing
// the opposite side of the protocol to every controller node in this palette.
// It RECEIVES dimmer commands and TRANSMITS status, as if it were the real
// module — so VelbusLink (or any real linked module) can scan, see, and drive
// it exactly as it would real hardware.
//
// Chosen over VMB1LED specifically because it reuses the 0xB8 status format
// already implemented, debugged, and fixed in this palette's own
// velbus-dimmer.js (see HANDOVER.md section 7.5a) — VMB4DC is the simpler of
// the two 0xB8 variants (no thermal/error/load-type bits at all, confirmed
// from its own protocol document), and needs no local-button role of its own:
// velbus-emulate-button-io already covers the initiator side generically for
// any target, dimmer included, so VMB1LED's one advantage (a combined
// button+dimmer role) stops mattering once that's understood.
//
// Program *groups* (Summer/Winter/Holiday schedule-set selection) and full
// time/date scheduling are out of scope — corrected terminology, see
// HANDOVER.md section 17.3. The basic Linked Push Button action-assignment
// mechanism IS in scope and IS implemented below (see the Action-assignment
// engine section) — VelbusLink writing "button X does action Y to my
// channel Z" into this module's own memory.
// ─────────────────────────────────────────────────────────────────────────────

const TYPE_BYTE = 0x12; // VMB4DC, confirmed from protocol_vmb4dc.pdf

module.exports = function(RED) {
  function VelbusEmulateDimmerNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;

    node.bridge = RED.nodes.getNode(config.bridge);
    node.address = parseInt(config.address, 16) || 0;
    node.moduleName = config.moduleName || '';
    node.serial = parseInt(config.serial, 16) || 0x0001;
    // Real, confirmed VelbusLink-recognised firmware build for VMB4DC,
    // decoded directly from a genuine VLP file (14/07/2026). Same
    // hex-not-decimal correction as velbus-emulate-button-io.js — see that
    // file's comment for the full story. The human-readable "Firmware
    // build" VelbusLink displays (2446) is these two raw bytes read
    // directly as hex digits: 0x24 shows as "24", 0x46 shows as "46".
    node.buildYear = 0x24;
    node.buildWeek = 0x46;

    if (!node.bridge) {
      node.status({ fill: 'red', shape: 'ring', text: 'no bridge' });
      node.error('velbus-emulate-dimmer: no bridge configured');
      return;
    }
    if (!node.address || node.address < 1 || node.address > 254) {
      node.status({ fill: 'red', shape: 'ring', text: 'invalid address' });
      node.error('velbus-emulate-dimmer: invalid address ' + node.address);
      return;
    }

    const _label = (node.moduleName || 'VMB4DC') +
      ' (0x' + node.address.toString(16).padStart(2, '0').toUpperCase() + ')';

    function setStatus(text, fill, shape) {
      node.status({ fill: fill || 'blue', shape: shape || 'dot', text: _label + ' ' + text });
    }

    // Internal state: 4 channels, each 0-100%. Always starts at 0 (off),
    // never restored from persisted state — confirmed (14/07/2026): real
    // modules "start safe" at boot, they don't remember their last dim
    // level across a power cycle. Only memory (below) genuinely persists
    // on real hardware.
    const _levels = [0, 0, 0, 0];

    // Internal memory image — same 1024-byte (0x0000-0x03FF) range and same
    // dump/read/write commands confirmed identical to velbus-emulate-button-io
    // (see that file's comment for the full reasoning: VelbusLink performs a
    // memory dump as part of normal module sync, not just on explicit
    // request, and this same memory backs the future Action-assignment
    // engine work). Initialised to 0xFF, matching a factory-fresh module.
    // This DOES persist — genuinely EEPROM-backed on real hardware.
    let _memory = new Uint8Array(1024).fill(0xFF);

    // ── Persistence — same design as velbus-emulate-button-io.js, see that
    // file for the full reasoning. Dirty flag + periodic interval rather
    // than a context.set() on every write, deliberately, to keep disk
    // write frequency under explicit control rather than assume anything
    // about the configured context store's own internal batching.
    const _context = node.context();
    let _dirty = false;

    (function restore() {
      const saved = _context.get('memory');
      if (Array.isArray(saved) && saved.length === 1024) {
        _memory = Uint8Array.from(saved);
      }
    })();

    const _persistInterval = setInterval(function() {
      if (!_dirty) return;
      _context.set('memory', Array.from(_memory));
      _dirty = false;
    }, 30000);

    function sendMemoryBlock(addr) {
      node.bridge.send(pkt(0xFB, node.address, [
        0xCC, (addr >> 8) & 0xFF, addr & 0xFF,
        _memory[addr], _memory[addr + 1], _memory[addr + 2], _memory[addr + 3],
      ]));
    }

    function sendMemoryByte(addr) {
      // 0xFE — required as a write acknowledgment after 0xFC, not just a
      // read response. See velbus-emulate-button-io.js's comment for the
      // full story: found missing entirely (14/07/2026), causing
      // VelbusLink to stall writing memory back with no confirmation ever
      // arriving.
      node.bridge.send(pkt(0xFB, node.address, [0xFE, (addr >> 8) & 0xFF, addr & 0xFF, _memory[addr]]));
    }

    function sendMemoryDump() {
      for (let addr = 0; addr < 1024; addr += 4) {
        sendMemoryBlock(addr);
      }
    }

    function sendIdentification() {
      // 7 bytes — no terminator byte at all, confirmed from the protocol
      // document. Different from velbus-emulate-button-io's 8-byte VMB4PB
      // response; don't assume the two share a shape just because they're
      // both original-series.
      node.bridge.send(pkt(0xFB, node.address, [
        0xFF, TYPE_BYTE,
        (node.serial >> 8) & 0xFF, node.serial & 0xFF,
        0x00, // memory map version
        node.buildYear & 0xFF, node.buildWeek & 0xFF,
      ]));
    }

    function sendStatus(ch) {
      // 0xB8 — one packet per channel, matching the real protocol (a status
      // request targets a single channel bitmask, not "all channels at once").
      // Status byte: bits 0-1 run mode (00=normal — we never model forced/
      // inhibit here, matching the "plain on/off, nothing relay-shaped"
      // scope decision), no thermal/error/load-type bits at all for this type.
      const chBit = 1 << (ch - 1);
      const dimValue = _levels[ch - 1];
      node.bridge.send(pkt(0xFB, node.address, [
        0xB8, chBit,
        0x00,       // status byte — always "normal" run mode
        dimValue,
        0x00,       // LED status — not modelled
        0x00, 0x00, 0x00, // 24-bit timer — always 0, no active fade tracked
      ]));
    }

    function setLevel(ch, value) {
      _levels[ch - 1] = Math.max(0, Math.min(100, value));
      sendStatus(ch);
      setStatus('ch' + ch + ' ' + _levels[ch - 1] + '%',
        _levels[ch - 1] > 0 ? 'green' : 'grey');
      node.send({
        payload: {
          type: 'level',
          channel: ch,
          percent: _levels[ch - 1],
          timestamp: Date.now(),
        }
      });
    }

    // Genuine long-press dimming state — corrected 14/07/2026 after
    // initially flattening this to a fixed step per event, which missed
    // the real gesture entirely. Real behaviour: press does nothing yet;
    // release with no long-press since the press = Toggle; a long-press
    // starts continuous ramping in the opposite direction from the last
    // ramp, stopping at full on/off or when release arrives.
    const _dimGestureLong = [false, false, false, false]; // did this gesture include a long-press
    const _dimLastDirection = [1, 1, 1, 1]; // alternates each new long-press, so repeated holds don't get stuck dimming one way
    const _dimRampInterval = [null, null, null, null];

    function stopDimRamp(idx) {
      if (_dimRampInterval[idx]) {
        clearInterval(_dimRampInterval[idx]);
        _dimRampInterval[idx] = null;
      }
    }

    function startDimRamp(ch) {
      const idx = ch - 1;
      if (_dimRampInterval[idx]) return; // already ramping, a repeated 'long' event while held shouldn't restart it
      _dimLastDirection[idx] *= -1; // alternate direction from the previous long-press gesture
      const direction = _dimLastDirection[idx];
      _dimRampInterval[idx] = setInterval(function() {
        const next = Math.max(0, Math.min(100, _levels[idx] + (direction * 5)));
        setLevel(ch, next);
        if (next === 0 || next === 100) stopDimRamp(idx); // condition A: full on/off reached
      }, 200);
    }

    // ── Action-assignment engine ─────────────────────────────────────────
    // VMB4DC's memory architecture is confirmed different from
    // velbus-emulate-button-io's VMB4PB: each of the 4 channels gets its
    // own dedicated 256-byte block (0x000/0x100/0x200/0x300), rather than
    // one shared table — so the subject channel is implicit in which block
    // an entry lives in, not stored as a parameter byte. Entries are 6
    // bytes (one more than VMB4PB's 5): initiator module address,
    // initiator channel bitmask, action byte, parameter 1, 2, 3. See
    // HANDOVER.md section 17.6 for how each confirmed action byte was
    // decoded from a real VLP file.
    //
    // Entry cap of 37 per channel keeps this safely clear of the channel
    // name data confirmed living at offset +0xF0 within each block (own
    // channel's name, decoded directly from a real VLP file).
    function getActionEntries() {
      const entries = [];
      for (let ch = 1; ch <= 4; ch++) {
        const bankBase = (ch - 1) * 0x100;
        for (let i = 0; i < 37; i++) {
          const base = bankBase + (i * 6);
          const initiatorAddr = _memory[base];
          if (initiatorAddr === 0xFF) continue;
          entries.push({
            channel: ch,
            initiatorAddr,
            initiatorBit: _memory[base + 1],
            action: _memory[base + 2],
            param1: _memory[base + 3],
            param2: _memory[base + 4],
            param3: _memory[base + 5],
          });
        }
      }
      return entries;
    }

    function executeAction(entry, eventBits) {
      const ch = entry.channel;
      const idx = ch - 1;
      switch (entry.action) {
        case 0x0B: // 0103 Toggle — confirmed HANDOVER.md 17.6
          setLevel(ch, _levels[idx] > 0 ? 0 : 100);
          break;
        case 0x1D: // 0202 Dim at long press, toggle at short press — confirmed,
          // now genuinely implemented rather than approximated: press waits,
          // a long-press starts a real continuous ramp (condition B: stops on
          // release below; condition A: stops at 0/100 inside startDimRamp),
          // release with no long-press in this gesture toggles instead.
          if (eventBits.pressed) {
            _dimGestureLong[idx] = false;
          } else if (eventBits.long) {
            _dimGestureLong[idx] = true;
            startDimRamp(ch);
          } else if (eventBits.released) {
            stopDimRamp(idx); // condition B: release stops an active ramp
            if (!_dimGestureLong[idx]) {
              setLevel(ch, _levels[idx] > 0 ? 0 : 100); // short press = Toggle
            }
            _dimGestureLong[idx] = false;
          }
          break;
        case 0x1F: // 0214 Atmospheric dimvalue — confirmed. param3 is the
          // stored dim percentage (confirmed from a real VLP file: a
          // stored value of 0x32/50 decoded correctly as a 50% default).
          setLevel(ch, entry.param3);
          break;
        default:
          return; // not yet byte-confirmed (see HANDOVER.md 17.6/17.7) — ignore rather than guess
      }
    }

    // ── Packet handler — receives commands as if this were the real module ──
    // Registered for 'all' addresses, not just node.address — necessary for
    // the Action-assignment engine above, which needs to see OTHER modules'
    // button events. Own-address commands and bus-wide watching are two
    // separate branches, same reasoning as velbus-emulate-button-io.js.

    function onPacket(raw) {
      const p = parsePkt(raw);
      if (!p) return;

      if (p.addr === node.address) {
        onOwnAddressPacket(p);
        return;
      }

      if (p.rtr || p.cmd !== 0x00 || p.body.length < 4) return;
      const pressed = p.body[1], released = p.body[2], long = p.body[3];
      if (pressed === 0 && released === 0 && long === 0) return;

      const entries = getActionEntries();
      for (const entry of entries) {
        if (entry.initiatorAddr !== p.addr) continue;
        if (!(entry.initiatorBit & (pressed | released | long))) continue;
        executeAction(entry, { pressed: entry.initiatorBit & pressed, released: entry.initiatorBit & released, long: entry.initiatorBit & long });
      }
    }

    function onOwnAddressPacket(p) {
      if (p.rtr) {
        sendIdentification();
        return;
      }

      const { cmd, body } = p;

      if (cmd === 0xFA) { // dimmer channel status request
        if (body.length < 2) return;
        const chBit = body[1];
        for (let i = 0; i < 4; i++) if (chBit & (1 << i)) sendStatus(i + 1);
        return;
      }

      if (cmd === 0xCB) { // memory dump request
        sendMemoryDump();
        return;
      }

      if (cmd === 0xC9) { // read data block from memory
        if (body.length < 3) return;
        const addr = (body[1] << 8) | body[2];
        if (addr > 0x03FC) return;
        sendMemoryBlock(addr);
        return;
      }

      if (cmd === 0xFD) { // read single byte from memory
        if (body.length < 3) return;
        const addr = (body[1] << 8) | body[2];
        if (addr > 0x03FF) return;
        sendMemoryByte(addr);
        return;
      }

      if (cmd === 0xFC) { // write single byte to memory
        if (body.length < 4) return;
        const addr = (body[1] << 8) | body[2];
        if (addr > 0x03FF) return;
        _memory[addr] = body[3];
        _dirty = true;
        sendMemoryByte(addr); // required acknowledgment, see velbus-emulate-button-io.js
        return;
      }

      if (cmd === 0xCA) { // write 4-byte memory block
        if (body.length < 7) return;
        const addr = (body[1] << 8) | body[2];
        if (addr > 0x03FC) return;
        _memory[addr] = body[3];
        _memory[addr + 1] = body[4];
        _memory[addr + 2] = body[5];
        _memory[addr + 3] = body[6];
        _dirty = true;
        sendMemoryBlock(addr); // echo back as write confirmation, same as velbus-emulate-button-io
        return;
      }

      if (cmd === 0x07) { // set dim channel value
        // DLC=5: chBit, dimvalue, fade-time-hi, fade-time-lo. Fade time is
        // accepted and parsed for protocol completeness but not actually
        // animated — the emulator jumps straight to the target level rather
        // than ramping, since nothing here needs to demonstrate fade timing
        // specifically. If that changes, this is the one place to revisit.
        if (body.length < 4) return;
        const chBit = body[1];
        const value = body[2];
        for (let i = 0; i < 4; i++) if (chBit & (1 << i)) setLevel(i + 1, value);
        return;
      }

      if (cmd === 0x11) { // restore last used dim value
        if (body.length < 2) return;
        const chBit = body[1];
        // "Last used" isn't tracked separately from current level here —
        // there's nothing to restore to beyond whatever level is already
        // set, so this just re-confirms the current state. A real module
        // remembers a genuinely separate "last on" value across being
        // switched to 0; that distinction isn't needed for this tool.
        for (let i = 0; i < 4; i++) if (chBit & (1 << i)) sendStatus(i + 1);
        return;
      }

      if (cmd === 0x10) { // stop channel dimming
        if (body.length < 2) return;
        const chBit = body[1];
        for (let i = 0; i < 4; i++) if (chBit & (1 << i)) sendStatus(i + 1);
        return;
      }
    }

    node.bridge.register('all', onPacket);
    setStatus('ready', 'grey');

    // ── Input — simulate a level change from Node-RED ───────────────────────

    node.on('input', function(msg) {
      const inp = (msg && msg.payload && typeof msg.payload === 'object') ? msg.payload : {};
      const ch = parseInt(inp.channel);

      if (!ch || ch < 1 || ch > 4) {
        node.warn('velbus-emulate-dimmer: input requires "channel": 1-4');
        return;
      }
      if (typeof inp.percent !== 'number') {
        node.warn('velbus-emulate-dimmer: input requires "percent": 0-100');
        return;
      }

      setLevel(ch, Math.round(inp.percent));
    });

    node.on('close', function() {
      clearInterval(_persistInterval);
      for (let i = 0; i < 4; i++) stopDimRamp(i); // don't leak an active ramp's setInterval
      if (_dirty) _context.set('memory', Array.from(_memory));
      node.bridge.deregister('all', onPacket);
    });
  }

  RED.nodes.registerType('velbus-emulate-dimmer', VelbusEmulateDimmerNode);
};

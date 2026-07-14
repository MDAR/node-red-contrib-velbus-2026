'use strict';

const { pkt, parsePkt } = require('../../lib/velbus-utils');

// ─────────────────────────────────────────────────────────────────────────────
// velbus-emulate-button-io — emulates a VMB4PB in "I/O module" mode.
//
// This is a MODULE EMULATOR, not a controller node — it plays the OPPOSITE
// role to every other node in this palette. Where velbus-button RECEIVES
// events from a real button and lets Node-RED react to them, this node
// TRANSMITS button events (as if a real button were being pressed) and
// RECEIVES output commands (as if it were a real relay-like device),
// so that VelbusLink can scan, see, and link against it exactly as it would
// a real VMB4PB — the whole point being to practice or automate against a
// realistic bus presence without needing physical hardware.
//
// Scope, and why it stops here — see HANDOVER.md and coverage-roadmap.md
// for the full reasoning, summarised:
//   - Only plain wire commands are implemented (0x00 events, 0x01/0x02
//     output on/off, 0xFF identification, 0xED status). Program Steps
//     (the memory-based Action system VelbusLink writes to a REAL target
//     module to interpret things like "toggle" or "dim on long press")
//     are deliberately NOT implemented here. This module only ever needs
//     to be a valid initiator or a plain on/off subject — whatever rich
//     behaviour a link should have belongs on whichever module the link
//     is actually programmed onto, real or otherwise. Storing and
//     executing Program Steps here would be a large, separate undertaking
//     (comparable to real module firmware) for no benefit to that goal.
//   - The 4 open-collector outputs are the simplest possible way to get a
//     visible, scannable confirmation that a link fired — they were never
//     meant to demonstrate relay-specific behaviour (timer, forced-on/off,
//     inhibit). If a genuine relay exercise is needed, link against a real
//     relay or velbus-relay/-20 instead; this node's outputs are correctly
//     just on/off.
//   - "I/O module" vs "pushbutton interface" mode, as seen in VelbusLink's
//     own configuration UI, is a VelbusLink-side labelling/navigation
//     distinction only — confirmed from the actual protocol document that
//     the wire commands (0x00 events, 0x01/0x02 outputs) are identical
//     regardless of which mode is selected. This node doesn't model "mode"
//     as a concept at all — it always answers both.
// ─────────────────────────────────────────────────────────────────────────────

const TYPE_BYTE = 0x44; // VMB4PB, confirmed from protocol_vmb4pb.md

module.exports = function(RED) {
  function VelbusEmulateButtonIONode(config) {
    RED.nodes.createNode(this, config);
    const node = this;

    node.bridge = RED.nodes.getNode(config.bridge);
    node.address = parseInt(config.address, 16) || 0;
    node.moduleName = config.moduleName || '';
    node.serial = parseInt(config.serial, 16) || 0x0001;
    // Real, confirmed VelbusLink-recognised firmware build for VMB4PB,
    // decoded directly from a genuine VLP file (14/07/2026) — NOT a
    // decimal year/week that needs converting to hex. The human-readable
    // "Firmware build" VelbusLink displays (2531) is formed by reading each
    // half of these two raw bytes AS HEX DIGITS directly: byte 0x25 shows
    // as "25", byte 0x31 shows as "31". Earlier code wrongly treated this
    // as decimal 25/31 needing hex conversion, which produced the WRONG
    // bytes (0x19/0x1F) and a build VelbusLink doesn't recognise at all —
    // confirmed broken by direct testing. Not user-editable any more, for
    // exactly that reason: there is no correct way to expose this as a
    // "year"/"week" pair without reintroducing the same decimal/hex
    // confusion that caused the bug in the first place.
    node.buildYear = 0x25;
    node.buildWeek = 0x31;

    if (!node.bridge) {
      node.status({ fill: 'red', shape: 'ring', text: 'no bridge' });
      node.error('velbus-emulate-button-io: no bridge configured');
      return;
    }
    if (!node.address || node.address < 1 || node.address > 254) {
      node.status({ fill: 'red', shape: 'ring', text: 'invalid address' });
      node.error('velbus-emulate-button-io: invalid address ' + node.address);
      return;
    }

    const _label = (node.moduleName || 'VMB4PB') +
      ' (0x' + node.address.toString(16).padStart(2, '0').toUpperCase() + ')';

    function setStatus(text, fill, shape) {
      node.status({ fill: fill || 'blue', shape: shape || 'dot', text: _label + ' ' + text });
    }

    // Internal state: 4 open-collector outputs. Always starts at all-off,
    // never restored from persisted state — confirmed (14/07/2026): real
    // modules "start safe," outputs off at boot, full stop. The one real
    // exception is newer firmware persisting a "Forced Off" safety state
    // specifically — irrelevant here, since this emulator deliberately
    // doesn't model forced/inhibit states at all (see the scope note at
    // the top of this file).
    const _outputs = [false, false, false, false];

    // Internal memory image — 1024 bytes (0x0000-0x03FF), confirmed range
    // from the protocol document and matching every real VLP file examined.
    // Initialised to 0xFF throughout, matching a genuinely factory-fresh
    // module's memory before any configuration — real VLP dumps show
    // unconfigured regions as 0xFF, never 0x00.
    //
    // This exists specifically because VelbusLink performs a memory dump
    // (0xCB) as part of its normal module-sync process — not just when the
    // user explicitly requests one. Without a real memory image to answer
    // from, this request went unanswered entirely (reported 14/07/2026:
    // "VelbusLink is sending a Memory Dump request 0xCB to the Emulated
    // Node and it just isn't responding"). This also directly supports the
    // Action-assignment engine work scoped in HANDOVER.md section 17 —
    // VelbusLink writes Linked Push Button entries into this exact memory
    // (0x0128-0x0253) when a link is configured, so a real, working,
    // writable memory image is a shared prerequisite for both fixes, not
    // two separate pieces of work.
    //
    // Unlike _outputs, this DOES persist — genuinely EEPROM-backed on real
    // hardware (channel names, link configuration survive a power cycle).
    let _memory = new Uint8Array(1024).fill(0xFF);

    // ── Persistence ──────────────────────────────────────────────────────
    // node.context() rather than flow/global — this state belongs to this
    // one emulator instance, not shared across other nodes. Relies on the
    // user's own settings.js having a persistent context store configured
    // (e.g. contextStorage.default = localfilesystem) — confirmed present
    // on Stuart's instance. Without one, this silently falls back to
    // Node-RED's default in-memory context (state lost on restart, same
    // as before this feature existed — not a regression).
    //
    // Deliberately NOT calling context.set() synchronously on every single
    // memory write (a full VelbusLink config sync could mean 256+ writes
    // in a row) — a dirty flag plus a periodic interval instead, so the
    // actual persist call happens at most once per interval regardless of
    // how many writes occurred in between. This is written to control
    // write frequency explicitly rather than assume anything about how the
    // configured context store batches internally.
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
    }, 30000); // matches the localfilesystem store's own flush cadence

    function sendMemoryBlock(addr) {
      // 0xCC — 4-byte block starting at addr. Confirmed from protocol:
      // DLC=7, [0xCC, addrHi, addrLo, d0, d1, d2, d3].
      node.bridge.send(pkt(0xFB, node.address, [
        0xCC, (addr >> 8) & 0xFF, addr & 0xFF,
        _memory[addr], _memory[addr + 1], _memory[addr + 2], _memory[addr + 3],
      ]));
    }

    function sendMemoryDump() {
      // 0xCB triggers a dump of the ENTIRE memory range as a sequence of
      // 0xCC blocks — confirmed from the protocol document (the request
      // itself carries no address parameter, DLC=1, so the response must
      // cover everything unprompted). 256 blocks total (1024 bytes / 4).
      // Sent as a synchronous burst — Node's TCP socket buffers these
      // correctly and the bridge's own splitPackets() already handles
      // multiple frames arriving close together, so no explicit throttling
      // has been needed for any other multi-packet response in this
      // codebase. Worth revisiting only if real testing shows VelbusLink
      // struggling with the burst.
      for (let addr = 0; addr < 1024; addr += 4) {
        sendMemoryBlock(addr);
      }
    }

    function sendModuleStatus() {
      // 0xED — packs button-inverted status (always "normal", we don't
      // model inversion) and OC-locked status (always "unlocked", we don't
      // model Program-Step-based locking) into DATABYTE4; DATABYTE8 is the
      // real, meaningful part — actual output on/off state.
      const db2 = 0x00; // no buttons currently pressed (momentary — rest state)
      const db3 = 0x0F; // all 4 buttons "enabled" (bits 0-3) — always true here
      const db4 = 0x0F; // bits 0-3: buttons 1-4 normal (1=normal, we don't model inversion);
                         // bits 4-7: OC 1-4 unlocked (0=unlocked, we don't model locking)
      const db5 = 0x00; // nothing locked
      const db6 = 0x00; // channel program not disabled (irrelevant, no Program Steps here)
      const db7 = 0x00; // no alarm/program/sunrise/sunset state modelled
      let db8 = 0x00;
      for (let i = 0; i < 4; i++) if (_outputs[i]) db8 |= (1 << i);

      node.bridge.send(pkt(0xFB, node.address, [0xED, db2, db3, db4, db5, db6, db7, db8]));
    }

    function sendIdentification() {
      node.bridge.send(pkt(0xFB, node.address, [
        0xFF, TYPE_BYTE,
        (node.serial >> 8) & 0xFF, node.serial & 0xFF,
        0x00, // memory map version
        node.buildYear & 0xFF, node.buildWeek & 0xFF,
        0x00, // terminator: open
      ]));
    }

    function sendButtonEvent(channel, kind) {
      // channel: 1-4. kind: 'press' | 'release' | 'long'
      const bit = 1 << (channel - 1);
      const pressed  = kind === 'press' ? bit : 0;
      const released = kind === 'release' ? bit : 0;
      const long     = kind === 'long' ? bit : 0;
      node.bridge.send(pkt(0xF8, node.address, [0x00, pressed, released, long]));
    }

    // ── Packet handler — receives commands as if this were the real module ──

    function onPacket(raw) {
      const p = parsePkt(raw);
      if (!p) return;
      if (p.addr !== node.address) return;

      if (p.rtr) {
        sendIdentification();
        return;
      }

      const { cmd, body } = p;

      if (cmd === 0xFA) { // module status request
        sendModuleStatus();
        return;
      }

      if (cmd === 0xCB) { // memory dump request
        sendMemoryDump();
        return;
      }

      if (cmd === 0xC9) { // read data block from memory
        if (body.length < 3) return;
        const addr = (body[1] << 8) | body[2];
        if (addr > 0x03FC) return; // out of documented range
        sendMemoryBlock(addr);
        return;
      }

      if (cmd === 0xFC) { // write single byte to memory
        if (body.length < 4) return;
        const addr = (body[1] << 8) | body[2];
        if (addr > 0x03FF) return;
        _memory[addr] = body[3];
        _dirty = true;
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
        // Real modules echo back a memory data block as write confirmation
        // (confirmed: "Write memory block" remark says "Wait for 'memory
        // data block' feedback before sending a next command") — respond
        // the same way so VelbusLink's write sequencing isn't left waiting.
        sendMemoryBlock(addr);
        return;
      }

      if (cmd === 0x01 || cmd === 0x02) { // switch output off / on
        if (body.length < 2) return;
        const ch = body[1];
        const on = cmd === 0x02;
        if (ch === 255) {
          for (let i = 0; i < 4; i++) _outputs[i] = on;
        } else if (ch >= 9 && ch <= 12) {
          _outputs[ch - 9] = on;
        } else {
          return;
        }
        sendModuleStatus();
        setStatus('out: ' + _outputs.map((v, i) => (i + 9) + '=' + (v ? '1' : '0')).join(' '));

        node.send({
          payload: {
            type: 'output',
            outputs: _outputs.slice(),
            timestamp: Date.now(),
          }
        });
        return;
      }
    }

    node.bridge.register(node.address, onPacket);
    setStatus('ready', 'grey');

    // ── Input — simulate button presses from Node-RED ──────────────────────

    node.on('input', function(msg) {
      const inp = (msg && msg.payload && typeof msg.payload === 'object') ? msg.payload : {};
      const ch = parseInt(inp.channel);

      if (!ch || ch < 1 || ch > 4) {
        node.warn('velbus-emulate-button-io: input requires "channel": 1-4');
        return;
      }

      const kind = inp.event || 'press';
      if (!['press', 'release', 'long'].includes(kind)) {
        node.warn('velbus-emulate-button-io: "event" must be press, release, or long');
        return;
      }

      sendButtonEvent(ch, kind);
      setStatus('btn' + ch + ' ' + kind, 'green');
    });

    node.on('close', function() {
      clearInterval(_persistInterval);
      if (_dirty) _context.set('memory', Array.from(_memory)); // final flush, don't lose the last few seconds' writes
      node.bridge.deregister(node.address, onPacket);
    });
  }

  RED.nodes.registerType('velbus-emulate-button-io', VelbusEmulateButtonIONode);
};

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
    node.buildYear = parseInt(config.buildYear) || 26;
    node.buildWeek = parseInt(config.buildWeek) || 1;

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

    // Internal state: 4 open-collector outputs, off by default (matches a
    // real module's power-up state — outputs are never on until commanded).
    const _outputs = [false, false, false, false];

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
      node.bridge.deregister(node.address, onPacket);
    });
  }

  RED.nodes.registerType('velbus-emulate-button-io', VelbusEmulateButtonIONode);
};

'use strict';

const { rtrPkt, parsePkt } = require('../../lib/velbus-utils');
const { GLASS_PANEL_TYPE_IDS } = require('../../lib/glass-panel-types');

const ALL_TYPES = {
  // Relays - original
  0x02: 'VMB1RY',       0x08: 'VMB4RY',        0x10: 'VMB4RYLD',
  0x11: 'VMB4RYNO',    0x1B: 'VMB1RYNO',      0x29: 'VMB1RYNOS',
  0x41: 'VMB1RYS',     0x48: 'VMB4RYLD-10',   0x49: 'VMB4RYNO-10',
  // Relays - V2
  0x0D: 'VMB1RYS-20',  0x26: 'VMB4RYLD-20',   0x27: 'VMB4RYNO-20',
  // Dimmers - original
  0x15: 'VMBDMI',      0x2F: 'VMBDMI-R',      0x12: 'VMB4DC',
  // Dimmers - V2
  0x24: 'VMB2DC-20',   0x4B: 'VMB8DC-20',     0x06: 'VMB4LEDPWM-20',
  // Push buttons
  0x01: 'VMB8PB',      0x16: 'VMB8PBU',       0x17: 'VMB6PBN',
  0x18: 'VMB2PBN',     0x20: 'VMBGP4',        0x44: 'VMB4PB',
  0x4C: 'VMB6PB-20',
  // Glass panels - original
  0x1E: 'VMBGP1',      0x1F: 'VMBGP2',      0x20: 'VMBGP4',
  0x21: 'VMBGPO',      0x2D: 'VMBGP4PIR',
  0x28: 'VMBGPOD',
  0x34: 'VMBEL1',      0x35: 'VMBEL2',        0x36: 'VMBEL4',
  0x37: 'VMBELO',      0x38: 'VMBELPIR',      0x39: 'VMBSIG',
  0x47: 'VMBEL2PIR',
  0x3A: 'VMBGP1-2',    0x3B: 'VMBGP2-2',      0x3C: 'VMBGP4-2',
  0x3D: 'VMBGPOD-2',
  // Glass panels - V2
  0x4F: 'VMBEL1-20',   0x50: 'VMBEL2-20',     0x51: 'VMBEL4-20',
  0x52: 'VMBELO-20',   0x53: 'VMBELPIR-20',   0x54: 'VMBGP1-20',
  0x55: 'VMBGP2-20',   0x56: 'VMBGP4-20',     0x57: 'VMBGPO-20',
  0x5C: 'VMBEL2PIR-20', 0x5F: 'VMBGP4PIR-20',
  // PIR / motion
  0x23: 'VMBPIRO-10', 0x2A: 'VMBPIRM',   0x2B: 'VMBPIRC',
  0x2C: 'VMBPIRO',    0x4D: 'VMBPIR-20', 0x59: 'VMBPIRO-20',
  // Sensor / input
  0x22: 'VMB7IN',     0x32: 'VMB4AN',    0x4E: 'VMB8IN-20',
  // Meteo
  0x31: 'VMBMETEO',
  // Blind / shutter motor controllers
  0x03: 'VMB1BL',   0x09: 'VMB2BL',
  0x2E: 'VMB1BLS',  0x1D: 'VMB2BLE',  0x4A: 'VMB2BLE-10', 0x61: 'VMB2BLE-20',
  // Blind / shutter (old labels were wrong — VMB2BLE is NOT Bluetooth)
  // Power/energy
  0x04: 'VMBPSUMNGR-20',
  // Interface
  0x40: 'VMBUSBIP',
  // Temperature sensor (old)
  0x0C: 'VMB1TS',
  // Additional button/input modules (09/07/2026)
  0x0A: 'VMB8IR',   0x0B: 'VMB4PD',   0x1A: 'VMB4RF',
  0x30: 'VMBRFR8S', 0x33: 'VMBVP01',  0x42: 'VMBKP',
  0x43: 'VMBIN',
  // Additional sensor/input module (09/07/2026)
  0x05: 'VMB6IN',
  // Additional glass panel types (09/07/2026)
  0x3E: 'VMBGP4PIR-2', 0x25: 'VMBGPTC',
  // Recognized but deliberately not supported (09/07/2026) — named correctly
  // in a scan rather than showing "unknown", but no node exists for these
  // and none is planned. See HANDOVER.md section 13 / coverage-roadmap.md
  // for the reasoning per type.
  0x45: 'VMBDALI',   0x5A: 'VMBDALI-20',
  0x13: 'VMBLCDWB',  0x3F: 'VMCM3',
  0x5B: 'VMBSIG-20', 0x60: 'VMBSIG-21',
};

const NODE_SUGGESTION = {
  // Relays - original
  0x02: 'velbus-relay',      0x08: 'velbus-relay',      0x10: 'velbus-relay',
  0x11: 'velbus-relay',      0x1B: 'velbus-relay',      0x29: 'velbus-relay',
  0x41: 'velbus-relay',      0x48: 'velbus-relay',      0x49: 'velbus-relay',
  // Relays - V2
  0x0D: 'velbus-relay-20',   0x26: 'velbus-relay-20',   0x27: 'velbus-relay-20',
  // Dimmers - original
  0x15: 'velbus-dimmer',     0x2F: 'velbus-dimmer',     0x12: 'velbus-dimmer',
  // Dimmers - V2
  0x24: 'velbus-dimmer-20',  0x4B: 'velbus-dimmer-20',  0x06: 'velbus-dimmer-20',
  // Button modules
  0x01: 'velbus-button',   0x16: 'velbus-button',   0x17: 'velbus-button',
  0x18: 'velbus-button',   0x44: 'velbus-button',   0x4C: 'velbus-button',
  // Blind / shutter (confirmed PDFs read)
  0x03: 'velbus-blind',    0x09: 'velbus-blind',
  0x1D: 'velbus-blind-s',  0x2E: 'velbus-blind-s',
  0x4A: 'velbus-blind-s',  0x61: 'velbus-blind-20',
  // Sensor / input
  0x22: 'velbus-sensor',    0x32: 'velbus-sensor',    0x4E: 'velbus-sensor-20',
  // Meteo
  0x31: 'velbus-meteo',
  // PIR
  0x23: 'velbus-pir',    0x2A: 'velbus-pir',    0x2B: 'velbus-pir',
  0x2C: 'velbus-pir',    0x4D: 'velbus-pir-20', 0x59: 'velbus-pir-20',
  // Glass panels - all via single node
  0x1E: 'velbus-glass-panel', 0x1F: 'velbus-glass-panel', 0x20: 'velbus-glass-panel',
  0x21: 'velbus-glass-panel', 0x2D: 'velbus-glass-panel',
  0x28: 'velbus-glass-panel',
  0x34: 'velbus-glass-panel', 0x35: 'velbus-glass-panel', 0x36: 'velbus-glass-panel',
  0x37: 'velbus-glass-panel', 0x38: 'velbus-glass-panel', 0x47: 'velbus-glass-panel',
  0x3A: 'velbus-glass-panel', 0x3B: 'velbus-glass-panel', 0x3C: 'velbus-glass-panel',
  0x3D: 'velbus-glass-panel',
  0x4F: 'velbus-glass-panel', 0x50: 'velbus-glass-panel', 0x51: 'velbus-glass-panel',
  0x52: 'velbus-glass-panel', 0x53: 'velbus-glass-panel', 0x54: 'velbus-glass-panel',
  0x55: 'velbus-glass-panel', 0x56: 'velbus-glass-panel', 0x57: 'velbus-glass-panel',
  0x5C: 'velbus-glass-panel', 0x5F: 'velbus-glass-panel',
  0x3E: 'velbus-glass-panel', 0x25: 'velbus-glass-panel',
  // Additional button/input modules (09/07/2026)
  0x0A: 'velbus-button',   0x0B: 'velbus-button',   0x1A: 'velbus-button',
  0x30: 'velbus-button',   0x33: 'velbus-button',   0x42: 'velbus-button',
  0x43: 'velbus-button',
  // Additional sensor/input module (09/07/2026)
  0x05: 'velbus-sensor',
  // Recognized but deliberately not supported (09/07/2026) — explicit label
  // rather than falling through to null, so a scan clearly distinguishes
  // "we know what this is and chose not to support it" from "unknown type".
  0x45: 'Not supported', 0x5A: 'Not supported',
  0x13: 'Not supported', 0x3F: 'Not supported',
  0x39: 'Not supported', 0x5B: 'Not supported', 0x60: 'Not supported',
};

// Channel count per module type — physical channels only.
// Virtual channels (conditional logic, lockouts) are not included;
// installers set those manually.
const MODULE_CHANNELS = {
  // Relays - original
  0x02: 1,  0x08: 4,  0x10: 4,
  0x11: 4,  0x1B: 1,  0x29: 1,
  0x41: 1,  0x48: 4,  0x49: 4,
  // Relays - V2
  0x0D: 1,  0x26: 4,  0x27: 4,
  // Dimmers - original
  0x15: 1,  0x2F: 1,  0x12: 4,
  // Dimmers - V2
  0x24: 2,  0x4B: 8,  0x06: 4,
  // Push buttons
  0x01: 8,  0x16: 8,  0x17: 6,  0x18: 2,
  0x44: 4,  0x4C: 6,
  // PIR
  0x23: 6,  0x2A: 7,  0x2B: 7,  0x2C: 6,  0x4D: 7,  0x59: 6,
  // Blind / shutter (all PDFs confirmed)
  0x03: 1,  0x09: 2,  0x1D: 2,  0x2E: 1,  0x4A: 2,  0x61: 2,
  // Sensor / input
  0x22: 8,  0x31: 8,  0x32: 16, 0x4E: 32,
  // Glass panels - original
  0x1E: 1,  0x1F: 2,  0x20: 4,
  0x21: 32, 0x2D: 8,
  0x28: 4,
  0x34: 1,  0x35: 2,  0x36: 4,
  0x37: 4,  0x38: 8,  0x47: 6,
  0x3A: 1,  0x3B: 2,  0x3C: 4,
  0x3D: 4,
  // Glass panels - V2
  0x4F: 1,  0x50: 2,  0x51: 4,
  0x52: 4,  0x53: 8,  0x54: 1,
  0x55: 2,  0x56: 4,  0x57: 32,
  0x5C: 6,  0x5F: 8,
  // Additional glass panel types (09/07/2026)
  0x3E: 8,  0x25: 32,
  // Additional button/input modules (09/07/2026)
  0x0A: 8,  0x0B: 4,  0x1A: 4,  0x30: 8,  0x33: 8,  0x42: 8,  0x43: 1,
  // Additional sensor/input module (09/07/2026)
  0x05: 6,
};

module.exports = function(RED) {

  function VelbusScanNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;

    node.bridge      = RED.nodes.getNode(config.bridge);
    node.rtrDelay    = parseInt(config.rtrDelay)    || 75;    // ms between RTR packets
    node.collectTime = parseInt(config.collectTime) || 8000;  // ms to collect after last RTR

    if (!node.bridge) {
      node.error('velbus-scan: no bridge configured');
      return;
    }

    let _scanning     = false;
    let _discovered   = {};
    let _collectTimer = null;

    function addrHex(a) {
      return '0x' + a.toString(16).padStart(2, '0').toUpperCase();
    }

    // ── Packet handler — registered as 'all' listener ─────────────────────

    function onPacket(raw) {
      if (!_scanning) return;

      const p = parsePkt(raw);
      if (!p || p.rtr) return;
      const { addr, body, cmd } = p;

      // 0xFF module type response
      if (cmd === 0xFF && body.length >= 2) {
        if (_discovered[addr]) return; // already found this address

        const typeId  = body[1];
        const serial  = body.length >= 4 ? (body[2] << 8 | body[3]) : null;
        const mapVer  = body.length >= 5 ? body[4] : null;
        const buildHi = body.length >= 6 ? body[5] : null;
        const buildLo = body.length >= 7 ? body[6] : null;
        const build   = (buildHi !== null && buildLo !== null)
                        ? (buildHi * 100 + buildLo) : null;
        const props   = body.length >= 8 ? body[7] : null;
        const canFD   = props !== null ? !!(props & 0x20) : false;

        const typeName      = ALL_TYPES[typeId] || ('unknown_' + addrHex(typeId));
        const suggestedNode = NODE_SUGGESTION[typeId] || null;
        const channels      = MODULE_CHANNELS[typeId] || null;

        _discovered[addr] = {
          address:          addrHex(addr),
          addressDec:       addr,
          typeId:           addrHex(typeId),
          module:           typeName,
          serial:           serial ? serial.toString(16).toUpperCase().padStart(4, '0') : null,
          build,
          memoryMapVersion: mapVer,
          canFD,
          suggestedNode,
          channels,
          subaddresses:     []
        };

        node.log('velbus-scan: found ' + typeName + ' at ' + addrHex(addr));
        node.send([null, { payload: { topic: 'module_found', ..._discovered[addr] } }]);
        return;
      }

      // 0xB0 subtype — merge subaddresses into already-discovered module
      if (cmd === 0xB0 && body.length >= 8) {
        const module = _discovered[addr];
        if (module) {
          module.subaddresses = [body[4], body[5], body[6], body[7]]
            .filter(s => s !== 0xFF && s >= 0x01 && s <= 0xFE)
            .map(s => addrHex(s));
        }
      }
    }

    // ── Scan ──────────────────────────────────────────────────────────────

    function startScan() {
      if (_scanning) {
        node.warn('velbus-scan: scan already in progress');
        return;
      }

      _scanning   = true;
      _discovered = {};

      // Lock bridge — queues interpreter startup RTRs until scan completes
      if (node.bridge.lockScan) node.bridge.lockScan();

      node.bridge.register('all', onPacket);
      node.status({ fill: 'blue', shape: 'dot', text: 'scanning…' });

      // Fire RTRs one at a time using recursive setTimeout
      // Avoids scheduling 254 timers simultaneously on low-memory hardware
      const addresses = [];
      for (let a = 0xFE; a >= 0x01; a--) addresses.push(a);
      let rtrIndex = 0;

      function sendNextRTR() {
        if (!_scanning || rtrIndex >= addresses.length) {
          // All RTRs sent — start collect window
          node.status({ fill: 'blue', shape: 'dot', text: 'collecting responses…' });
          _collectTimer = setTimeout(finaliseScan, node.collectTime);
          return;
        }

        const addr = addresses[rtrIndex];
        const pct  = Math.round((rtrIndex / addresses.length) * 100);

        if (rtrIndex % 32 === 0) {
          node.status({ fill: 'blue', shape: 'dot',
            text: 'scanning ' + addrHex(addr) + ' (' + pct + '%)' });
        }

        node.bridge.send(rtrPkt(addr));
        rtrIndex++;
        setTimeout(sendNextRTR, node.rtrDelay);
      }

      sendNextRTR();
    }

    function finaliseScan() {
      if (_collectTimer) { clearTimeout(_collectTimer); _collectTimer = null; }
      _scanning = false;

      node.bridge.deregister('all', onPacket);
      if (node.bridge.unlockScan) node.bridge.unlockScan();

      const modules = Object.values(_discovered)
        .sort((a, b) => a.addressDec - b.addressDec);
      const count = modules.length;

      node.log('velbus-scan: finalising — ' + count + ' modules found');

      node.status({ fill: 'green', shape: 'dot',
        text: count + ' module' + (count !== 1 ? 's' : '') + ' found' });

      const payload = { topic: 'scan_complete', modules, count };
      node.log('velbus-scan: sending scan_complete payload');
      node.send([{ payload }, null]);
      node.log('velbus-scan: send complete');

      // Store results on bridge for config dialog dropdowns
      if (node.bridge.storeScanResults) {
        node.bridge.storeScanResults(modules);
      }

      node.log('velbus-scan: complete — ' + count + ' modules: ' +
        modules.map(m => m.address + ' ' + m.module).join(', '));
    }

    // ── Input ─────────────────────────────────────────────────────────────

    node.on('input', function(msg) {
      const cmd = (msg.payload && msg.payload.cmd) || msg.payload || 'scan';
      if (cmd === 'scan' || cmd === true || cmd === 1) {
        startScan();
      } else if (cmd === 'cancel') {
        if (_scanning) {
          if (_collectTimer) { clearTimeout(_collectTimer); _collectTimer = null; }
          node.bridge.deregister('all', onPacket);
          if (node.bridge.unlockScan) node.bridge.unlockScan();
          _scanning = false;
          node.status({ fill: 'grey', shape: 'dot', text: 'cancelled' });
        }
      }
    });

    // ── Cleanup ───────────────────────────────────────────────────────────

    node.on('close', function() {
      if (_collectTimer) clearTimeout(_collectTimer);
      node.bridge.deregister('all', onPacket);
    });

    node.status({ fill: 'grey', shape: 'dot', text: 'ready — inject to scan' });
  }

  RED.nodes.registerType('velbus-scan', VelbusScanNode);
};

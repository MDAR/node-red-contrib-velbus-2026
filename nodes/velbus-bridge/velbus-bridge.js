'use strict';

const net = require('net');
const tls = require('tls');
const fs  = require('fs');
const { splitPackets, parsePkt } = require('../../lib/velbus-utils');

module.exports = function(RED) {

  // ── Shared scan results store ───────────────────────────────────────────
  // Keyed by bridge node ID → array of discovered module objects.
  // Populated by velbus-scan node via bridge.storeScanResults().
  // Served to config dialogs via RED.httpAdmin endpoint below.
  // Persisted to a JSON file in the Node-RED user directory so that address
  // dropdowns survive restarts and full deploys.
  const path = require('path');
  const _persistFile = path.join(RED.settings.userDir || '.', 'velbus-scan-results.json');
  let _scanResults = {};
  try {
    _scanResults = JSON.parse(fs.readFileSync(_persistFile, 'utf8'));
    RED.log.info('velbus-bridge: loaded persisted scan results (' +
                 Object.keys(_scanResults).length + ' bridge(s))');
  } catch (e) {
    _scanResults = {}; // No file yet, or unreadable — start empty
  }

  function _persistScanResults() {
    fs.writeFile(_persistFile, JSON.stringify(_scanResults, null, 2), (err) => {
      if (err) RED.log.warn('velbus-bridge: could not persist scan results — ' + err.message);
    });
  }

  // ── HTTP Admin endpoint ─────────────────────────────────────────────────
  // GET /velbus/scan-results?bridge=<nodeId>
  // Returns the most recent scan results for a given bridge node.
  // Called by config dialog dropdowns to populate address lists.
  RED.httpAdmin.get('/velbus/scan-results', RED.auth.needsPermission(''), function(req, res) {
    const bridgeId = req.query.bridge;
    if (!bridgeId) {
      return res.json({ modules: [], error: 'No bridge ID specified' });
    }
    const results = _scanResults[bridgeId] || [];
    res.json({ modules: results, count: results.length });
  });

  // ── Bridge node constructor ─────────────────────────────────────────────

  function VelbusBridgeNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;

    // Config
    node.host     = config.host     || '127.0.0.1';
    node.port     = parseInt(config.port) || 6000;
    node.useTLS   = config.useTLS   === true;
    node.useAuth  = config.useAuth  === true;
    node.authKey  = config.authKey  || '';
    node.certPath = config.certPath || '';
    node.keyPath  = config.keyPath  || '';

    // Registered interpreter nodes: Map<address, Set<handlerFn>>
    node._listeners  = new Map();
    node._subaddrMap = new Map();

    // Rebuild subaddress routing from persisted scan results, so subaddress
    // frames (e.g. GPO-20 thermostat events from 0x34) route to primary-address
    // listeners without requiring a fresh scan after every restart or deploy.
    for (const m of (_scanResults[node.id] || [])) {
      if (m.subaddresses && m.address) {
        const primary = parseInt(m.address, 16);
        for (const s of m.subaddresses) {
          const sub = parseInt(s, 16);
          if (sub >= 0x01 && sub <= 0xFE) node._subaddrMap.set(sub, primary);
        }
      }
    }
    if (node._subaddrMap.size) {
      node.log('velbus-bridge: restored ' + node._subaddrMap.size +
               ' subaddress mapping(s) from persisted scan results');
    }

    // Scan lock
    node._scanLocked = false;
    node._scanQueue  = [];

    // TCP state
    node._socket         = null;
    node._remainder      = Buffer.alloc(0);
    node._connected      = false;
    node._closing        = false;
    node._reconnectTimer = null;

    // ── Scan results store API ────────────────────────────────────────────

    node.storeScanResults = function(modules) {
      _scanResults[node.id] = modules;
      _persistScanResults();
      node.log('velbus-bridge: stored ' + modules.length + ' scan results for address dropdown');
    };

    node.getScanResults = function() {
      return _scanResults[node.id] || [];
    };

    // ── Scan lock API ─────────────────────────────────────────────────────

    node.lockScan = function() {
      node._scanLocked = true;
      node._scanQueue  = [];
      node.log('velbus-bridge: scan lock engaged — interpreter startup queued');
    };

    node.unlockScan = function() {
      node._scanLocked = false;
      node.log('velbus-bridge: scan lock released — flushing ' +
        node._scanQueue.length + ' queued startup packet(s)');
      let delay = 500;
      for (const item of node._scanQueue) {
        setTimeout(() => {
          if (!node._closing) node.send(item.buf);
        }, delay);
        delay += 1000;
      }
      node._scanQueue = [];
    };

    // ── Send packet ───────────────────────────────────────────────────────

    node.send = function(buf, startup) {
      if (node._scanLocked && startup) {
        node._scanQueue.push({ buf: Buffer.from(buf) });
        return;
      }
      if (node._socket && node._connected) {
        node._socket.write(buf);
      } else {
        node.warn('velbus-bridge: not connected, packet dropped');
      }
    };

    // ── Connection state (public accessor) ────────────────────────────────

    node.isConnected = function() {
      return !!node._connected;
    };

    // ── Listener registration ─────────────────────────────────────────────

    node.register = function(addr, handler) {
      const key = addr === 'all' ? 'all' : Number(addr);
      if (!node._listeners.has(key)) node._listeners.set(key, new Set());
      node._listeners.get(key).add(handler);
    };

    node.deregister = function(addr, handler) {
      const key = addr === 'all' ? 'all' : Number(addr);
      if (node._listeners.has(key)) {
        node._listeners.get(key).delete(handler);
        for (const [sub, primary] of node._subaddrMap.entries()) {
          if (primary === key) node._subaddrMap.delete(sub);
        }
      }
    };

    // ── 0xB0 subtype handler ──────────────────────────────────────────────

    function handleSubtype(pktBuf) {
      const p = parsePkt(pktBuf);
      if (!p || p.cmd !== 0xB0 || p.body.length < 8) return;

      const primaryAddr = p.addr;
      const subAddrs = [p.body[4], p.body[5], p.body[6], p.body[7]];

      for (const [sub, primary] of node._subaddrMap.entries()) {
        if (primary === primaryAddr) node._subaddrMap.delete(sub);
      }

      let registered = 0;
      for (const sub of subAddrs) {
        if (sub !== 0xFF && sub >= 0x01 && sub <= 0xFE) {
          node._subaddrMap.set(sub, primaryAddr);
          registered++;
        }
      }

      if (registered > 0) {
        node.log('velbus-bridge: 0x' + primaryAddr.toString(16).toUpperCase() +
          ' subaddresses: ' + subAddrs
            .filter(s => s !== 0xFF)
            .map(s => '0x' + s.toString(16).toUpperCase())
            .join(', '));
      }
    }

    // ── Packet dispatch ───────────────────────────────────────────────────

    function dispatch(pktBuf) {
      if (!Buffer.isBuffer(pktBuf) || pktBuf.length < 6) return;

      const rawAddr = pktBuf[2];
      const cmd     = pktBuf.length >= 5 ? pktBuf[4] : null;

      if (cmd === 0xB0) handleSubtype(pktBuf);

      const deliverAddr = node._subaddrMap.has(rawAddr)
        ? node._subaddrMap.get(rawAddr)
        : rawAddr;

      const addrListeners = node._listeners.get(deliverAddr);
      if (addrListeners) {
        for (const h of addrListeners) {
          try { h(pktBuf); } catch(e) { node.error('velbus-bridge dispatch error: ' + e.message); }
        }
      }

      const allListeners = node._listeners.get('all');
      if (allListeners) {
        for (const h of allListeners) {
          try { h(pktBuf); } catch(e) { node.error('velbus-bridge dispatch error: ' + e.message); }
        }
      }
    }

    // ── TCP connection ────────────────────────────────────────────────────

    function connect() {
      if (node._closing) return;

      function onConnected() {
        node._connected = true;
        node._remainder = Buffer.alloc(0);
        node.log(`velbus-bridge: connected to ${node.host}:${node.port}` +
                 (node.useTLS ? ' (TLS)' : ''));
        if (node.useAuth && node.authKey) sock.write(node.authKey + '\n');
      }

      let sock;
      if (node.useTLS) {
        const tlsOpts = { host: node.host, port: node.port };
        if (node.certPath) {
          // CA supplied: verify the chain but skip hostname check, since
          // velbus-tcp is almost always reached by bare IP address.
          tlsOpts.ca = fs.readFileSync(node.certPath);
          tlsOpts.checkServerIdentity = () => undefined;
        } else {
          // No CA supplied: accept the velbus-tcp snap's self-signed cert.
          tlsOpts.rejectUnauthorized = false;
        }
        if (node.keyPath) tlsOpts.key = fs.readFileSync(node.keyPath);
        sock = tls.connect(tlsOpts);
        // TLS sockets emit 'secureConnect' when the handshake completes.
        // They never emit 'connect' — that fires on the wrapped raw socket.
        sock.on('secureConnect', onConnected);
      } else {
        sock = net.createConnection({ host: node.host, port: node.port });
        sock.on('connect', onConnected);
      }

      node._socket = sock;
      sock.setNoDelay(true);

      sock.on('data', (data) => {
        const combined = Buffer.concat([node._remainder, data]);
        const { packets, remainder } = splitPackets(combined);
        node._remainder = remainder;
        for (const p of packets) dispatch(p);
      });

      sock.on('error', (err) => {
        let msg = `velbus-bridge: socket error — ${err.message}`;
        if (node.useTLS && /certificate|handshake|SSL|TLS/i.test(err.message)) {
          msg += ' (TLS handshake failed — check the auth key and that the ' +
                 'port is the TLS port; leave Cert path empty to accept ' +
                 'velbus-tcp\'s self-signed certificate)';
        }
        node.warn(msg);
      });

      sock.on('close', () => {
        node._connected = false;
        node._socket = null;
        if (!node._closing) {
          node.warn('velbus-bridge: connection lost, reconnecting in 5s');
          node._reconnectTimer = setTimeout(connect, 5000);
        }
      });
    }

    // ── Lifecycle ─────────────────────────────────────────────────────────

    connect();

    node.on('close', (done) => {
      node._closing = true;
      if (node._reconnectTimer) clearTimeout(node._reconnectTimer);
      if (node._socket) { node._socket.destroy(); node._socket = null; }
      // Scan results are intentionally kept — 'close' fires on every full
      // deploy and restart, and dropdowns must survive both.
      done();
    });
  }

  RED.nodes.registerType('velbus-bridge', VelbusBridgeNode);
};

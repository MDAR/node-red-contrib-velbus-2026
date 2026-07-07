'use strict';

const { pkt } = require('../../lib/velbus-utils');

// ─────────────────────────────────────────────────────────────────────────────
// Velbus clock broadcast node
//
// Sends system time (0xD8), date (0xB7), daylight-saving flag (0xAF), and
// wake/sleep clock alarms (0xC3) to the bus. Time/date/DST are broadcast-only
// (address 0x00) — every RTC-equipped module receives and updates its own
// clock from these. This is what a physical Signum master clock module
// normally does; this node lets Node-RED (or the host it runs on) act as
// that time source instead, or as a backup if no Signum clock is fitted.
//
// All commands confirmed against protocol_vmb4ryld_20_vmb4ryno_20_vmb1rys_20.pdf
// (ed.3), and cross-checked identical in protocol_vmb8dc_20.pdf and
// protocol_vmbgp1_20_vmbgp2_20_vmbgp4_20.pdf — this is a shared V2-only
// "system clock" command block, confirmed absent entirely from the
// original-series protocol PDFs. Every V2 module type implements it
// identically; it is not tied to any one module's semantics.
//
//   0xD8 Set real time clock   — DLC=4, body=[0xD8, dayOfWeek, hours, minutes]
//                                 broadcast (0x00) ONLY — no local variant exists.
//   0xB7 Set date              — DLC=5, body=[0xB7, day, month, yearHi, yearLo]
//                                 broadcast (0x00) ONLY — no local variant exists.
//   0xAF Set daylight savings  — DLC=2, body=[0xAF, 0|1]
//                                 broadcast (0x00) ONLY — no local variant exists.
//   0xC3 Set clock alarm       — DLC=7, body=[0xC3, alarm(1|2), wakeHour,
//                                 wakeMinute, bedHour, bedMinute, enable(0|1)]
//                                 IDENTICAL body whether "global" (address
//                                 0x00, every module gets the same alarm) or
//                                 "local" (a specific module address, that
//                                 module only) — the protocol PDF literally
//                                 defines these as two address variants of
//                                 the same command, not two different ones.
//
// dayOfWeek: 0=Monday...6=Sunday (NOT JS Date's 0=Sunday...6=Saturday).
// 0x00 is broadcast-only — never assign it as a real module's own address.
//
// DELIBERATE EXCEPTION to this palette's usual "one node = one physical
// module, fixed configured address" pattern: set_alarm accepts an optional
// per-message address override (msg.payload.address). This is intentional,
// not an oversight — 0xC3 is a bus-wide system command any V2 module can
// receive, not a per-module-type feature like an RGBW device-type setting
// or a thermostat setpoint. Putting "local alarm" support on every relevant
// node type instead (velbus-relay-20, velbus-dimmer-20, velbus-glass-panel,
// etc.) would mean duplicating an identical handler six times over for a
// command that is, by the protocol's own design, address-scoped rather than
// module-type-scoped. If this turns out to want per-module config instead
// (e.g. a dedicated address field with scan-dropdown support, matching every
// other node), that's a reasonable direction to revisit — this was a
// judgement call, not a settled architecture decision.
// ─────────────────────────────────────────────────────────────────────────────

const BROADCAST_ADDR = 0x00;

function velbusDow(jsDay) {
  // JS Date#getDay(): 0=Sunday...6=Saturday. Velbus: 0=Monday...6=Sunday.
  return (jsDay + 6) % 7;
}

// Best-effort DST detection from the host's own configured timezone.
// Standard trick: compare the current UTC offset against the year's two
// solstice-adjacent offsets (Jan 1 / Jul 1). Correct for any timezone that
// observes DST with a single annual transition (UK/EU/US style). Assumes
// the host machine's TZ is set correctly (e.g. Europe/London) — if the
// Node-RED host's clock/timezone is wrong, this will be wrong too.
function isDstActive(d) {
  const jan = new Date(d.getFullYear(), 0, 1);
  const jul = new Date(d.getFullYear(), 6, 1);
  const stdOffset = Math.max(jan.getTimezoneOffset(), jul.getTimezoneOffset());
  return d.getTimezoneOffset() < stdOffset;
}

function clampInt(v, min, max, fallback) {
  const n = parseInt(v);
  if (isNaN(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

module.exports = function(RED) {

  function VelbusClockNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;

    node.bridge         = RED.nodes.getNode(config.bridge);
    node.autoBroadcast   = !!config.autoBroadcast;
    node.intervalMinutes = parseInt(config.intervalMinutes) || 60;
    node.includeDate     = config.includeDate !== false;
    node.includeDst      = config.includeDst !== false;

    if (!node.bridge) {
      node.status({ fill: 'red', shape: 'ring', text: 'no bridge' });
      node.error('velbus-clock: no bridge configured');
      return;
    }

    let _intervalTimer = null;
    let _startupTimer  = null;

    function setStatus(text, fill, shape) {
      node.status({ fill: fill || 'green', shape: shape || 'dot', text });
    }

    // ── Packet senders ────────────────────────────────────────────────────

    function sendTime(d) {
      node.bridge.send(pkt(0xFB, BROADCAST_ADDR, [0xD8, velbusDow(d.getDay()), d.getHours(), d.getMinutes()]));
    }

    function sendDate(d) {
      const year = d.getFullYear();
      node.bridge.send(pkt(0xFB, BROADCAST_ADDR, [0xB7, d.getDate(), d.getMonth() + 1, (year >> 8) & 0xFF, year & 0xFF]));
    }

    function sendDst(active) {
      node.bridge.send(pkt(0xFB, BROADCAST_ADDR, [0xAF, active ? 1 : 0]));
    }

    function sendAlarm(targetAddr, alarmNum, wakeHour, wakeMinute, bedHour, bedMinute, enabled) {
      node.bridge.send(pkt(0xFB, targetAddr,
        [0xC3, alarmNum, wakeHour, wakeMinute, bedHour, bedMinute, enabled ? 1 : 0]));
    }

    // Resolves msg.payload.address to a target address for set_alarm.
    // Omitted/empty → broadcast (global alarm, every module). A valid
    // 1-254 address (decimal or hex string) → that module only (local alarm).
    function resolveTargetAddr(addrIn) {
      if (addrIn === undefined || addrIn === null || addrIn === '') {
        return { addr: BROADCAST_ADDR, label: 'global (0x00)' };
      }
      const a = (typeof addrIn === 'number') ? addrIn : parseInt(addrIn, 16);
      if (isNaN(a) || a < 1 || a > 254) {
        node.warn('velbus-clock: invalid address "' + addrIn + '" for set_alarm — sending globally instead');
        return { addr: BROADCAST_ADDR, label: 'global (0x00)' };
      }
      return { addr: a, label: 'local (0x' + a.toString(16).padStart(2, '0').toUpperCase() + ')' };
    }

    function broadcastAll(d, opts) {
      if (!node.bridge.isConnected()) {
        node.warn('velbus-clock: bridge not connected, broadcast skipped');
        setStatus('not connected', 'red');
        return;
      }

      sendTime(d);
      if (opts.date) sendDate(d);

      let dst = null;
      if (opts.includeDst) {
        dst = (typeof opts.dstOverride === 'boolean') ? opts.dstOverride : isDstActive(d);
        sendDst(dst);
      }

      setStatus('sent ' + d.toTimeString().slice(0, 8) +
        (opts.date ? ' + date' : '') +
        (opts.includeDst ? (' + DST:' + (dst ? 'on' : 'off')) : ''), 'green');

      node.send({
        payload: {
          topic:     'clock_broadcast',
          dayOfWeek: velbusDow(d.getDay()),
          hours:     d.getHours(),
          minutes:   d.getMinutes(),
          date:      opts.date ? { day: d.getDate(), month: d.getMonth() + 1, year: d.getFullYear() } : null,
          dst,
          timestamp: d.getTime()
        }
      });
    }

    // ── Input ─────────────────────────────────────────────────────────────
    // Bare inject (empty payload) triggers a full broadcast using node
    // config defaults — no msg shaping required for the common case.

    node.on('input', function(msg) {
      const inp = (msg && msg.payload && typeof msg.payload === 'object') ? msg.payload : {};
      const cmd = inp.cmd || 'broadcast';

      let when = inp.date ? new Date(inp.date) : new Date();
      if (isNaN(when.getTime())) {
        node.warn('velbus-clock: invalid msg.payload.date, using current time instead');
        when = new Date();
      }

      switch (cmd) {
        case 'broadcast':
          broadcastAll(when, { date: node.includeDate, includeDst: node.includeDst, dstOverride: inp.dst });
          break;

        case 'broadcast_time':
          if (!node.bridge.isConnected()) { node.warn('velbus-clock: bridge not connected'); return; }
          sendTime(when);
          setStatus('sent time ' + when.toTimeString().slice(0, 8), 'green');
          break;

        case 'broadcast_date':
          if (!node.bridge.isConnected()) { node.warn('velbus-clock: bridge not connected'); return; }
          sendDate(when);
          setStatus('sent date ' + when.toDateString(), 'green');
          break;

        case 'broadcast_dst': {
          if (!node.bridge.isConnected()) { node.warn('velbus-clock: bridge not connected'); return; }
          const dst = (typeof inp.dst === 'boolean') ? inp.dst : isDstActive(when);
          sendDst(dst);
          setStatus('sent DST:' + (dst ? 'on' : 'off'), 'green');
          break;
        }

        case 'set_alarm': {
          const alarmNum = parseInt(inp.alarm);
          if (alarmNum !== 1 && alarmNum !== 2) {
            node.warn('velbus-clock: set_alarm requires "alarm": 1 or 2');
            return;
          }
          if (!node.bridge.isConnected()) { node.warn('velbus-clock: bridge not connected'); return; }

          const wakeHour   = clampInt(inp.wakeHour,   0, 23, 0);
          const wakeMinute = clampInt(inp.wakeMinute, 0, 59, 0);
          const bedHour    = clampInt(inp.bedHour,    0, 23, 0);
          const bedMinute  = clampInt(inp.bedMinute,  0, 59, 0);
          const enabled    = inp.enabled !== false; // default true — set_alarm implies enabling it

          const { addr: targetAddr, label } = resolveTargetAddr(inp.address);

          sendAlarm(targetAddr, alarmNum, wakeHour, wakeMinute, bedHour, bedMinute, enabled);

          setStatus('alarm ' + alarmNum + ' ' + (enabled ? 'set' : 'disabled') + ' — ' + label, 'green');

          node.send({
            payload: {
              topic:      'alarm_set',
              target:     targetAddr === BROADCAST_ADDR ? 'global' : ('0x' + targetAddr.toString(16).padStart(2, '0').toUpperCase()),
              alarm:      alarmNum,
              wakeHour, wakeMinute, bedHour, bedMinute,
              enabled
            }
          });
          break;
        }

        default:
          node.warn('velbus-clock: unknown cmd "' + cmd + '"');
      }
    });

    // ── Auto broadcast ────────────────────────────────────────────────────

    if (node.autoBroadcast) {
      const intervalMs = Math.max(1, node.intervalMinutes) * 60000;

      function tick() {
        broadcastAll(new Date(), { date: node.includeDate, includeDst: node.includeDst });
      }

      // Delayed first send — give the bridge a moment to connect after deploy.
      _startupTimer  = setTimeout(tick, 5000);
      _intervalTimer = setInterval(tick, intervalMs);
    }

    node.on('close', function() {
      if (_startupTimer)  clearTimeout(_startupTimer);
      if (_intervalTimer) clearInterval(_intervalTimer);
    });

    setStatus('ready', 'grey');
  }

  RED.nodes.registerType('velbus-clock', VelbusClockNode);
};

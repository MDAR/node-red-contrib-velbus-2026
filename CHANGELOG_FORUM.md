# node-red-contrib-velbus-2026 — Development Changelog

**Author:** Stuart Hanlon, MDAR Limited (UK Velbus distributor)
**GitHub:** https://github.com/MDAR/node-red-contrib-velbus-2026
**npm:** node-red-contrib-velbus-2026
**Status:** Active development — real hardware tested on live client installations

This palette is a ground-up rewrite for modern Node-RED (v3+/v5) with full
V2.0 (-20 series) module support. It replaces the abandoned `node-red-contrib-velbus`
palette (gertst, last updated 2020).

Testers welcome — particularly anyone with hardware not listed as confirmed below.
All feedback via GitHub issues, with examples and debug captures where possible.

---

## v0.9.2 — 09/07/2026

### velbus-glass-panel — VMBGPOD (0x28) registry gap fixed

- **Found by Stuart:** scanning his own home installation showed `unknown_0x28`
  for three real modules — the palette had never included this type at all.
- **Real-world significance:** per the VLP training dataset analysed earlier
  in this project, VMBGPOD is one of the **most common** glass panel types
  in the field (978 occurrences, second only to VMB4RYLD and VMBDMI-R) — a
  genuine, consequential gap, not an edge case. Only its V2 sibling
  (`VMBGPOD-2`, 0x3D) had ever been added.
- Added to both `lib/glass-panel-types.js` (server-side) and the duplicate
  type list in `velbus-glass-panel.html` (editor-side dropdown/display) —
  confirmed both needed updating, not just one.
- **Confirmed from protocol_vmbgpod.pdf:** OLED display present; no
  open-collector commands anywhere in the document (distinct from `VMBGPO`,
  0x21, a different product despite the similar name — that one does have
  OC support).
- **One real mistake caught and corrected before shipping:** first pass
  copied the channel count (32) from `VMBGPO` on the assumption it was the
  closest sibling. Cross-checking the editor's own duplicate type list
  before finalising showed `VMBGPOD-2` — the *actual* V2 sibling of this
  same product line — lists 4 channels, not 32. Corrected to 4. Worth
  remembering: when modelling a new registry entry on an existing one,
  check for a same-name generational sibling before assuming the
  closest-looking name is the right reference.
- Also identified in the same scan, **not yet added:** `VMBKP` (0x42,
  "Keypad interface module") — a substantial 28-page protocol with its own
  per-channel LED control layer, genuinely new territory rather than a
  quick registry addition. Flagged for separate scoping, same approach as
  velbus-energy before it was built.

---

## v0.9.1 — 08/07/2026

### Address validation bug — 12 of 19 node types, any address ≥100 decimal

- **Reported by Stuart:** adding a velbus-sensor node and selecting VMB4AN
  from the scan dropdown showed a red "not configured correctly" triangle
  no matter what was selected.
- **Root cause:** every node using the `address` field (as opposed to
  `moduleAddr`, used by relay/dimmer nodes, which were unaffected) validated
  it against `/^(0x)?[0-9a-fA-F]{1,2}$/` — a pattern that only ever made
  sense if `address` were stored as a 1-2 character hex string. But
  `oneditsave` on every one of these nodes stores it as a plain decimal
  **number** instead (`parseInt(...)`). Since regex `.test()` coerces its
  argument to a string first, any address whose decimal representation is
  1-2 digits (1-99) happened to accidentally still match — every digit
  0-9 is also a valid hex character — masking the bug for low addresses.
  Any address **100 or higher** (`0x64`+) produces a 3-digit decimal string,
  which cannot match a `{1,2}`-length pattern, so validation always failed.
  100-254 is a very ordinary real-world address range — this was a live,
  fully user-facing bug, not an edge case.
- **Affected nodes (12):** velbus-blind, velbus-blind-s, velbus-blind-20,
  velbus-button, velbus-energy, velbus-glass-panel, velbus-meteo,
  velbus-pir, velbus-pir-20, velbus-sensor, velbus-sensor-20,
  velbus-thermostat. Confirmed relay/dimmer/relay-20/dimmer-20 (which use
  `moduleAddr`, no custom validate function) and velbus-clock (no fixed
  address at all) were never affected.
- **Fix:** replaced the regex with a direct numeric range check
  (`parseInt(v)` between 1 and 254 inclusive) — correct regardless of
  whether the stored value is a number, a decimal string, or a legacy hex
  string (`parseInt` auto-detects a `0x` prefix), so old saved flows keep
  working unchanged.
- Verified: syntax-checked the extracted JS from all 12 files, and
  confirmed the corrected logic against the actual failing range (50/80/99
  → true both before and after; 100/150/254 → **false before, true after**;
  0/255/empty/non-numeric → false, correctly rejected as invalid addresses
  both before and after).

---

## v0.9.0 — 08/07/2026

### velbus-energy — new node (19th node), VMBPSUMNGR-20

- **Closes the last "not yet built" item on the module registry** —
  VMBPSUMNGR-20 (0x04), the power-supply-manager module, following the same
  V2 architectural pattern as `velbus-sensor-20` (firmware/type check, name
  auto-retrieval, standard startup RTR).
- Handles: `0xED` module status (PSU load %ages, alarm bitmasks, shared
  program/clock-alarm/sunrise/sunset byte), `0x00` real-time alarm events
  (arrives via primary address as one bitmask, via sub-address1 as a second
  bitmask — same command, discriminated by source address, merged into
  running alarm state so a partial update never discards the other half),
  `0xA1` warranty counter (31-bit hours-in-operation + expired flag, packed
  across 4 bytes), `0xA2` PSU load status (mode + 3 load percentages), `0xA3`
  PSU values (wattage/voltage/amperage per rail, one message per PSU/PSUOut).
- **Does not reimplement the shared V2 "system" commands** (real-time clock,
  date, DST, sunrise/sunset, clock alarm) present throughout this PDF —
  `velbus-clock` already owns broadcasting those; duplicating them here
  would just be dead weight.
- **Two real errors found in Velbus's own protocol PDF while implementing
  this, both documented in the node's source comments:**
  - The document header reads "VMB8IN-20 PROTOCOL" throughout — an
    un-retitled template artifact from a different module's document.
  - The `0xA3` (PSU values status) section labels three different byte
    positions all as "DATABYTE6" (voltage high, amperage high, amperage
    low) — internally inconsistent with its own stated 8-byte length.
    Reconstructed from the byte count as DATABYTE5/6 = voltage hi/lo,
    DATABYTE7/8 = amperage hi/lo. Same category as the temperature-divisor
    and build-number-mislabelling issues already known elsewhere in this
    project — worth remembering if re-checking against the source PDF.
- Verified with the mock-RED harness: every packet type (module type
  identification, both alarm bitmask sources, module status, warranty
  counter, PSU load, PSU values, name assembly across all three name-part
  commands) exercised with hand-checked checksums; outgoing commands
  (`get_status`, `get_warranty`, `get_name`) checksum-verified by hand
  against the actual bytes produced. **Not yet sent to a real bus** — no
  VMBPSUMNGR-20 has been confirmed present on a scanned bus yet (see the
  handover's outstanding-verification notes).

---

## v0.8.1 — 07/07/2026

### velbus-clock — set_alarm command (global + local, one command)
- **Prompted by Stuart's question:** is velbus-clock the right place for
  per-module ("local") alarm time updates, given the packet is identical to
  the global broadcast version, differing only in destination address?
- **Confirmed:** `0xC3` (Set Clock Alarm) is a shared V2-only system command,
  byte-identical across relay-20, dimmer-20, and glass-panel-20 protocol
  PDFs, and confirmed absent entirely from the original-series PDFs — same
  V2-only "system clock" block as 0xD8/0xB7/0xAF. It is not tied to any one
  module type's semantics.
- **Decision:** kept in velbus-clock rather than duplicated across every V2
  node type. `msg.payload.address` omitted → global (broadcast to 0x00,
  every module gets the same alarm); provided → local (that module only).
  Documented explicitly in the node's doc comment and help as a deliberate
  exception to the palette's usual one-node-per-module-address pattern —
  flagged as a judgement call, not a settled architecture decision, in case
  a dedicated per-module config field (with scan-dropdown support, matching
  every other node) turns out to be wanted later instead.
- Verified with the mock-RED harness: checksum hand-checked, global vs local
  addressing confirmed identical body/different destination, hex-string vs
  decimal address input both resolve correctly, invalid alarm number and
  invalid address (e.g. 0xFF, out of the 1-254 module range) both rejected
  with a clear warning rather than silently sending garbage. **Not yet sent
  to a real bus.**

---

## v0.8.0 — 06/07/2026

### velbus-clock — new node (18th node)
- **Requested by Stuart:** broadcast system time/date to bus address `0x00`.
  No existing node covered this.
- Sends `0xD8` (Set real time clock: day-of-week, hour, minute), `0xB7`
  (Set date: day, month, year — optional, on by default), and `0xAF` (Set
  daylight savings — optional, on by default) to the broadcast address
  `0x00`, at low priority. Confirmed against
  `protocol_vmb4ryld_20_vmb4ryno_20_vmb1rys_20.pdf` (ed.3) — this is a
  bus-wide broadcast command set shared across the whole module family,
  not per-module, so there's only one place to get it right.
- Manual trigger via input (bare inject broadcasts using config defaults +
  current system time), or `autoBroadcast` config option for a periodic
  send on a configurable interval (first send 5s after deploy).
- `msg.payload.date` can override the time/date sent (useful for testing);
  `msg.payload.dst` can override the auto-detected DST flag.
- DST auto-detected from the Node-RED host's own configured timezone
  (Jan-1/Jul-1 offset comparison) — correct for UK/EU/US-style single-
  transition DST, only as accurate as the host's own clock/TZ setting.
- Added `velbus-bridge.isConnected()` — a small public accessor so nodes
  can check connection state without reaching into the underscore-prefixed
  `_connected` internal field. Used by velbus-clock to avoid sending into
  a dead socket and to report a clear "not connected" status instead of a
  generic dropped-packet warning.
- Verified with a mock-RED test harness (not real hardware): checksum,
  DLC, and byte layout hand-verified for a known date/time; day-of-week
  conversion (JS Sunday-first → Velbus Monday-first) checked against
  today's actual weekday; all four input commands and the not-connected/
  invalid-date edge cases exercised. **Not yet sent to a real bus** —
  worth confirming a module's clock actually updates before relying on it.

---

## v0.7.10 — 06/07/2026

### velbus-relay + velbus-relay-20 — per-pulse "channel switched" broadcast fixed
- **Reported by Stuart:** after the v0.7.9 interval_timer fix, VelbusLink showed
  a status change on every pulse start/stop while blinking, but Node-RED only
  showed the start and end of the timer.
- **Root cause:** the `0x00` "channel switched" broadcast handler in both nodes
  required `pri === 0xFB` (low priority) before processing the packet. Checked
  against `protocol_vmb4ryld_10.pdf` / `protocol_vmb4ryld_20_vmb4ryno_20_
  vmb1rys_20.pdf` and the official `packetprotocol` README's priority table:
  this broadcast is sent at **high priority (`0xF8`)**, the opposite of what
  the filter required. Every occurrence was silently dropped — the filter had
  never once matched, on either node, since it was added.
- **Fix:** removed the priority gate entirely (nothing else in either file
  filters by priority, and `cmd === 0x00` has only one defined meaning for a
  relay module, so no filter is needed). The `relay_switched` event
  (`state: 'on'` / `state: 'off'`) now fires on every pulse edge during
  `interval_timer` blinking, and on every local push-button-driven switch —
  both previously invisible to Node-RED.
- **Note:** the separate `relay_status` (`0xFB`) message legitimately does
  NOT toggle per pulse — the protocol's status byte only distinguishes
  off/on/"interval timer on" as three fixed states, with no per-pulse
  encoding. Seeing `relay_status` fire only at start/end while
  `relay_switched` fires on every pulse is correct behaviour, not a
  remaining bug.

---

## v0.7.9 — 02/07/2026

### velbus-relay — interval_timer bug fixed (real cause: wrong protocol read, not just byte overflow)
- **Root cause:** `interval_timer` built an 11-byte body
  (`[0x0D, chBit, duration×3, pulse×3, pause×3]`) against a protocol that
  only ever carries ONE 24-bit time parameter for this command. Confirmed
  against the official protocol PDFs for every module this node covers
  (VMB4RYLD, VMB4RYLD-10, VMB4RYNO, VMB4RYNO-10, VMB1RYNO, VMB1RYNOS,
  VMB1RYS): `0x0D` = COMMAND_START_BLINK_RELAY_TIMER, DLC=5,
  body = `[0x0D, relay bit, time-hi, time-mid, time-lo]`.
  The "pulse"/"pause" fields the previous implementation expected only
  exist in a completely different table — the push-button local Action
  code list (H'16'-H'18', written to module memory to program what a
  physical button does) — not in this live bus command at all. An 11-byte
  body exceeds the maximum for any Velbus frame, so the malformed packet
  never reached the bus — consistent with the reported symptom (every
  other command visible in VelbusLink, this one absent entirely).
- **Fix:** `interval_timer` now sends only `duration` (seconds, `-1`/`0xFFFFFF`
  = permanent blinking). The module blinks at its own fixed rate — there is
  no bus command to set a custom on/off rate.
- **velbus-relay-20 — command removed, not fixed.** The same fictitious
  three-parameter command existed here too, but checking the V2 protocol PDF
  (VMB4RYLD-20/VMB4RYNO-20/VMB1RYS-20, ed.3) found there is no equivalent
  live bus command at all for V2 relays. An "interval timer running" status
  bit exists in the 0xFB status packet, but it can only be triggered by
  writing a Program Step (0xC0/0xC2, Action code 22) to module memory,
  linked to a button or scenario — commissioning-agent territory, not a
  live command. `interval_timer` on velbus-relay-20 now warns clearly
  instead of silently sending nothing useful.

---

## v0.7.8 — 02/07/2026

### velbus-dimmer-20 — VMB4LEDPWM-20 grouping mode verification (read-only)
- Implements the settings-API read path resolved in commissioning roadmap
  Appendix A.0.2: per-channel "Device Type" (settings index 25), read via
  0xE7 request / 0xE8 reply. Never writes — writing the grouping mode
  remains a deliberate commissioning-time decision outside this palette.
- New input command `get_device_type` — reads back the actual Device Type
  setting for a channel and reports the detected grouping mode
  (`single`/`rgb`/`rgbw`) on output 1.
- New 0xE8 reply handler decodes the full Device Type value table
  (`lib/dimmer-types-20.js`: `DEVICE_TYPE_NAMES`).
- Automatic mismatch warning on output 2 if channel 1's detected grouping
  mode disagrees with the node's configured `ledMode` — catches the case
  where the config was set before the physical wiring was confirmed, or
  where wiring changed after commissioning.
- HTML help updated to remove now-stale "read the PDF for the memory
  address" guidance (Priority 1 in the master handover is closed).

---

## v0.6.0 — 28/06/2026

### Package rename and npm publication prep
- Package renamed from `node-red-contrib-velbus2` to `node-red-contrib-velbus-2026`
- Version bumped to 0.6.0 for first public release
- `package.json` updated with full npm publication metadata:
  - `keywords`: node-red, velbus, building-automation, home-automation, smart-home, relay, dimmer
  - `repository`, `bugs`, `homepage` all pointing to GitHub
  - `author`: Stuart Hanlon, MDAR Limited
  - `license`: MIT
- `README.md` added — module list, quick start, confirmed hardware, contributing guide
- `LICENSE` added — MIT
- Disclaimer added to all 17 node HTML help sections:
  *"Generated with Claude.ai — in need of extensive field testing before commercial
  deployment. Presented as-is, use beyond testing at your own risk. File issues on GitHub."*

### Handover document
- Complete ground-up rewrite of `velbus2_master_handover.md`
- Now 970 lines, supersedes all previous baseline files
- Added Appendix A: Virtual Module Kit (parked — new module set: VMB1RYS/VMB7IN,
  VMB1RYNO, VMB4DC, VMB4AN)
- Added Appendix B: npm publication steps, GitHub repo creation walkthrough,
  disclaimer text for help files

---

## v0.5.8 — 27/06/2026

### velbus-blind-20 (new node)
- V2 blind/shutter motor controller — VMB2BLE-20 (0x61)
- Full V2 redesign: CAN FD support, 8-byte 0xFF with properties byte,
  firmware check on startup, channel name auto-retrieval
- **0xEC status packet completely restructured vs BLS/BLE series** — both
  channels packed into a single packet using nibble encoding rather than
  separate per-channel packets. Status, position, lock state, and auto mode
  are all dual-nibble fields.
- Channel identifier in commands: plain integer 1, 2, or 0xFF for all — not
  a bit value as in BLS/BLE series
- Position 0-100%, full lock/force/inhibit set, auto modes, sunrise/sunset
- Additional commands vs BLS/BLE: `enable_program` (0xB2), `disable_program` (0xB1)
- Note: 0xFFFFFF (permanent) NOT allowed for up/down timeout on this module —
  maximum is 0xFFFFFE. Permanent allowed for lock/force/inhibit duration.
- Input commands: `stop`, `up`, `down`, `position`, `lock`, `unlock`,
  `forced_up`, `cancel_forced_up`, `forced_down`, `cancel_forced_down`,
  `inhibit`, `cancel_inhibit`, `inhibit_preset_up`, `inhibit_preset_down`,
  `auto_mode`, `enable_program`, `disable_program`, `get_status`, `get_name`

### velbus-scan corrections (from official Velbus module ID list)
The following type byte assignments were wrong and have been corrected:

| Type | Was | Now |
|---|---|---|
| 0x0C | VMBRSUSB | VMB1TS (temperature sensor) |
| 0x18 | VMBUSBIP | VMB2PBN (2-button panel with night mode) |
| 0x1C | VMB4PB | REMOVED — 0x1C not in official list |
| 0x20 | VMB6PB-20 | VMBGP4 (4-button glass panel) — added to glass-panel-types.js |
| 0x40 | (missing) | VMBUSBIP (moved from 0x18) |
| 0x44 | (missing) | VMB4PB (added) |
| 0x4C | (missing) | VMB6PB-20 (added) |

velbus-button node suggestion updated: now covers 0x18 (VMB2PBN, 2ch),
0x44 (VMB4PB, 4ch), 0x4C (VMB6PB-20, 6ch). Previous incorrect 0x1C and
0x20 entries removed.

VMBGP4 (0x20) added as 26th type in `lib/glass-panel-types.js`.

### lib/blind-types-20.js (new)
- Type registry for V2 blind series: VMB2BLE-20

---

## v0.5.7 — 27/06/2026

### velbus-blind (new node)
- Original series blind/shutter motor controllers — VMB1BL (0x03), VMB2BL (0x09)
- Early modules: 5-byte 0xFF response (no serial number), dip-switch timeout
  setting, no position feedback, no lock/force/inhibit
- VMB1BL: 1 channel, fixed channel byte 0x03, local push button events mixed
  into 0x00 bitmask alongside relay events
- VMB2BL: 2 channels, packed bitmask channel encoding (ch1=0x03, ch2=0x0C),
  local push button events included in 0x00
- Stop/up/down commands only. Timeout 0=dip switch, 0xFFFFFF=permanent
- Input commands: `stop`, `up` (with timeout), `down` (with timeout),
  `get_status`, `get_name`
- Address dropdown filters to VMB1BL/VMB2BL types from scan results

### velbus-blind-s (new node)
- Full-featured BLS/BLE series — VMB1BLS (0x2E), VMB2BLE (0x1D),
  VMB2BLE-10 (0x4A)
- 7-byte 0xFF with serial number and memory map version
- Position feedback (0-100%): 0=fully up, 100=fully down
- Lock/unlock (0x1A/0x1B — unique command bytes to blind family)
- Forced up (0x12) / forced down (0x14) — note: same bytes as relay forced-off/on
  but inverted direction semantics in blind context
- Full inhibit set: `inhibit`, `inhibit_preset_up`, `inhibit_preset_down`,
  `cancel_inhibit`
- Auto modes (1-3), sunrise/sunset, real-time clock
- VMB2BLE-10 confirmed protocol-identical to VMB2BLE — only structural difference
  is 8-byte 0xFF (with terminator byte vs 7-byte). Handled by same node.
- No local push button events in 0x00 (relay events only, unlike VMB1BL/VMB2BL)
- Two outputs: relay events on output 1, full 0xEC status on output 2
- Input commands: `stop`, `up`, `down`, `position`, `lock`, `unlock`,
  `forced_up`, `cancel_forced_up`, `forced_down`, `cancel_forced_down`,
  `inhibit`, `cancel_inhibit`, `inhibit_preset_up`, `inhibit_preset_down`,
  `auto_mode`, `get_status`, `get_name`

### lib/blind-types.js (new)
- Type registry for original series blind modules: VMB1BL, VMB2BL
- channelMasks: packed bitmask per channel for 0xEC and commands

### lib/blind-types-s.js (new)
- Type registry for BLS/BLE series: VMB1BLS, VMB2BLE, VMB2BLE-10
- channelBits: clean bit encoding (ch1=0x01, ch2=0x02)

---

## v0.5.6 — 27/06/2026

### velbus-meteo (new node)
- Weather station node for VMBMETEO (0x31)
- Output 1: alarm events (0x00) and module status (0xED)
- Output 2: temperature (0xE6), rain/light/wind (0xA9), sensor text (0xAC)
- 8 configurable alarm outputs via bitmask — alarm conditions (wind speed,
  rainfall, light levels) configured in VelbusLink, fired as 0x00 events
- `0xA9` carries rain (×0.1 mm/h), light (lux), wind (×0.1 km/h) as three
  16-bit values in one packet — emitted with engineering units applied
- `0xAC` sensor text: same command byte as OLED memo on glass panels but
  completely different meaning — formatted sensor value string from module
- `0xF0/F1/F2` alarm channel names use **bitmask** in DB2 (not channel number)
- Auto-send interval: values 5-9 = percentage-change thresholds, not fixed seconds
- Input commands: `get_status`, `get_temp`, `get_meteo` (sensor: rain/light/wind/all),
  `get_alarm_name` (channel 1-8), `test_on`, `test_off`

### velbus-sensor (new node)
- Original series configurable input node — VMB7IN (0x22), VMB4AN (0x32)
- Output 1: channel events (0x00) and module status (0xED)
- Output 2: pulse counter data (VMB7IN only — 0xBE)
- VMB7IN: 8 digital input channels + pulse counter on channels 1-4
  - All 8 channels produce 0x00 press/release/long-press events regardless of
    input type (contact closure, alarm threshold — configured in VelbusLink)
  - Counter: 32-bit pulse count + period in ms between last two pulses
  - Engineering units must be calculated in flow using pulsesPerUnit and periodMs
  - Power (W) = 3,600,000,000 / (periodMs × pulsesPerUnit)
- VMB4AN: 16 logical channels across 3 groups (architecture defined; groups 2
  and 3 deferred to follow-up session pending hardware availability)
- Channel names use **bitmask** in DB2 of 0xF0/F1/F2
- Lock/unlock use **bitmask** in DB2
- Input commands: `get_status`, `get_counter` (channels bitmask + interval),
  `reset_counter` (channel 1-4), `load_counter` (channel + value), `get_name`
- Note: VMB7IN 0xED PDF states DLC=5 but lists 7 fields — implementation
  treats as 7 bytes. Verify against real hardware.

### velbus-sensor-20 (new node)
- V2 series configurable input node — VMB8IN-20 (0x4E)
- Output 1: channel events (0x00) and module status (0xED)
- Output 2: energy counter data (0xA4)
- Up to 32 digital input channels: 8 on primary address, 24 via 3 subaddresses
  (channels 9-16, 17-24, 25-32). Bridge routes subaddress packets to primary
  node listener transparently.
- 0x00 channel event payload includes `sourceAddress` field to distinguish
  primary from subaddress events
- 0xED from primary (8 bytes): full status including normal/inverted, auto-send
- 0xED from subaddress (5 bytes): alarm status, enabled, locked, prog-disabled
- `0xA4` energy counter: 20-bit power in Watts + 32-bit energy in Wh/litres/ml
  (counter type set in VelbusLink — same packet format for all)
- Firmware check on startup (3-stage: type → map version → pass)
- Module name auto-retrieved from VelbusLink on startup
- Lock/unlock use **channel number** (1-32, 0xFF for all) — V2 style
- Channel names use **channel number** in DB2
- Input commands: `get_status`, `get_counter` (channels bitmask + interval),
  `load_counter` (channel + value), `lock`, `unlock`, `get_name`

### velbus-scan corrections
- VMB7IN (0x22) added to ALL_TYPES, NODE_SUGGESTION (velbus-sensor), MODULE_CHANNELS (8ch)
- VMB8IN-20 (0x4E) added — type byte was previously unknown
- VMBMETEO (0x31) now has node suggestion: velbus-meteo
- VMB4AN (0x32) node suggestion updated: velbus-sensor
- VMB2BLE (0x1D), VMB2BLE-10 (0x4A), VMB2BLE-20 (0x61) relabelled from
  incorrect 'BLE (Bluetooth)' to 'blind (motor controller)' — these are
  single/dual channel reversible AC motor controllers for roller shutters
  and blinds. VMB = Velbus Motor Blind. No Bluetooth involved.

### lib/sensor-types.js (new)
- Type registry for original series sensor modules: VMB7IN, VMB4AN
- Flags: hasCounter, hasAnalogue, lockStyle, nameStyle, counterCh

### lib/sensor-types-20.js (new)
- Type registry for V2 sensor modules: VMB8IN-20
- Flags: hasCounter, lockStyle, nameStyle, alarmCh (subaddress alarm channels)

---

## v0.5.5 — 27/06/2026

### velbus-pir (new node)
- Original and -10 series PIR modules — VMBPIRM (0x2A), VMBPIRC (0x2B),
  VMBPIRO (0x2C), VMBPIRO-10 (0x23)
- Output 1: channel events, module status, light value
- Output 2: temperature and settings — VMBPIRO and VMBPIRO-10 only
- Channel bitmask model: bits 0-5 = dark/light/motion1/ldMotion1/motion2/ldMotion2.
  VMBPIRM and VMBPIRC add bit6=absence. VMBPIRO and VMBPIRO-10 add
  bit6=lowTempAlarm / bit7=highTempAlarm instead.
- Lock/unlock/enable/disable program commands use **channel bitmask** in DB2
- `0xE8` temperature settings: compact 7-byte format (calibration offset, gain,
  low alarm, high alarm, zone, auto-send interval)
- Input commands: `get_status`, `get_light` (with optional auto-send interval),
  `get_temp`, `get_temp_settings`, `test_on`, `test_off`
- Address dropdown filters to PIR original/-10 types from scan results
- Note: VMBPIRM has a light sensor (required for dark/light output logic) but
  its PDF does not list raw lux value as bus-accessible. Node handles 0xA9
  if received; `get_light` command sent regardless.

### velbus-pir-20 (new node)
- V2 series PIR modules — VMBPIR-20 (0x4D), VMBPIRO-20 (0x59)
- Output 1: channel events, module status, light value
- Output 2: temperature and settings — VMBPIRO-20 only
- VMBPIR-20: 7 channels (dark/light/motion1/ldMotion1/motion2/ldMotion2/absence)
- VMBPIRO-20: 6 lockable channels + bits 6-7 = lowTempAlarm/highTempAlarm
  (temperature alarm bits appear in 0x00 and 0xED but are not lockable)
- Lock/unlock commands use **channel number** (1-N, 0xFF for all) — not bitmask
- Firmware check on startup (3-stage: type → map version → pass)
- Module name auto-retrieved from VelbusLink on startup
- CAN FD flag decoded from 0xFF properties byte
- `0xE8` on VMBPIRO-20: multi-part glass-panel-style format inherited from
  thermostat firmware; only calibration and alarm fields in part 1 are meaningful
- Input commands: `get_status`, `get_light`, `get_temp`, `get_temp_settings`,
  `lock` (channel + duration), `unlock` (channel), `test_on`, `test_off`

### velbus-scan
- VMBPIRM (0x2A), VMBPIRC (0x2B), VMBPIRO (0x2C), VMBPIRO-10 (0x23) added
  to ALL_TYPES, NODE_SUGGESTION, and MODULE_CHANNELS
- `velbus-pir` suggested for all four original/-10 types

### lib/pir-types.js (new)
- Type registry for original/-10 PIR series: hasTempSensor, lockStyle,
  channel name arrays, minMapVer, series

### lib/pir-types-20.js (new)
- Type registry for V2 PIR series: hasTempSensor, lockStyle, channel maps,
  bitmask arrays (for 0x00/0xED parsing), minMapVer, series

---

## v0.5.4 — 27/06/2026

### Protocol parser corrections (velbus-glass-panel, velbus-thermostat)

A systematic body-indexing error was present in all glass-panel and thermostat
packet handlers. `parsePkt()` returns `body[]` where `body[0]` is DATABYTE1 —
the command byte — and data starts at `body[1]`. All handlers have been
corrected.

- **0xEA thermostat status** — format was incorrectly implemented as 16-bit
  integers divided by 100. Correct format per protocol PDFs: signed single bytes
  at 0.5° resolution for temperature values, with operating mode, output status,
  and sleep timer as separate fields. Mode (comfort/day/night/safe), heater/cooler
  direction, and active outputs (heating, cooling, boost) now correctly decoded.
- **0xE6 current temperature** — format corrected to 16-bit signed value divided
  by 16 (0.0625° resolution), not divided by 100.
- **0xE8 temperature settings** — format corrected to signed single bytes at 0.5°
  resolution. Payload now includes `current`, `comfort`, `day`, `night`, `safe`
  heating presets.
- **0xED module status** — full structured parse implemented. DATABYTE4 correctly
  decoded: open collector on/off, OC locked, OC program disabled, temperature
  sensor program disabled, edge colour inhibited. Locked and programme-disabled
  channel bitmasks now correctly extracted from DATABYTE5 and DATABYTE6.
- **0xF0/F1/F2 name parts** — command and channel-number bytes now stripped before
  storing; `0xFF` padding filtered in name assembly alongside null bytes.
- **0xA9, 0xAC, 0xBE** — body indices corrected.

### Open collector output

- `output_timer` command fixed — duration is 24-bit (3 bytes), not 16-bit.
  Supports up to ~194 days; `0xFFFFFF` = permanently on.
- `0xED` handler now emits OC state in the status payload for modules with a
  confirmed open collector output:
  ```json
  { "type": "status", ..., "output": { "on": true, "locked": false, "programDisabled": false } }
  ```
- `hasOc` flag added to all 25 types in `lib/glass-panel-types.js`. OC confirmed
  from PDF for the full VMBEL family (original and -20) and VMBGPO/-20. OC
  absent from VMBGP1-2/2-2/4-2 per protocol PDF. Remaining GP types pending
  hardware verification (UK, post July 2026).

### velbus-glass-panel
- Button output payload now includes `on` boolean — `true` when any channel is
  pressed or long-pressed.

### velbus-thermostat
- Spurious `on` field removed from 0xEA, 0xE6, 0xE8 and 0xED payloads.
  `thermostatOn` in the thermostat payload is the correct state field.
- Temperature and settings payloads do not carry an `on` field.

---

## v0.5.3 — 27/06/2026

### Payload and type table cleanup

- Button output `on` boolean added to `velbus-glass-panel` 0x00 handler (was
  present in `velbus-button` but missing from glass panel).
- Config dialog address dropdowns fixed across all three affected nodes
  (`velbus-glass-panel`, `velbus-thermostat`, `velbus-button`) — endpoint returns
  `{ modules: [...], count: N }` and dialogs were operating on the wrapper object
  instead of `modules`.
- `lib/glass-panel-types.js`: VMBGP1 (0x1E, 1ch) and VMBGP2 (0x1F, 2ch) added
  — 23 → 25 types.
- `velbus-scan` NODE_SUGGESTION and MODULE_CHANNELS updated for 0x1E and 0x1F.

---

## v0.5.2 — 27/06/2026

### velbus-button (new node)
- Pure button/input node — press, release, long-press events on 0x00
- Supports VMB8PB, VMB8PBU, VMB6PBN, VMB4PB (original series) and VMB6PB-20 (V2)
- Also suitable for glass panel sub-addresses when button events need separate wiring
- Address dropdown filters to button module types; channel count auto-populated from scan
- Output: `{ type: "button", on: true, pressed: [1,3], released: [], longPressed: [] }`
- `on` is `true` when any channel is pressed or long-pressed

### velbus-glass-panel improvements
- `heat_mode` and `cool_mode` commands added (0xE0 / 0xDF)
- Name auto-retrieval on startup — module name from VelbusLink populates status bar automatically

### velbus-thermostat improvements
- Name auto-retrieval on startup — same as glass-panel

### velbus-scan
- Button module types added to NODE_SUGGESTION

---

## v0.5.1 — 27/06/2026

### velbus-thermostat (new node)
- Dedicated thermostat node — clean separation from glass panel button events
- Targets primary module address — all commands go to base address, not thermostat sub-address
- Commands: `comfort`, `day`, `night`, `safe` (mode switch with optional `sleepTime`), `set_temp`, `get_thermostat`
- `set_temp`: `pointer` (0=comfort/1=day/2=night/3=safe) + `temp` (float °C)
- Output 1: `{ type, currentTemp, targetTemp, mode, heaterMode, heating, cooling, boostMode, thermostatOn }`
- Output 2: `{ type, current, min, max }`
- Can coexist on same address as `velbus-glass-panel` — bridge fans out to all registered listeners

### Palette groups
- `Velbus (inputs)` — teal #3A8C8C: velbus-scan, velbus-glass-panel, velbus-thermostat
- `Velbus (outputs)` — blue #4A90D9: velbus-relay, velbus-relay-20, velbus-dimmer, velbus-dimmer-20

---

## v0.5.0 — 27/06/2026

### velbus-glass-panel (new node)
- Single node covers entire VMBEL / VMBGP glass panel family — 23 module types, original and V2
- Output 1 — Buttons: press, release, long-press per channel
- Output 2 — Status/thermostat: module status (0xED), thermostat (0xEA), temperature (0xE6)
- Output 3 — Name parts: VelbusLink module name on request
- OLED extras (memo text, counter, display page) emitted on OLED-capable types only
- PIR channel semantic labels (button1-4, virtual, dark, light, motion) on PIR variants
- Thermostat rx/tx included — velbus-thermostat node also available for dedicated thermostat wiring
- LED control: `led_set`, `led_clear`, `led_slow`, `led_fast`, `led_vfast`
- Open collector: `output_on`, `output_off`, `output_timer`
- Config dialog: dropdown filters to glass panel types, channel count auto-populated
- `lib/glass-panel-types.js` — standalone type registry (hasOled, hasPir, hasOc, pirChannels, channels, minMapVer)

### velbus-scan corrections
- `0x55` corrected from `VMB8IN-20` to `VMBGP2-20` (collision resolved from protocol PDFs)
- `0x3A/3B/3C` corrected to `VMBGP1/2/4-2` original series (not -20)
- `0x21` corrected to `VMBGPO`
- All 23 glass panel types added to NODE_SUGGESTION and MODULE_CHANNELS

---

## v0.4.3 — 27/06/2026

### Address dropdowns in all config dialogs
- `velbus-relay`, `velbus-relay-20`, `velbus-dimmer`, `velbus-dimmer-20` config
  dialogs now show a dropdown of discovered modules from the most recent scan
- Dropdown filters by node type — relay dialog shows only relay modules, dimmer
  dialog shows only dimmer modules, etc.
- Each option shows: address, module type, build number, map version
- Falls back to plain text input if no scan has been run yet
- Manual entry always available at the bottom of the dropdown
- Run a `velbus-scan` node once — all subsequent config dialogs benefit automatically

### velbus-bridge
- `storeScanResults()` / `getScanResults()` API added
- `RED.httpAdmin` endpoint registered: `GET /velbus/scan-results?bridge={nodeId}`
  — serves scan results as JSON to config dialog dropdowns

### velbus-scan
- Calls `bridge.storeScanResults()` on scan completion

---

## v0.4.2 — 27/06/2026

### velbus-scan bugfix
- Duplicate `0x2D` key in `ALL_TYPES` registry — `VMBIN` was silently overwritten
  by `VMBPIRO`. Fixed as `VMBIN/VMBPIRO` pending PDF confirmation of whether they
  share a type byte or are distinct.

---

## v0.4.1 — 27/06/2026

### velbus-relay payload correction
- `mode` field removed from `relay_status` payload — was an unnecessary duplicate of `state`
- `on` boolean added to `relay_status` payload (was missing from original series node)
  - `on: true` when state is `on`, `timer_running` or `forced_on`
  - `on: false` for all other states

---

## v0.4.0 — 27/06/2026

### New nodes
- **velbus-dimmer-20** — V2.0 series dimmer and output modules
  - Supports VMB2DC-20 (2ch, 0-10V), VMB8DC-20 (8ch, 0-10V), VMB4LEDPWM-20 (4ch, PWM LED)
  - 0xEE bitmask status parser (on/inhibited/forcedOn/forcedOff/programDisabled/error per channel)
  - 0xA5 dim level packets — raw 0-254 value plus calculated percentage
  - Spontaneous 0x00 dim level broadcasts handled
  - `dimCurve` field in every payload (`linear` or `exponential`)
  - `outputType` field (`0-10V` or `PWM`)
  - `on` boolean: `true` when level > 0 and not forced off or inhibited
  - Commands: `set` (by raw `level` 0-254 or `percent` 0-100), `on`, `off`,
    `restore`, `timer`, `scene` (0-15), `forced_on`, `forced_off`,
    `cancel_forced_on`, `cancel_forced_off`, `inhibit`, `cancel_inhibit`, `status`
  - `fadeMode` on set commands: 0=direct, 1=rate, 2=time
  - **Live tested on VMB8DC-20 at Toulouse client site ✓**

- **velbus-dimmer** — Original series dimmer modules (pre V2.0)
  - Supports VMBDMI (1ch), VMBDMI-R (1ch), VMB4DC (4ch)
  - 0xB8 status parser — 0-100% native scale (original series)
  - Thermal status decoded for VMBDMI/VMBDMI-R: tempBand, loadType, error
  - VMB4DC uses bitmask channel model; VMBDMI/R use fixed single channel
  - `dimspeed` parameter (seconds) on set/on/off/restore commands
  - Commands: `set`, `on`, `off`, `restore`, `stop`, `timer`, `forced_on`,
    `forced_off`, `cancel_forced_on`, `cancel_forced_off`, `inhibit`,
    `cancel_inhibit`, `status`

### Notes
- VMB2DC-20 and VMB8DC-20 output a 0-10V control voltage — they do not carry
  mains load. They drive third-party dimmer packs, actuators, or any 0-10V
  compatible device. VMB4LEDPWM-20 outputs PWM for direct LED control.
- DALI references in VMB2DC-20/VMB8DC-20/VMB4LEDPWM-20 PDFs are documentation
  bleed-over from the shared VMBDALI codebase and are not implemented.

---

## v0.3.10 — 26/06/2026

### velbus-scan improvements
- Scan order reversed (0xFE→0x01) — higher addresses confirmed present first
- Recursive `setTimeout` replaces flat loop — more reliable on constrained hardware
- Collect window extended to 8000ms
- Output 2 fires `module_found` immediately on each discovery
- `0x4D` correctly identified as `VMBPIR-20` (confirmed on Toulouse hardware)
- `NODE_SUGGESTION` extended to cover PIR and glass panel module types

### velbus-bridge improvements
- Scan lock mechanism: `lockScan()` / `unlockScan()`
- Interpreter node startup RTRs queued during active scan, flushed 1/second after

### velbus-relay / velbus-relay-20
- Startup RTR passed with `startup=true` flag — correctly queued during scan

---

## v0.3.0 — 25/06/2026

### New nodes
- **velbus-relay-20** — V2.0 series relay modules
  - Supports VMB4RYLD-20, VMB4RYNO-20, VMB1RYS-20
  - Correct V2.0 0xFB bitmask parser — one packet = full module state
  - All bitmask fields in payload: on/inhibited/forcedOn/forcedOff/programDisabled/timerRunning
  - Channel number commands (1-8 or 0xFF for all) — not bitmask
  - `alarmProgram` decoded in every status payload
  - `canFD` flag from 0xFF properties byte

- **velbus-scan** — Bus scanner
  - RTR to every address (0x01–0xFE), collects 0xFF responses
  - Output 1: `scan_complete` with full module array
  - Output 2: `module_found` per discovered module
  - Each result: address, typeId, module name, serial, build, memoryMapVersion,
    canFD, suggestedNode, subaddresses
  - Configurable RTR delay (default 75ms) and collect window

### velbus-bridge improvements
- Passive 0xB0 subaddress handler
- Subaddress packets transparently routed to primary node
- Commands always sent to primary address only

### velbus-relay improvements
- VMB4RYLD-20 and VMB4RYNO-20 removed from original series registry
- 3-stage firmware check on 0xFF
- Module name auto-retrieval via 0xEF/0xF0/0xF1/0xF2
- Status bar: VelbusLink name + address
- Hard block on firmware incompatibility or unknown type

---

## v0.2.0 — 25/06/2026

### New nodes
- **velbus-bridge** (config node)
  - Persistent TCP connection with auto-reconnect (5s)
  - TLS and auth key support (python-velbustcp)
  - Address-based packet dispatch
  - `'all'` listener for scanner

- **velbus-relay** — Original series relay modules
  - Supports VMB1RY, VMB4RY, VMB4RYLD, VMB4RYNO, VMB1RYNO, VMB1RYNOS,
    VMB1RYS, VMB4RYLD-10, VMB4RYNO-10
  - 0xFB per-channel status parser
  - Commands: `on`, `off`, `toggle`, `timer`, `forced_on`, `forced_off`,
    `cancel_forced_on`, `cancel_forced_off`, `inhibit`, `cancel_inhibit`, `status`

---

## Confirmed hardware (live testing)

All testing on real installations via TCP gateway (velbus-tcp snap, port 6000).

| Module | Type | Site | Status |
|---|---|---|---|
| VMB1RYS | 0x41 | Toulouse FR | ✓ map v0, build 3654 |
| VMBEL1 | 0x34 | Toulouse FR | ✓ map v2, build 3433 |
| VMBEL4 | 0x36 | Toulouse FR | ✓ map v2, build 3433 (×5 units) |
| VMBELO | 0x37 | Toulouse FR | ✓ map v4, build 3821, CAN FD |
| VMBELPIR | 0x38 | Toulouse FR | ✓ map v2, build 3433 |
| VMBPIR-20 | 0x4D | Toulouse FR | ✓ map v1, build 3640, CAN FD (×2 units) |
| VMB8DC-20 | 0x4B | Toulouse FR | ✓ live tested, multiple channels confirmed |
| VMB4RYNO-20 | 0x27 | Toulouse FR | ✓ present on site (address TBC) |

Not yet tested (hardware available, nodes not yet built):
VMBELO thermostat, VMB4AN, VMBGP series, VMBIN, VMB2BLE

---

## Payload standards

All nodes follow consistent payload conventions:

**Relay:**
```json
{ "state": "on", "on": true, "timerRemaining": 0, "ledState": "off" }
```

**Dimmer:**
```json
{ "state": "on", "on": true, "level": 187, "percent": 73.6 }
```

**Button / glass panel buttons:**
```json
{ "type": "button", "on": true, "pressed": [1, 3], "released": [], "longPressed": [] }
```

**Thermostat status:**
```json
{ "type": "thermostat", "currentTemp": 21.5, "targetTemp": 22.0, "mode": "comfort",
  "heaterMode": true, "heating": false, "cooling": false, "boostMode": false, "thermostatOn": true }
```

**Temperature:**
```json
{ "type": "temperature", "current": 21.5, "min": 15.0, "max": 30.0 }
```

**Glass panel module status:**
```json
{ "type": "status", "locked": [], "thermostatProgram": "manual",
  "alarms": { "alarm1Active": false, "alarm2Active": false, "selected": 0 },
  "output": { "on": false, "locked": false, "programDisabled": false } }
```
`output` field only present on modules with a confirmed open collector output.

`on` is always a boolean where present. `state` is always a human-readable string.
Numbers are always numbers — never strings of numbers.
Temperature and settings payloads do not carry an `on` field.

---

## Roadmap

**Planned (PDFs needed):**
- `velbus-energy` — VMBPSUMNGR-20 (0x04). PDF needed.

**Pending hardware verification (UK, post July 2026):**
- Open collector presence on VMBGP1/2/4 original and VMBGP-20 series
- VMBPIRM raw light value bus accessibility (0xA9 / 0xAA)
- VMB7IN 0xED actual byte count (PDF lists 7 fields but states DLC=5)

**The Cunning Plan — VelbusLink as ground truth:**
Build a Node-RED flow that responds to a VelbusLink bus scan with all
unknown module type bytes simultaneously, using address = type byte.
VelbusLink displays correct names and writes them to the VLP project file.
Run on return to UK (Northampton, post July 2026).

Unknown type bytes to sweep (sample): 0x03 VMB1BL (old), 0x05 VMB6IN,
0x07 VMB1DM, 0x09 VMB2BL (old), 0x0A VMB8IR, 0x0B VMB4PD, 0x0C VMB1TS,
0x0E VMB1TC, 0x0F VMB1LED, 0x14 VMBDME, 0x25 VMBGPTC, 0x28 VMBGPOD,
0x53 (VMBBEL1PIR-20?), 0x5C (VMBBEL2PIR-20 / VMBEL4PIR-20 conflict),
and others.

**Not planned:**
- velbus-dali — out of scope

---

## Installation (pre-npm-publish)

```bash
cd /mnt/dietpi_userdata/node-red   # or ~/.node-red
npm install /path/to/node-red-contrib-velbus-2026
dietpi-services restart node-red   # or: node-red-restart
```

Tested on Node-RED v5.0, Node.js 18+, DietPi (Odroid C4).
Gateway: velbus-tcp snap (port 6000) or python-velbustcp (port 27015).

**Workflow:** Drop `velbus-scan` node → run once → all config dialogs show
address dropdowns populated with discovered modules.


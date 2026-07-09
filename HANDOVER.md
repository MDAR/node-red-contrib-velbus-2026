# HANDOVER.md — node-red-contrib-velbus-2026

**A complete technical reference for developing this Node-RED palette, written to assume
no prior context.** If you are picking this project up for the first time — whether
you're a new contributor, a new maintainer, or an AI assistant starting a fresh session
with no memory of previous work — this document should be sufficient on its own, together
with the source code in this repository, to continue development competently.

Current state at time of writing: **v0.10.0, 19 nodes, published on npm.**

---

## Table of contents

1. [What this project is](#1-what-this-project-is)
2. [Quick start](#2-quick-start)
3. [Repository structure](#3-repository-structure)
4. [Architecture overview](#4-architecture-overview)
5. [Complete node reference](#5-complete-node-reference)
6. [Complete module type registry](#6-complete-module-type-registry)
7. [Critical protocol knowledge](#7-critical-protocol-knowledge)
8. [Payload conventions](#8-payload-conventions)
9. [Architecture decisions (settled — do not reopen casually)](#9-architecture-decisions-settled--do-not-reopen-casually)
10. [Development environment setup](#10-development-environment-setup)
11. [Testing without real hardware — the mock-harness pattern](#11-testing-without-real-hardware--the-mock-harness-pattern)
12. [Testing status — what's actually verified](#12-testing-status--whats-actually-verified)
13. [Known open issues](#13-known-open-issues)
14. [Contribution and release workflow](#14-contribution-and-release-workflow)
15. [Where to find protocol references](#15-where-to-find-protocol-references)
16. [Code style rules](#16-code-style-rules)
17. [License and attribution](#17-license-and-attribution)

---

## 1. What this project is

**Velbus** is a CAN-bus-based building automation system, manufactured by Velbus Belgium.
Installations consist of physical modules on a shared bus — relay outputs, dimmers,
touch-sensitive glass control panels, PIR motion sensors, blind/shutter controllers,
weather stations, and more — each with a unique bus address. Modules are commissioned
using Velbus's own **VelbusLink** software, and communicate over the bus using a
well-documented binary packet protocol (official reference repositories linked in
[section 15](#15-where-to-find-protocol-references)).

**This project** is a Node-RED palette: a set of custom nodes that let a Node-RED flow
read and write to a live Velbus bus. It connects to the bus via a TCP gateway (either
Velbus's own `velbus-tcp` snap package, or the open-source `python-velbustcp` project —
both simply expose the same underlying serial/CAN bus protocol over a TCP socket). Once
connected, each node in this palette represents one physical module (or, for a couple of
nodes, a bus-wide function) and translates between Velbus's binary packets and normal
Node-RED JSON messages.

**Two module generations exist** and are handled throughout this codebase as a first-class
distinction:
- **Original series** — the older module generation. Simpler protocol, no firmware/CAN FD
  concept.
- **V2 / "-20" series** — the current module generation (module type names ending `-20`,
  e.g. `VMB4RYLD-20`). Richer protocol, CAN FD capable, firmware version checking.

Where a module type exists in both generations, this palette generally provides two
separate nodes (e.g. `velbus-relay` for original-series relays, `velbus-relay-20` for
V2 relays) rather than one node trying to handle both — see
[section 9](#9-architecture-decisions-settled--do-not-reopen-casually) for the reasoning
and the specific exceptions to this rule.

---

## 2. Quick start

```bash
# Install into an existing Node-RED instance
cd ~/.node-red
npm install node-red-contrib-velbus-2026
```

Then, in the Node-RED editor:
1. Drag a **velbus-bridge** config node onto a flow (or create one via any other Velbus
   node's config panel) — set the host/port of your Velbus TCP gateway.
2. Drag a **velbus-scan** node, wire an inject node into it, deploy, and fire it — this
   performs a full bus scan and populates every other node's address dropdown with the
   modules it finds.
3. Add nodes for the specific modules on your bus (see [section 5](#5-complete-node-reference)
   for the full list), select their address from the now-populated dropdown, and deploy.

No Velbus hardware to hand? See [section 11](#11-testing-without-real-hardware--the-mock-harness-pattern)
for how development and testing have been done without a live bus.

---

## 3. Repository structure

```
package.json              npm package definition — the node-red.nodes map here is how
                           Node-RED discovers every node; a new node must be registered here
index.js                  Intentionally minimal — Node-RED finds nodes via package.json, not this file
README.md                 User-facing installation and usage documentation
CHANGELOG_FORUM.md         Full version-by-version development history — read this before
                           assuming something hasn't been tried or fixed already
LICENSE                    MIT

lib/                       Shared code — protocol utilities and per-module-family type registries
  velbus-utils.js           chk() checksum, pkt()/rtrPkt() packet builders, parsePkt(),
                             splitPackets() — the packet framing primitives every node uses
  relay-types.js            Original-series relay module type registry
  relay-types-20.js         V2 relay module type registry
  dimmer-types.js            Original-series dimmer module type registry
  dimmer-types-20.js         V2 dimmer module type registry (incl. LED grouping mode / Device
                             Type table for VMB4LEDPWM-20)
  glass-panel-types.js       All 29 glass panel module types in one registry (hasOled/hasPir/
                             hasOc/minMapVer flags per type)
  pir-types.js / pir-types-20.js       PIR sensor module type registries
  sensor-types.js / sensor-types-20.js Sensor/meteo module type registries
  energy-types-20.js         Power-supply-manager module type registry (single V2 type,
                             VMBPSUMNGR-20)
  blind-types.js / blind-types-s.js / blind-types-20.js   Blind/shutter module type registries
                             (three files because the blind family splits by protocol
                             capability, not simply by generation — see section 9)

nodes/                      One directory per node, each containing a .js (logic) and
                             .html (editor UI + in-editor help) file of the same name
  velbus-bridge/             Config node — the only node that holds the actual TCP connection
  velbus-scan/                Full bus scanner
  velbus-relay/ , velbus-relay-20/
  velbus-dimmer/ , velbus-dimmer-20/
  velbus-glass-panel/
  velbus-thermostat/
  velbus-button/
  velbus-pir/ , velbus-pir-20/
  velbus-meteo/
  velbus-sensor/ , velbus-sensor-20/
  velbus-blind/ , velbus-blind-s/ , velbus-blind-20/
  velbus-clock/               Broadcasts system time/date/DST and clock alarms — the one
                              node with no fixed module address, see section 5
  velbus-energy/              VMBPSUMNGR-20 power supply manager — PSU load, alarms,
                              warranty counter, per-rail wattage/voltage/amperage

examples/
  velbus-basic-relay-dimmer.json   A minimal example flow, importable directly in Node-RED
```

**Convention for adding a new node:** copy the structure of the most similar existing node
(same module family or same generation) rather than starting from a blank file — the
boilerplate (bridge lookup, packet registration, status bar handling, firmware check for
V2 nodes) is consistent across every node and easy to get subtly wrong if rebuilt from
scratch.

**Adding or fixing a module type touches three separate files, not one — confirmed
the hard way (v0.9.2 → v0.9.3).** A module type used to exist in exactly one place per
node family; it doesn't. Check all three every time:
1. `lib/<family>-types[-20].js` — used by the actual node at runtime (`velbus-glass-panel`,
   `velbus-sensor`, etc.)
2. The corresponding node's own `.html` file — a **separate, duplicate** copy used only
   to populate the editor's address dropdown and type hint. Not read by the running node
   at all.
3. `nodes/velbus-scan/velbus-scan.js` — has its **own, third, entirely independent** copy
   (`ALL_TYPES`, `NODE_SUGGESTION`, `MODULE_CHANNELS`), used only for bus-discovery
   reporting. Doesn't read either of the other two files.

Missing any one of the three produces a real, user-visible symptom in a *different* part
of the palette than wherever the fix actually needs to happen — a scan reporting
`unknown_0x28` while the glass-panel node itself handles that type perfectly correctly,
for instance. When in doubt, `grep -rln "<ModuleName>'" nodes/ lib/` to find every file
that mentions a given type by name, rather than assume you've found all the copies.

---

## 4. Architecture overview

### 4.1 The bridge is the only thing that touches the network

`velbus-bridge` is a Node-RED **config node** (shared, not visible as a flow node itself)
that owns the actual TCP socket to the Velbus gateway. It handles:
- Connecting (plain TCP or TLS, with optional auth-key handshake for `python-velbustcp`)
- Auto-reconnect on disconnect (5 second backoff)
- Splitting the raw TCP byte stream into individual packets (`splitPackets()` in
  `lib/velbus-utils.js` — a stream doesn't respect packet boundaries, so this has to
  track a remainder buffer across multiple `data` events)
- Dispatching each parsed packet to whichever node(s) have registered interest in that
  module address (`bridge.register(address, callback)` / `bridge.deregister(...)`)
- A **scan lock** mechanism: while a bus scan is in progress, other nodes' startup RTR
  (request-to-respond) packets are queued rather than sent immediately, and flushed
  one-per-second once the scan completes — prevents startup traffic from colliding with
  an active scan
- Serving persisted scan results to the editor's config dialogs, via an HTTP endpoint:
  `GET /velbus/scan-results?bridge=<bridge-node-id>` → `{ modules: [...], count: N }`.
  **The endpoint returns an object, not an array — always use `results.modules`, not
  `results` directly.** This has been a real, repeated source of bugs.
- Rebuilding its subaddress-to-primary-address map from persisted scan results on
  startup, so subaddress routing survives a Node-RED restart without requiring a fresh
  scan every time.
- A public `isConnected()` method other nodes can check before sending, to give a clear
  "not connected" status rather than a generic dropped-packet warning.

Every other node looks up its configured bridge via `RED.nodes.getNode(config.bridge)`,
registers for its own module address's packets, and sends outgoing packets via
`node.bridge.send(buffer)`.

### 4.2 The packet protocol

Every Velbus packet, at the byte level, has this shape:

```
0F [pri] [addr] [dlc] [body...] [chk] 04
```

| Field | Meaning |
|---|---|
| `0x0F` | Start-of-frame marker (fixed) |
| `pri` | Priority byte — see below |
| `addr` | Target/source module address (`0x00` = broadcast, `0x01`–`0xFE` = a real module) |
| `dlc` | Data length (low 4 bits = body byte count), or `0x40` for an RTR (request) packet |
| `body...` | The actual command/data bytes — see [section 4.3](#43-the-body-indexing-rule) |
| `chk` | Checksum — two's complement of the sum of all preceding bytes, mod 256 |
| `0x04` | End-of-frame marker (fixed) |

**Priority byte values** (confirmed against the official `packetprotocol` repository —
see [section 15](#15-where-to-find-protocol-references)):

| Value | Meaning |
|---|---|
| `0xF8` | High priority |
| `0xF9` | Firmware-related |
| `0xFA` | Third-party |
| `0xFB` | Low priority |

In practice, this codebase's convention (established after a real, painful bug — see
`CHANGELOG_FORUM.md` v0.7.0) is: **`0xFB` for status requests (`0xFA` command) and RTR
scan packets; `0xF8` for essentially everything else**, including outgoing commands and
most spontaneous module broadcasts. This is a convention observed to match real hardware
behaviour, not a rule stated explicitly and completely in the official docs — when in
doubt for a new packet type, check the specific module's protocol PDF for its actual
priority bits rather than assuming.

An RTR (bus scan request) packet has no body at all: `0F FB [addr] 40 [chk] 04`.

**Checksum** — sum every byte from the start marker through the last body byte
(mod 256), then take the two's complement:
```javascript
function chk(bytes) {
  let s = 0;
  for (const x of bytes) s = (s + x) & 0xFF;
  return ((~s + 1) & 0xFF);
}
```
This exact function lives in `lib/velbus-utils.js` as `chk()`, used by `pkt()` (builds an
outgoing packet) and implicitly verified by `parsePkt()` when reading incoming ones.

### 4.3 The body indexing rule — the single most common source of bugs

`parsePkt()` returns a `body` array where **`body[0]` is always the command byte itself**
(what the official protocol PDFs call DATABYTE1). Actual data starts at `body[1]`
(DATABYTE2).

```
PDF says "DATABYTE2 = channel number"  →  code should read body[1]   ✓
                                        →  code reading body[2] is WRONG (that's DATABYTE3)
```

This off-by-one is the single most common mistake made throughout this project's
development history (see `CHANGELOG_FORUM.md` for several real instances). When
implementing a new packet handler, always write out the DATABYTE-to-`body[]` index
mapping explicitly as a comment before writing the parsing logic — it is not something
to trust from memory or infer quickly.

**The canonical real example: `velbus-button` shipped this exact bug from its very
first version (v0.5.2) until v0.9.4** — over 30 versions, undetected. Its `0x00`
handler read `body[0]`/`body[1]`/`body[2]` for pressed/released/long-pressed, when the
correct indices are `body[1]`/`body[2]`/`body[3]`. The practical effect: `pressed` was
always empty (silently reading the constant command byte), `released` actually reported
what was really the pressed bitmask, `longPressed` reported what was really the released
bitmask, and the real long-press data was never read at all. It went unnoticed for this
long specifically because `velbus-glass-panel`'s own, separately-written `0x00` handler
got the indexing right from the start, and nobody had directly exercised
`velbus-button`'s press/release distinction against real hardware — only its
scan/discovery path (`0xFF`/`0xB0`, handled entirely separately) had seen real traffic.
A bug in one packet handler is invisible from the outside if nothing forces that
specific handler to run against real data. If you're verifying a node, verify the
specific packet type you care about — passing scan/discovery doesn't imply anything
about a different command byte's handler in the same file.

### 4.4 Address format

Module addresses are stored as **hex strings in the editor's dropdown UI** (e.g.
`"0x0D — VMBELO"`) but **stored in the actual node config as a decimal integer**.
Numbers appearing in an old saved flow (from before hex-string dropdowns existed) should
still be treated as decimal for backward compatibility; new saves from the current editor
use hex strings. Both are handled by the same address-parsing logic in each node — if
you're seeing an address parse incorrectly, check whether the value arrived as a number
or a string before assuming the parsing logic itself is wrong.

---

## 5. Complete node reference

| Node | Category | Covers |
|---|---|---|
| `velbus-bridge` | config | The TCP connection itself — see section 4.1 |
| `velbus-scan` | Velbus (inputs) | Full bus scan, populates every other node's address dropdown |
| `velbus-relay` | Velbus (outputs) | Original-series relays: VMB1RY, VMB4RY, VMB4RYLD, VMB4RYNO, VMB1RYNO, VMB1RYNOS, VMB1RYS, VMB4RYLD-10, VMB4RYNO-10 |
| `velbus-relay-20` | Velbus (outputs) | V2 relays: VMB1RYS-20, VMB4RYLD-20, VMB4RYNO-20 |
| `velbus-dimmer` | Velbus (outputs) | Original-series dimmers: VMBDMI, VMBDMI-R, VMB4DC |
| `velbus-dimmer-20` | Velbus (outputs) | V2 dimmers: VMB2DC-20, VMB8DC-20, VMB4LEDPWM-20 (incl. RGB/RGBW grouping mode) |
| `velbus-glass-panel` | Velbus (inputs) | All 29 glass panel types (original + V2), buttons/OLED/PIR/open-collector as applicable per type |
| `velbus-thermostat` | Velbus (inputs) | Thermostat function on any glass panel module that has one — same address as the corresponding glass-panel node, coexists without conflict |
| `velbus-button` | Velbus (inputs) | 12 types across original and V2 series (VMB8PB, VMB8PBU, VMB6PBN, VMB2PBN, VMB4PB, VMB6PB-20, VMB8IR, VMB4PD, VMB4RF, VMBRFR8S, VMBVP01, VMBKP, VMBIN) — plain button events for all; lock/unlock and richer status decode for the 8 types confirmed to support them; fixed semantic channel labels for VMBVP01 (DoorBird) |
| `velbus-pir` | Velbus (inputs) | Original-series PIR: VMBPIRO-10, VMBPIRM, VMBPIRC, VMBPIRO |
| `velbus-pir-20` | Velbus (inputs) | V2 PIR: VMBPIR-20, VMBPIRO-20 |
| `velbus-meteo` | Velbus (inputs) | Weather station: VMBMETEO |
| `velbus-sensor` | Velbus (inputs) | Original-series input/analogue: VMB7IN, VMB4AN, VMB6IN |
| `velbus-sensor-20` | Velbus (inputs) | V2 input: VMB8IN-20 |
| `velbus-blind` | Velbus (outputs) | VMB1BL, VMB2BL |
| `velbus-blind-s` | Velbus (outputs) | VMB1BLS, VMB2BLE, VMB2BLE-10 |
| `velbus-blind-20` | Velbus (outputs) | VMB2BLE-20 |
| `velbus-clock` | Velbus (outputs) | **No fixed module address.** Broadcasts system time/date/DST to the bus broadcast address (`0x00`), sets clock alarms and sunrise/sunset enable state either globally (broadcast) or locally (a specific module, via a per-message address override) |
| `velbus-energy` | Velbus (inputs) | VMBPSUMNGR-20 — power supply manager: PSU load percentages, live wattage/voltage/amperage per rail, a warranty (hours-in-operation) counter, and PSU/warranty alarm status |

Palette group colours: **Velbus (inputs)** is teal (`#3A8C8C`), **Velbus (outputs)** is
blue (`#4A90D9`).

---

## 6. Complete module type registry

### Relays
| Type byte | Module | Node |
|---|---|---|
| 0x02 | VMB1RY | velbus-relay |
| 0x08 | VMB4RY | velbus-relay |
| 0x0D | VMB1RYS-20 | velbus-relay-20 |
| 0x10 | VMB4RYLD | velbus-relay |
| 0x11 | VMB4RYNO | velbus-relay |
| 0x1B | VMB1RYNO | velbus-relay |
| 0x26 | VMB4RYLD-20 | velbus-relay-20 |
| 0x27 | VMB4RYNO-20 | velbus-relay-20 |
| 0x29 | VMB1RYNOS | velbus-relay |
| 0x41 | VMB1RYS | velbus-relay |
| 0x48 | VMB4RYLD-10 | velbus-relay |
| 0x49 | VMB4RYNO-10 | velbus-relay |

### Dimmers
| Type byte | Module | Node | LED grouping mode |
|---|---|---|---|
| 0x06 | VMB4LEDPWM-20 | velbus-dimmer-20 | single / rgb / rgbw (configurable) |
| 0x12 | VMB4DC | velbus-dimmer | n/a |
| 0x15 | VMBDMI | velbus-dimmer | n/a |
| 0x24 | VMB2DC-20 | velbus-dimmer-20 | n/a |
| 0x2F | VMBDMI-R | velbus-dimmer | n/a |
| 0x4B | VMB8DC-20 | velbus-dimmer-20 | n/a |

### Push buttons (all → velbus-button, 12 types)
| Type byte | Module | Lock/unlock | Notes |
|---|---|---|---|
| 0x01 | VMB8PB | No | Simpler 0xED (LED status only), no lock command at all |
| 0x16 | VMB8PBU | Yes | |
| 0x17 | VMB6PBN | Yes | |
| 0x18 | VMB2PBN | — | Not yet cross-checked for lock support, treated conservatively |
| 0x44 | VMB4PB | Yes | **Type byte corrected 09/07/2026** — was wrongly keyed 0x1C in `velbus-button.js`'s own registry (not a real type byte at all); `velbus-scan.js` always had 0x44 right |
| 0x4C | VMB6PB-20 | Yes | **Type byte corrected 09/07/2026** — was wrongly keyed 0x20 (which is actually VMBGP4, a different module); `velbus-scan.js` always had 0x4C right |
| 0x0A | VMB8IR | No | IR receiver — presents fixed Velbus IR codes as button events |
| 0x0B | VMB4PD | No | LCD module — only the 4 button channels covered, not the LCD |
| 0x1A | VMB4RF | Yes | 4 channels (matches its name) — status uses 0xB4, not 0xED, so rich status is not decoded even though lock/unlock works |
| 0x30 | VMBRFR8S | Yes | |
| 0x33 | VMBVP01 | No | DoorBird — fixed semantic labels (Motion 1/2, Bell 1/2, Door 1/2, Virtual button 1/2), different/shorter 0xED not decoded |
| 0x42 | VMBKP | Yes | |
| 0x43 | VMBIN | Yes | Single channel |

### Glass panels (all → velbus-glass-panel, 29 types)
| Type byte | Module | OLED | PIR | Open collector | Min. map version |
|---|---|---|---|---|---|
| 0x1E | VMBGP1 | no | no | unconfirmed¹ | — |
| 0x1F | VMBGP2 | no | no | unconfirmed¹ | — |
| 0x20 | VMBGP4 | no | no | unconfirmed¹ | — |
| 0x21 | VMBGPO | yes | no | yes | 2 |
| 0x25 | VMBGPTC | yes | no | no | — |
| 0x28 | VMBGPOD | yes | no | no | — |
| 0x2D | VMBGP4PIR | no | yes | unconfirmed¹ | — |
| 0x34 | VMBEL1 | no | no | yes | 2 |
| 0x35 | VMBEL2 | no | no | yes | 2 |
| 0x36 | VMBEL4 | no | no | yes | 2 |
| 0x37 | VMBELO | yes | no | yes | 4 |
| 0x38 | VMBELPIR | no | yes | yes | 2 |
| 0x3A | VMBGP1-2 | no | no | no² | — |
| 0x3B | VMBGP2-2 | no | no | no² | — |
| 0x3C | VMBGP4-2 | no | no | no² | — |
| 0x3D | VMBGPOD-2 | yes | no | unconfirmed¹ | 2 |
| 0x3E | VMBGP4PIR-2 | no | yes | unconfirmed¹ | — |
| 0x47 | VMBEL2PIR | no | yes | yes | — |
| 0x4F | VMBEL1-20 | no | no | yes | — |
| 0x50 | VMBEL2-20 | no | no | yes | — |
| 0x51 | VMBEL4-20 | no | no | yes | — |
| 0x52 | VMBELO-20 | yes | no | yes | — |
| 0x53 | VMBELPIR-20³ | no | yes | yes | — |
| 0x54 | VMBGP1-20 | no | no | unconfirmed¹ | — |
| 0x55 | VMBGP2-20 | no | no | unconfirmed¹ | — |
| 0x56 | VMBGP4-20 | no | no | unconfirmed¹ | — |
| 0x57 | VMBGPO-20 | yes | no | yes | — |
| 0x5C | VMBEL2PIR-20³ | no | yes | yes | — |
| 0x5F | VMBGP4PIR-20 | no | yes | unconfirmed¹ | — |

⁴ VMBGPTC (0x25) shares its actual protocol document with VMBGPO (0x21) — a
thermostat-only variant of the same touch panel hardware, not a separate
product. Type byte confirmed from the official type list, not spelled out
separately in the shared document's body. VMBGP4PIR-2 (0x3E) has genuinely
different channel 5-8 semantics from its 0x2D sibling despite the similar
name (Dark/Light output, Motion output, Light-depending-motion, Absence
output — not virtual/dark/light/motion) — confirmed directly, not assumed.

¹ Open-collector support unconfirmed against real hardware — see [section 13](#13-known-open-issues).
² Confirmed no open-collector commands in the protocol PDF, but not yet live-verified.
³ The official Velbus type list shows different module names at these two type bytes than
what this registry currently uses — flagged for verification, see
[section 13](#13-known-open-issues).

### PIR sensors
| Type byte | Module | Node | Has temp. sensor |
|---|---|---|---|
| 0x23 | VMBPIRO-10 | velbus-pir | yes |
| 0x2A | VMBPIRM | velbus-pir | no |
| 0x2B | VMBPIRC | velbus-pir | no |
| 0x2C | VMBPIRO | velbus-pir | yes |
| 0x4D | VMBPIR-20 | velbus-pir-20 | no |
| 0x59 | VMBPIRO-20 | velbus-pir-20 | yes |

### Sensors / meteo
| Type byte | Module | Node |
|---|---|---|
| 0x22 | VMB7IN | velbus-sensor |
| 0x31 | VMBMETEO | velbus-meteo |
| 0x32 | VMB4AN | velbus-sensor |
| 0x4E | VMB8IN-20 | velbus-sensor-20 |
| 0x05 | VMB6IN | velbus-sensor — simpler sibling of VMB7IN, no lock/unlock at all, 5-byte 0xED (vs VMB7IN's 7) safely skipped by the existing length guard |

### Blind / shutter
| Type byte | Module | Node |
|---|---|---|
| 0x03 | VMB1BL | velbus-blind |
| 0x09 | VMB2BL | velbus-blind |
| 0x1D | VMB2BLE | velbus-blind-s |
| 0x2E | VMB1BLS | velbus-blind-s |
| 0x4A | VMB2BLE-10 | velbus-blind-s |
| 0x61 | VMB2BLE-20 | velbus-blind-20 |

### Energy / infrastructure
| Type byte | Module | Node |
|---|---|---|
| 0x04 | VMBPSUMNGR-20 | velbus-energy |

---

## 7. Critical protocol knowledge

### 7.1 Firmware build number — the official docs mislabel this field

In the `0xFF` module-identification response, bytes labelled "Build Year" and
"Build Week" in the official protocol PDFs are, in every module tested against real
hardware, actually the **high and low bytes of a single build number**, not a
year/week pair:

```
build = (body[5] × 100) + body[6]
Example: body[5]=0x24 (36 decimal), body[6]=0x36 (54 decimal) → (36×100)+54 = 3654
```

### 7.2 `0xFF` module type/identification response
```
body[0] = 0xFF
body[1] = module type byte
body[2] = serial number, high byte
body[3] = serial number, low byte
body[4] = memory map version
body[5] = build number high byte (decimal, see 7.1)
body[6] = build number low byte  (decimal, see 7.1)
body[7] = properties byte — V2 modules only (bit 5 = CAN FD capable, bit 0 = terminator fitted)
```
Original-series modules: 7 bytes total (no `body[7]`).
Exceptions confirmed against real hardware: **VMB1BL/VMB2BL** send only 5 bytes (no
serial number; `body[2]` is instead a DIP-switch timeout setting). **VMBELO**, despite
being an original-series module, sends the full 8-byte V2-style response.
**VMB2BLE-10** also sends 8 bytes, but `body[7]` there is only a terminator flag, not
the full V2 properties byte.

### 7.3 `0xB0` subaddress response
```
body[0] = 0xB0
body[1] = module type
body[2-3] = serial number
body[4-7] = up to four subaddresses (0xFF = subaddress slot disabled/unused)
```
Subaddresses are **source addresses for incoming events only** — outgoing commands
always go to the module's primary address, never to a subaddress. The bridge handles
`0xB0` responses passively, building a subaddress→primary-address map so that other
nodes don't need any subaddress-specific logic themselves. A `0xB0` response can arrive
up to ~500ms after the initial `0xFF` — always allow for this delay before treating a
module's discovery as complete.

### 7.4 `0xFB` relay status — two completely different formats depending on generation

**Original series** — one packet per active channel:
```
body[0] = 0xFB
body[1] = channel number
body[2] = state (0 = off, 1 = on)
body[3-5] = 24-bit timer remaining, in seconds
body[6] = LED state
```
Since one packet is sent per channel, allow up to ~200ms to collect all of them for a
multi-channel module.

**V2 series** — a single bitmask packet covering every channel at once:
```
body[0] = 0xFB
body[1] = active (on) bitmask
body[2] = timer-running bitmask
body[3] = forced bitmask
body[4] = inhibited bitmask
body[5] = locked bitmask
```

### 7.5 `0xEE` dimmer status — V2 series (all three -20 dimmer types)
```
body[0] = 0xEE
body[1] = on/off bitmask
body[2] = inhibited bitmask
body[3] = forced-on bitmask
body[4] = forced-off bitmask
body[5] = program-disabled bitmask
body[6] = error bitmask
body[7] = alarm/program byte
```

### 7.6 `0xA5` dim level — up to four channels packed per packet
```
body[0] = 0xA5, body[1] = channel, body[2] = level (0-254)
[optionally repeated: body[3] = channel, body[4] = level, ...]
```

### 7.7 `0x1E` RGBW command — VMB4LEDPWM-20 in rgb/rgbw grouping mode only
```
body[0] = 0x1E
body[1] = group (0xFF = all)
body[2] = R, body[3] = G, body[4] = B, body[5] = W
body[6] = fade mode (0 = direct, 1 = rate, 2 = time)
```

**Watch this one carefully:** command bytes `0x12`/`0x14` mean **forced OFF / forced ON**
on relay nodes, but mean **forced UP / forced DOWN** on blind nodes. The same byte value
means something entirely different depending on module type — always check module type
before reusing a command byte pattern from a different node family.

### 7.8 Memory read/write timing constraints
```
Original series:  minimum 20ms between 0xFC writes — this is real EEPROM with a
                  finite write-cycle lifespan, do not write faster than this
V2 series:        wait for the module's 0xFE acknowledgement before the next write
OLED framebuffer: 10ms minimum per 4-byte block (V2 modules with a display)
Address assignment: allow 500ms, then rescan to confirm the new address took effect
```
**Never write in response to a real-time bus event** — an incoming status broadcast is
not the right trigger for an automatic write-back, both for the EEPROM-wear reason above
and because it risks a feedback loop. Reads have no such constraint and are always safe.

### 7.9 Thermostat commands — always to the primary address
```
0xDB = comfort mode, 0xDC = day mode, 0xDD = night mode, 0xDE = safe mode
0xE0 = heat mode, 0xDF = cool mode
0xE4 = set target temperature, 0xE5 = request temperature settings, 0xE7 = request status
0xEF = request module name (append a channel byte)
0xFA = request module status
```
Thermostat commands go to the module's **primary address only**, never to a thermostat
subaddress, even though the thermostat function itself may be logically associated with
a subaddress in the module's own internal architecture.

### 7.10 Temperature encoding — two different formats in use

```javascript
// Signed byte × 0.5°C — used in the 0xE8 thermostat settings packet
function signed05(b) { return (b > 127 ? b - 256 : b) * 0.5; }

// Signed 16-bit, divided by 512 — used in the 0xE6 temperature packet
// (0.0625°C resolution). NOTE: official protocol documentation shows a
// divisor of 16 for this field — that is wrong. It has been directly
// verified against real hardware that the correct divisor is 512.
function tempFrom16(hi, lo) {
  const raw = (hi << 8) | lo;
  return (raw > 32767 ? raw - 65536 : raw) / 512;
}
```
This divisor discrepancy (16 vs. 512) is exactly the kind of thing worth re-verifying
against a real module if you're implementing a new node that touches `0xE6` — don't
trust the official PDF's stated divisor for this specific field without checking.

---

## 8. Payload conventions

Every node's Node-RED output message follows the same conventions, regardless of module
type:

- **Numbers are always numbers, never strings.** A temperature is `21.5`, not `"21.5"`.
- **An `on` boolean is present only where a meaningful binary on/off state actually
  exists.** Temperature, counter, and settings-only payloads have no `on` field at all —
  don't add one just for consistency's sake if the underlying value isn't truly binary.
- **`topic`** identifies the payload shape/purpose (e.g. `"relay_status"`,
  `"dimmer_status"`, `"button"`, `"thermostat_status"`) so a single debug/switch node
  downstream can distinguish message types without inspecting every field.

Representative examples:

```json
{ "topic": "relay_status", "address": "0x10", "module": "Hall Relay",
  "channel": 1, "state": "on", "on": true, "timerRemaining": 0 }

{ "topic": "dimmer_status", "address": "0xA5", "module": "GF Lights",
  "channel": 1, "state": "on", "on": true, "level": 187, "percent": 73.6,
  "outputType": "PWM", "dimCurve": "exponential", "ledMode": "single" }

{ "topic": "button", "address": "0x03", "module": "Hall Panel",
  "type": "button", "on": true,
  "pressed": [1, 3], "released": [], "longPressed": [] }

{ "topic": "thermostat_status", "type": "thermostat",
  "currentTemp": 21.5, "targetTemp": 22.0, "mode": "comfort",
  "heaterMode": true, "heating": false, "thermostatOn": true }

{ "topic": "temperature", "type": "temperature",
  "current": 21.5, "min": 15.0, "max": 30.0 }

{ "topic": "meteo", "type": "meteo",
  "rain": 0.5, "light": 12500, "wind": 14.3 }

{ "topic": "blind_status", "type": "blind_status",
  "channel": 1, "on": true, "status": "up", "position": 25,
  "lockState": "normal", "autoMode": 0 }

{ "topic": "module_online", "address": "0x06", "module": "VMB4LEDPWM-20",
  "typeId": "0x06", "outputType": "PWM", "dimCurve": "exponential",
  "ledMode": "single", "channels": 4, "build": 2436, "canFD": false }
```

**Node status bar format** (shown under each node in the Node-RED editor): `"{module
name} (0x{address}) {state}"`. Name priority, highest first: an explicit user override
in node config, then the module's own name as reported by VelbusLink/read from the
module itself, then falling back to the generic module type string if neither is
available.

---

## 9. Architecture decisions (settled — do not reopen casually)

These are decisions made deliberately, generally after real back-and-forth about the
alternatives. Reopening one isn't forbidden, but should be a considered choice, not an
accidental drift — if you find yourself changing one of these, it's worth being explicit
about why in the commit message.

- **Generational split.** Nodes generally split at the V2.0 boundary — one node for
  original-series, a separate node for V2. **Exceptions:** `velbus-glass-panel` (one
  node covers all 29 types, both generations, via the type registry's per-type flags
  rather than a code-level split), `velbus-thermostat` (covers the thermostat function
  on any glass panel type), `velbus-meteo` (only one generation exists), and the blind
  family (`velbus-blind` / `velbus-blind-s` / `velbus-blind-20`, split by actual protocol
  capability rather than strictly by generation, since some non-V2 blind modules share
  more protocol in common with certain V2 ones than with other original-series ones).
- **Firmware check (V2 nodes only).** A three-stage check on receiving the module's
  `0xFF` identification: type byte matches → memory map version meets the node's stated
  minimum → pass. Failure is a hard block with a red status, not a soft warning.
  Original-series nodes skip this check entirely (no firmware/map-version concept
  exists for them).
- **Name auto-retrieval.** V2 nodes, and the glass-panel/thermostat nodes, request the
  module's name (`0xEF`) automatically on startup, with a 2-second timeout — whatever
  has been received by then is used, even if the name is incomplete.
- **Scan lock.** `velbus-scan` calls the bridge's scan-lock before scanning; every other
  node's own startup RTR requests are queued during an active scan and flushed at a rate
  of one per second once scanning completes, rather than being sent immediately and
  risking a collision with in-progress scan traffic.
- **Address dropdown data source.** Always read `results.modules`, never `results`
  directly, from the bridge's `/velbus/scan-results` endpoint — it returns an object
  wrapping the array, not the array itself. Real, repeated source of bugs — worth
  restating even though it's also in section 4.1.
- **Thermostat commands always target the primary address**, never a subaddress, even
  though the thermostat function may be logically tied to one internally.
- **`0xFF` response body length** is 7 bytes on original-series modules, 8 bytes on V2
  — except VMBELO (original series, but sends 8 bytes) and VMB2BLE-10 (sends 8 bytes,
  but the 8th is only a terminator flag, not full V2 properties). See section 7.2.
- **VMB4LEDPWM-20 LED grouping mode** is a node config property that documents which
  mode (single/rgb/rgbw) the physical module is wired for — the node does **not** write
  this setting to the module automatically. Changing a module's grouping mode is a
  deliberate commissioning-time decision made by a human (or a dedicated commissioning
  tool), not something a live command node should do silently. A read-only
  `get_device_type` command exists on `velbus-dimmer-20` to verify the module's actual
  setting matches the node's configured value.
- **`velbus-clock`'s `set_alarm` command accepts a per-message address override**,
  breaking from the "one node = one fixed module address" pattern every other node
  follows. This was a deliberate exception, not an oversight: the underlying protocol
  command (`0xC3`, clock alarm) is identical whether sent globally (broadcast) or
  locally (one specific module) — differing only in destination address — and is a
  shared system-level command across V2 module types generally, not a feature tied to
  one specific module type. Putting per-module alarm handling on every relevant node
  type instead would mean duplicating an identical handler several times over. This is
  flagged as a considered judgement call rather than a permanently settled decision —
  if it later seems better as a proper per-module config field (matching every other
  node's pattern), that's a reasonable direction to switch to.

---

## 10. Development environment setup

**Prerequisites:**
- Node.js ≥ 14
- Node-RED ≥ 2.0.0
- A Velbus TCP gateway of some kind — either the official `velbus-tcp` package, or the
  open-source `python-velbustcp` project (see [section 15](#15-where-to-find-protocol-references)
  for links). Both simply expose the same bus protocol over a TCP socket; this palette
  doesn't care which one it's talking to.
- Ideally, physical Velbus hardware to test against — though a great deal of useful
  development and verification is possible without it; see
  [section 11](#11-testing-without-real-hardware--the-mock-harness-pattern).

**For live development** (editing node code and seeing changes without repackaging a
tarball every time), symlink this repository directly into Node-RED's node_modules
rather than repeatedly installing from a tarball:
```bash
cd ~/.node-red/node_modules
ln -s /path/to/your/local/checkout/node-red-contrib-velbus-2026 node-red-contrib-velbus-2026
```
Restart Node-RED after each code change to pick it up (Node-RED does not hot-reload
node `.js` files). For `.html` (editor UI/help) changes specifically, a hard browser
refresh (`Ctrl+Shift+R` or equivalent) is usually enough, since the editor caches node
HTML client-side — a full Node-RED restart isn't always necessary for HTML-only changes,
but doesn't hurt if something isn't picking up.

**No physical Velbus hardware and no gateway software set up yet?** You can still make
substantial progress — see the next section.

---

## 11. Testing without real hardware — the mock-harness pattern

A useful, repeatedly-proven technique for verifying a node's packet-building logic
*before* ever touching real hardware: write a small standalone script that mocks just
enough of the Node-RED `RED` object to load the node file directly, wire a fake bridge
that captures whatever bytes get sent, and hand-verify the resulting packet against the
protocol specification (checksum, DLC, byte-for-byte field layout).

This does **not** replace testing against real hardware — it catches packet-construction
bugs (wrong byte count, wrong checksum, off-by-one field indexing) before they ever reach
a bus, but it cannot confirm that a real module actually does what the protocol PDF says
it should do in response. Both kinds of verification matter; this one is simply always
available, with zero hardware dependency.

**Minimal example** (adapt the node path, config, and input payload to whatever you're
testing):

```javascript
const handlers = {};

function MockNode() {
  this.on = (evt, fn) => { handlers[evt] = fn; };
  this.status = (s) => console.log('STATUS:', JSON.stringify(s));
  this.warn = (m) => console.log('WARN:', m);
  this.error = (m) => console.log('ERROR:', m);
  this.send = (msg) => console.log('OUTPUT:', JSON.stringify(msg));
}

const sentPackets = [];
const mockBridge = {
  isConnected: () => true,
  send: (buf) => sentPackets.push(buf)
};

const RED = {
  nodes: {
    createNode: (self) => { Object.assign(self, new MockNode()); },
    getNode: () => mockBridge,
    registerType: (name, ctor) => { RED._ctor = ctor; }
  }
};

require('/path/to/nodes/velbus-example/velbus-example.js')(RED);

const config = { bridge: 'x' /* , ...whatever config fields this node expects */ };
new RED._ctor(config);

// Fire whatever input message you want to test
handlers['input']({ payload: { cmd: 'some_command', /* ...fields */ } });

// Inspect the resulting bytes
for (const buf of sentPackets) {
  console.log(buf.toString('hex').toUpperCase().match(/.{1,2}/g).join(' '));
}
```

Hand-verify the printed hex bytes against the protocol PDF: confirm the DLC nibble
matches the actual body length, confirm each field lands at the expected offset, and
compute the checksum by hand (sum all bytes before it, mod 256, two's complement) to
confirm it matches what the code produced. This exact pattern has caught real bugs
before code ever reached a physical bus — worth running for any new packet-building
logic, not just as an afterthought.

---

## 12. Testing status — what's actually verified

Testing maturity **varies significantly by node** — do not assume something works
against real hardware just because it's present in the published package. The
authoritative, version-by-version record is `CHANGELOG_FORUM.md`; check the entries for
the specific node/command you're relying on before treating it as proven. As a general
orientation at the time of writing:

- **Field-tested against live hardware:** the core relay, dimmer, glass panel, and
  thermostat nodes have real-hardware confirmation for their primary functions.
  `VMBGPOD` (0x28) specifically confirmed 09/07/2026 against two real panels on
  Stuart's own home bus, closing out the v0.9.2/v0.9.3 registry-gap saga with an
  actual result rather than just a passing test.
- **`velbus-button` had a critical, real bug from its first version until v0.9.4** —
  see section 4.3 for the full story. Its press/release/long-press decode is now
  fixed and verified with a real repro, but has not yet been re-confirmed against a
  live button press on real hardware (only via the mock harness) — worth doing
  before trusting it fully, given how long the broken version went unnoticed.
- **Mock-harness verified only, not yet confirmed against a real bus:** `velbus-clock`
  (both the time/date/DST broadcast and the `set_alarm` command), the
  `velbus-dimmer-20` `get_device_type` read command, and `velbus-energy` in its
  entirety (no VMBPSUMNGR-20 has been confirmed present on a scanned bus yet).
- **Fixed but pending re-confirmation on hardware different from what it was originally
  tested on:** several nodes had packet-construction bugs fixed in bulk during one
  intensive debugging pass (see `CHANGELOG_FORUM.md`, the entries covering versions
  0.6.6 through 0.7.0) — confirm against whatever specific module you're working with
  if you haven't personally seen it work.

---

## 13. Known open issues

- **`VMBKP` (0x42, "Keypad interface module") has no node at all.** Found scanning a
  real installation (Stuart's home) — confirmed present at address `0xFD`, a real
  module on a real bus, not a hypothetical. A genuinely new module type, not yet
  scoped. Its protocol PDF (`protocol_vmbkp.pdf`, 28 pages) is substantial: channel
  status, module status, and a full per-channel LED control layer
  (clear/set/slow-blink/fast-blink/very-fast-blink), similar in spirit to `velbus-button`
  but with LED feedback control `velbus-button` doesn't have. This needs the same
  "how much work would this involve" scoping pass `velbus-energy` got before it was
  built, not a quick bolt-on to an existing node.
- **Open-collector support** on several glass panel types (marked "unconfirmed" in the
  registry in section 6) has not been verified against real hardware — the protocol PDFs
  are ambiguous or silent on some of these. Sending `0x01`/`0x02`/`0x03` open-collector
  commands to one of these modules and observing whether it responds would resolve this.
- **Module names at type bytes `0x53` and `0x5C`** — the official Velbus type list shows
  different module names than what this registry currently uses for these two type
  bytes. Needs verification against a real module or a VelbusLink bus scan.
- **`velbus-energy` verified only against a mock test harness** — no
  VMBPSUMNGR-20 has actually been confirmed present on a scanned bus yet, only
  assumed likely present at a known installation. Packet checksums and field
  layout are hand-verified against the protocol PDF; real-hardware behaviour
  is unconfirmed. The `0xA3` (PSU values) byte layout in particular was
  reconstructed from an internally-inconsistent section of the official PDF
  (see `CHANGELOG_FORUM.md`, v0.9.0) rather than read directly — the single
  most likely spot for a real decode error to surface once tested live.
- **V2 relay interval/blink timer** — confirmed there is no live bus command for this on
  V2-series relays at all (unlike the original series, which has one). A real interval
  timer on a V2 relay requires writing a Program Step to the module's memory (protocol
  command `0xC2`, Action code 22), which is a fundamentally different, more involved
  kind of operation than any other command node in this palette currently performs.
  Whether this belongs in this palette at all (as a new, more involved node) or is out
  of scope is an open question, not a settled one.
- **`velbus-clock`'s multi-channel behaviour** during simultaneous multi-channel relay
  blinking (interval timer) hasn't been explicitly tested for whether `channel`/
  `channelBit` fields report correctly when more than one channel blinks at once.
- **DST auto-detection heuristic** in `velbus-clock` (comparing the current UTC offset
  against the year's January/July offsets to infer whether daylight saving is active)
  has only been sanity-checked in an environment where daylight saving never applies —
  a genuine positive "DST is active" case hasn't been observed and confirmed correct.
- **`VMB1DM`, `VMBDME`, `VMB1LED` (dimmer-family additions) deferred, not built.**
  All three use a genuinely different single-channel `0xEE` status layout
  (mode/dim-value/LED/timer/config in one packet) — distinct from both
  `velbus-dimmer`'s own `0xB8`-based format and `velbus-dimmer-20`'s
  multi-channel bitmask `0xEE` format. Needs real new decode logic, not a
  registry entry — see `coverage-roadmap.md` for the full reasoning.
- **Bus error counter (`0xDA`) — design settled, not built.** Confirmed
  useful but explicitly framed as a rare edge case. Resolved design: every
  node that registers for its own address already receives an unsolicited
  `0xDA` broadcast if one occurs, so no new request command is needed —
  just passive decoding, emitted only on a secondary output and only when
  at least one counter is non-zero, so it never appears during normal
  operation. Deliberately deferred since it touches most/all existing nodes
  — a session of its own, not a quick addition.
- **OLED image writing — stretch goal, not built.** Pushing a custom B&W
  1-bit bitmap to an OLED glass panel (e.g. swapping in a different-language
  greeting for a visitor without opening VelbusLink) — genuine use case,
  explicitly not urgent. `velbus-glass-panel` currently only reads memo text
  (`0xAC`), no write path exists in either direction for display content.
- **`VMBDALI`/`VMBDALI-20`, `VMBLCDWB`, `VMCM3`, `VMBSIG`/`VMBSIG-20`/`VMBSIG-21`
  — recognized, deliberately not supported.** These show their correct name
  in a scan (not `unknown_0xNN`) with an explicit `"Not supported"` in place
  of a suggested node, rather than silently falling through to `null`. DALI
  is its own protocol layer beyond the gateway; the Signum types are a
  proprietary HomeAssistant-based master clock, not interactable; VMBLCDWB
  and VMCM3 are legacy/custom modules with no planned support. By design,
  not oversight — see `coverage-roadmap.md` for the full per-type reasoning.

---

## 14. Contribution and release workflow

**Every release, regardless of size:**

1. **Bump the version** in `package.json` — npm refuses to publish an already-used
   version number, even for a trivial fix. Add a matching entry to
   `CHANGELOG_FORUM.md` describing what changed and, where relevant, *why* — the reasoning
   behind a fix is often more valuable to a future reader than the diff itself.
2. **Commit and push:**
   ```bash
   git add -A
   git commit -m "Describe the change"
   git push
   ```
3. **Publish to npm:**
   ```bash
   npm publish
   ```

**Publishing requires either 2FA enabled on the npm account used, or a Granular Access
Token with "Bypass two-factor authentication" explicitly ticked** — npm's current
policy rejects publish attempts otherwise with a `403` error. Whoever is publishing
needs one or the other set up; this has been a real stumbling block in practice.

**Recommended, not required:** tag the release to match, so it's easy to see which
commit corresponds to which published version:
```bash
git tag v<version>
git push --tags
```

**When adding a new node:**
- Copy the closest existing equivalent as a starting structure rather than writing from
  scratch — the bridge lookup, packet registration, and status-bar boilerplate is
  consistent throughout and easy to get subtly wrong if reinvented.
- Register it in `package.json`'s `node-red.nodes` map — Node-RED will not discover a
  node that exists as a file but isn't listed there.
- Verify the packet construction using the mock-harness pattern
  ([section 11](#11-testing-without-real-hardware--the-mock-harness-pattern)) before
  ever sending it to a real bus.
- Add its testing status honestly to `CHANGELOG_FORUM.md` — "verified via mock harness
  only, not yet confirmed on real hardware" is a completely acceptable and expected
  status for a new addition; the goal is accuracy, not appearing more finished than it is.

---

## 15. Where to find protocol references

- **`https://github.com/velbus/packetprotocol`** — the low-level packet framing
  specification (start/end markers, priority byte values, checksum algorithm).
- **`https://github.com/velbus/moduleprotocol`** — per-module protocol PDFs, one (or a
  few, where several similar modules share one document) per module type. This is the
  authoritative source for any module-specific command/status byte layout — always
  check the actual PDF for the specific module type you're working on rather than
  assuming it matches a similar-looking one, given how many small but real differences
  exist between superficially similar modules (see sections 7.2 and 7.10 for two
  concrete examples of official documentation being subtly wrong or inconsistent).
- **`https://github.com/velbus/python-velbustcp`** — an open-source TCP gateway
  implementation; one of two practical ways (alongside Velbus's own `velbus-tcp`
  package) to get a real bus accessible over TCP for this palette to connect to.
- The Velbus community forum (search for "building custom velbus devices") has at least
  one publicly documented from-scratch virtual-module implementation, which has proven a
  useful cross-reference for less-obvious bit-level encoding questions (particularly
  around relay status packet formats) beyond what the official PDFs spell out clearly.
- Other open-source Velbus integrations worth cross-referencing when a protocol question
  isn't fully resolved by the official docs: the openHAB Velbus binding, and the
  HomeAssistant `velbusaio` integration — both are mature, independently-implemented
  interpretations of the same protocol, and occasionally clarify an ambiguity the
  official PDFs leave unclear.

---

## 16. Code style rules

- **No pseudocode, ever.** Every function, file, and HTML block committed should be a
  complete, working, drop-in replacement — never a partial sketch or a "fill this in"
  skeleton.
- **Prove the logic before restructuring it.** Get a single packet working and verified
  (even just via the mock harness) before refactoring for elegance or reuse.
- **`body[0]` is always the command byte.** Real data starts at `body[1]`. No
  exceptions — see section 4.3 if this isn't already second nature.
- **Numbers are always numbers in payloads, never strings.**
- **`results.modules`, not `results`,** when reading the scan endpoint.
- **A module type lives in three separate files, not one** (per-node `lib/` registry,
  that node's own `.html` dropdown copy, and `velbus-scan.js`'s independent copy) —
  see section 3 for the full explanation. Missing one produces a symptom in a
  different part of the palette than wherever the type was actually added.
- **Never assume a feature is universal across a module family — check each type's
  own protocol document.** Proven wrong repeatedly (09/07/2026) while adding
  lock/unlock and richer status decode to `velbus-button`: of 12 button-family
  types, 4 genuinely lack the lock/unlock command entirely (not "probably most
  don't" — specific, named exceptions); one type's status uses a completely
  different command byte (`0xB4` instead of `0xED`); the "which channel" selector
  byte in the name-request commands uses two incompatible conventions (bitmask vs.
  literal number) that happen to produce identical values for channels 1-2 and only
  diverge from channel 3 onward — exactly the kind of divergence that survives
  casual testing. When a person asks for a capability "because it's a key feature,"
  that's a reason to verify it broadly, not a reason to skip checking each type.
- **Registry type-byte keys need the same verification as everything else** — don't
  assume an existing entry's key is correct just because it's already shipped.
  Found 09/07/2026: `VMB4PB` and `VMB6PB-20` had been keyed under wrong type bytes
  in `velbus-button.js`'s own registry since v0.5.2 (`0x1C`, which isn't a real
  Velbus type byte at all, and `0x20`, which actually belongs to `VMBGP4`) — while
  `velbus-scan.js` had always had the correct values. Cross-check against the
  official type list (section 15) periodically, not just when adding something new.
- **Thermostat commands go to the primary address only,** never a subaddress.
- **Respect the 20ms minimum between `0xFC` writes** on original-series modules — this
  is real EEPROM wear, not an arbitrary rate limit.
- **British English** throughout documentation and in-editor help text (this is a
  British-developed project for what is predominantly a European/UK installer base —
  purely a style convention, not a functional requirement).

---

## 17. License and attribution

MIT licensed — see `LICENSE`.

Originally developed by Stuart Hanlon / MDAR Limited, the UK Velbus distributor
(`mdar.co.uk`), as a modern replacement for an earlier, unmaintained community Velbus
Node-RED palette. Protocol reverse-engineering and verification work throughout this
project has drawn on the official Velbus protocol repositories, the Velbus community
forum, and cross-referencing against other independent open-source Velbus integrations
— see [section 15](#15-where-to-find-protocol-references) for specific links.

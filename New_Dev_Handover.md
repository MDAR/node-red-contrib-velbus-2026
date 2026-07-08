# HANDOVER.md â€” node-red-contrib-velbus-2026

**A complete technical reference for developing this Node-RED palette, written to assume
no prior context.** If you are picking this project up for the first time â€” whether
you're a new contributor, a new maintainer, or an AI assistant starting a fresh session
with no memory of previous work â€” this document should be sufficient on its own, together
with the source code in this repository, to continue development competently.

Current state at time of writing: **v0.8.1, 18 nodes, published on npm.**

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
9. [Architecture decisions (settled â€” do not reopen casually)](#9-architecture-decisions-settled--do-not-reopen-casually)
10. [Development environment setup](#10-development-environment-setup)
11. [Testing without real hardware â€” the mock-harness pattern](#11-testing-without-real-hardware--the-mock-harness-pattern)
12. [Testing status â€” what's actually verified](#12-testing-status--whats-actually-verified)
13. [Known open issues](#13-known-open-issues)
14. [Contribution and release workflow](#14-contribution-and-release-workflow)
15. [Where to find protocol references](#15-where-to-find-protocol-references)
16. [Code style rules](#16-code-style-rules)
17. [License and attribution](#17-license-and-attribution)

---

## 1. What this project is

**Velbus** is a CAN-bus-based building automation system, manufactured by Velbus Belgium.
Installations consist of physical modules on a shared bus â€” relay outputs, dimmers,
touch-sensitive glass control panels, PIR motion sensors, blind/shutter controllers,
weather stations, and more â€” each with a unique bus address. Modules are commissioned
using Velbus's own **VelbusLink** software, and communicate over the bus using a
well-documented binary packet protocol (official reference repositories linked in
[section 15](#15-where-to-find-protocol-references)).

**This project** is a Node-RED palette: a set of custom nodes that let a Node-RED flow
read and write to a live Velbus bus. It connects to the bus via a TCP gateway (either
Velbus's own `velbus-tcp` snap package, or the open-source `python-velbustcp` project â€”
both simply expose the same underlying serial/CAN bus protocol over a TCP socket). Once
connected, each node in this palette represents one physical module (or, for a couple of
nodes, a bus-wide function) and translates between Velbus's binary packets and normal
Node-RED JSON messages.

**Two module generations exist** and are handled throughout this codebase as a first-class
distinction:
- **Original series** â€” the older module generation. Simpler protocol, no firmware/CAN FD
  concept.
- **V2 / "-20" series** â€” the current module generation (module type names ending `-20`,
  e.g. `VMB4RYLD-20`). Richer protocol, CAN FD capable, firmware version checking.

Where a module type exists in both generations, this palette generally provides two
separate nodes (e.g. `velbus-relay` for original-series relays, `velbus-relay-20` for
V2 relays) rather than one node trying to handle both â€” see
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
   node's config panel) â€” set the host/port of your Velbus TCP gateway.
2. Drag a **velbus-scan** node, wire an inject node into it, deploy, and fire it â€” this
   performs a full bus scan and populates every other node's address dropdown with the
   modules it finds.
3. Add nodes for the specific modules on your bus (see [section 5](#5-complete-node-reference)
   for the full list), select their address from the now-populated dropdown, and deploy.

No Velbus hardware to hand? See [section 11](#11-testing-without-real-hardware--the-mock-harness-pattern)
for how development and testing have been done without a live bus.

---

## 3. Repository structure

```
package.json              npm package definition â€” the node-red.nodes map here is how
                           Node-RED discovers every node; a new node must be registered here
index.js                  Intentionally minimal â€” Node-RED finds nodes via package.json, not this file
README.md                 User-facing installation and usage documentation
CHANGELOG_FORUM.md         Full version-by-version development history â€” read this before
                           assuming something hasn't been tried or fixed already
LICENSE                    MIT

lib/                       Shared code â€” protocol utilities and per-module-family type registries
  velbus-utils.js           chk() checksum, pkt()/rtrPkt() packet builders, parsePkt(),
                             splitPackets() â€” the packet framing primitives every node uses
  relay-types.js            Original-series relay module type registry
  relay-types-20.js         V2 relay module type registry
  dimmer-types.js            Original-series dimmer module type registry
  dimmer-types-20.js         V2 dimmer module type registry (incl. LED grouping mode / Device
                             Type table for VMB4LEDPWM-20)
  glass-panel-types.js       All 26 glass panel module types in one registry (hasOled/hasPir/
                             hasOc/minMapVer flags per type)
  pir-types.js / pir-types-20.js       PIR sensor module type registries
  sensor-types.js / sensor-types-20.js Sensor/meteo module type registries
  blind-types.js / blind-types-s.js / blind-types-20.js   Blind/shutter module type registries
                             (three files because the blind family splits by protocol
                             capability, not simply by generation â€” see section 9)

nodes/                      One directory per node, each containing a .js (logic) and
                             .html (editor UI + in-editor help) file of the same name
  velbus-bridge/             Config node â€” the only node that holds the actual TCP connection
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
  velbus-clock/               Broadcasts system time/date/DST and clock alarms â€” the one
                              node with no fixed module address, see section 5

examples/
  velbus-basic-relay-dimmer.json   A minimal example flow, importable directly in Node-RED
```

**Convention for adding a new node:** copy the structure of the most similar existing node
(same module family or same generation) rather than starting from a blank file â€” the
boilerplate (bridge lookup, packet registration, status bar handling, firmware check for
V2 nodes) is consistent across every node and easy to get subtly wrong if rebuilt from
scratch.

---

## 4. Architecture overview

### 4.1 The bridge is the only thing that touches the network

`velbus-bridge` is a Node-RED **config node** (shared, not visible as a flow node itself)
that owns the actual TCP socket to the Velbus gateway. It handles:
- Connecting (plain TCP or TLS, with optional auth-key handshake for `python-velbustcp`)
- Auto-reconnect on disconnect (5 second backoff)
- Splitting the raw TCP byte stream into individual packets (`splitPackets()` in
  `lib/velbus-utils.js` â€” a stream doesn't respect packet boundaries, so this has to
  track a remainder buffer across multiple `data` events)
- Dispatching each parsed packet to whichever node(s) have registered interest in that
  module address (`bridge.register(address, callback)` / `bridge.deregister(...)`)
- A **scan lock** mechanism: while a bus scan is in progress, other nodes' startup RTR
  (request-to-respond) packets are queued rather than sent immediately, and flushed
  one-per-second once the scan completes â€” prevents startup traffic from colliding with
  an active scan
- Serving persisted scan results to the editor's config dialogs, via an HTTP endpoint:
  `GET /velbus/scan-results?bridge=<bridge-node-id>` â†’ `{ modules: [...], count: N }`.
  **The endpoint returns an object, not an array â€” always use `results.modules`, not
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
| `pri` | Priority byte â€” see below |
| `addr` | Target/source module address (`0x00` = broadcast, `0x01`â€“`0xFE` = a real module) |
| `dlc` | Data length (low 4 bits = body byte count), or `0x40` for an RTR (request) packet |
| `body...` | The actual command/data bytes â€” see [section 4.3](#43-the-body-indexing-rule) |
| `chk` | Checksum â€” two's complement of the sum of all preceding bytes, mod 256 |
| `0x04` | End-of-frame marker (fixed) |

**Priority byte values** (confirmed against the official `packetprotocol` repository â€”
see [section 15](#15-where-to-find-protocol-references)):

| Value | Meaning |
|---|---|
| `0xF8` | High priority |
| `0xF9` | Firmware-related |
| `0xFA` | Third-party |
| `0xFB` | Low priority |

In practice, this codebase's convention (established after a real, painful bug â€” see
`CHANGELOG_FORUM.md` v0.7.0) is: **`0xFB` for status requests (`0xFA` command) and RTR
scan packets; `0xF8` for essentially everything else**, including outgoing commands and
most spontaneous module broadcasts. This is a convention observed to match real hardware
behaviour, not a rule stated explicitly and completely in the official docs â€” when in
doubt for a new packet type, check the specific module's protocol PDF for its actual
priority bits rather than assuming.

An RTR (bus scan request) packet has no body at all: `0F FB [addr] 40 [chk] 04`.

**Checksum** â€” sum every byte from the start marker through the last body byte
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

### 4.3 The body indexing rule â€” the single most common source of bugs

`parsePkt()` returns a `body` array where **`body[0]` is always the command byte itself**
(what the official protocol PDFs call DATABYTE1). Actual data starts at `body[1]`
(DATABYTE2).

```
PDF says "DATABYTE2 = channel number"  â†’  code should read body[1]   âœ“
                                        â†’  code reading body[2] is WRONG (that's DATABYTE3)
```

This off-by-one is the single most common mistake made throughout this project's
development history (see `CHANGELOG_FORUM.md` for several real instances). When
implementing a new packet handler, always write out the DATABYTE-to-`body[]` index
mapping explicitly as a comment before writing the parsing logic â€” it is not something
to trust from memory or infer quickly.

### 4.4 Address format

Module addresses are stored as **hex strings in the editor's dropdown UI** (e.g.
`"0x0D â€” VMBELO"`) but **stored in the actual node config as a decimal integer**.
Numbers appearing in an old saved flow (from before hex-string dropdowns existed) should
still be treated as decimal for backward compatibility; new saves from the current editor
use hex strings. Both are handled by the same address-parsing logic in each node â€” if
you're seeing an address parse incorrectly, check whether the value arrived as a number
or a string before assuming the parsing logic itself is wrong.

---

## 5. Complete node reference

| Node | Category | Covers |
|---|---|---|
| `velbus-bridge` | config | The TCP connection itself â€” see section 4.1 |
| `velbus-scan` | Velbus (inputs) | Full bus scan, populates every other node's address dropdown |
| `velbus-relay` | Velbus (outputs) | Original-series relays: VMB1RY, VMB4RY, VMB4RYLD, VMB4RYNO, VMB1RYNO, VMB1RYNOS, VMB1RYS, VMB4RYLD-10, VMB4RYNO-10 |
| `velbus-relay-20` | Velbus (outputs) | V2 relays: VMB1RYS-20, VMB4RYLD-20, VMB4RYNO-20 |
| `velbus-dimmer` | Velbus (outputs) | Original-series dimmers: VMBDMI, VMBDMI-R, VMB4DC |
| `velbus-dimmer-20` | Velbus (outputs) | V2 dimmers: VMB2DC-20, VMB8DC-20, VMB4LEDPWM-20 (incl. RGB/RGBW grouping mode) |
| `velbus-glass-panel` | Velbus (inputs) | All 26 glass panel types (original + V2), buttons/OLED/PIR/open-collector as applicable per type |
| `velbus-thermostat` | Velbus (inputs) | Thermostat function on any glass panel module that has one â€” same address as the corresponding glass-panel node, coexists without conflict |
| `velbus-button` | Velbus (inputs) | Dedicated push-button modules: VMB8PB, VMB8PBU, VMB6PBN, VMB2PBN, VMB4PB, VMB6PB-20 |
| `velbus-pir` | Velbus (inputs) | Original-series PIR: VMBPIRO-10, VMBPIRM, VMBPIRC, VMBPIRO |
| `velbus-pir-20` | Velbus (inputs) | V2 PIR: VMBPIR-20, VMBPIRO-20 |
| `velbus-meteo` | Velbus (inputs) | Weather station: VMBMETEO |
| `velbus-sensor` | Velbus (inputs) | Original-series input/analogue: VMB7IN, VMB4AN |
| `velbus-sensor-20` | Velbus (inputs) | V2 input: VMB8IN-20 |
| `velbus-blind` | Velbus (outputs) | VMB1BL, VMB2BL |
| `velbus-blind-s` | Velbus (outputs) | VMB1BLS, VMB2BLE, VMB2BLE-10 |
| `velbus-blind-20` | Velbus (outputs) | VMB2BLE-20 |
| `velbus-clock` | Velbus (outputs) | **No fixed module address.** Broadcasts system time/date/DST to the bus broadcast address (`0x00`), and sets clock alarms either globally (broadcast) or locally (a specific module, via a per-message address override) |

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

### Push buttons
| Type byte | Module | Node |
|---|---|---|
| 0x01 | VMB8PB | velbus-button |
| 0x16 | VMB8PBU | velbus-button |
| 0x17 | VMB6PBN | velbus-button |
| 0x18 | VMB2PBN | velbus-button |
| 0x44 | VMB4PB | velbus-button |
| 0x4C | VMB6PB-20 | velbus-button |

### Glass panels (all â†’ velbus-glass-panel, 26 types)
| Type byte | Module | OLED | PIR | Open collector | Min. map version |
|---|---|---|---|---|---|
| 0x1E | VMBGP1 | no | no | unconfirmedÂ¹ | â€” |
| 0x1F | VMBGP2 | no | no | unconfirmedÂ¹ | â€” |
| 0x20 | VMBGP4 | no | no | unconfirmedÂ¹ | â€” |
| 0x21 | VMBGPO | yes | no | yes | 2 |
| 0x2D | VMBGP4PIR | no | yes | unconfirmedÂ¹ | â€” |
| 0x34 | VMBEL1 | no | no | yes | 2 |
| 0x35 | VMBEL2 | no | no | yes | 2 |
| 0x36 | VMBEL4 | no | no | yes | 2 |
| 0x37 | VMBELO | yes | no | yes | 4 |
| 0x38 | VMBELPIR | no | yes | yes | 2 |
| 0x3A | VMBGP1-2 | no | no | noÂ² | â€” |
| 0x3B | VMBGP2-2 | no | no | noÂ² | â€” |
| 0x3C | VMBGP4-2 | no | no | noÂ² | â€” |
| 0x3D | VMBGPOD-2 | yes | no | unconfirmedÂ¹ | 2 |
| 0x47 | VMBEL2PIR | no | yes | yes | â€” |
| 0x4F | VMBEL1-20 | no | no | yes | â€” |
| 0x50 | VMBEL2-20 | no | no | yes | â€” |
| 0x51 | VMBEL4-20 | no | no | yes | â€” |
| 0x52 | VMBELO-20 | yes | no | yes | â€” |
| 0x53 | VMBELPIR-20Â³ | no | yes | yes | â€” |
| 0x54 | VMBGP1-20 | no | no | unconfirmedÂ¹ | â€” |
| 0x55 | VMBGP2-20 | no | no | unconfirmedÂ¹ | â€” |
| 0x56 | VMBGP4-20 | no | no | unconfirmedÂ¹ | â€” |
| 0x57 | VMBGPO-20 | yes | no | yes | â€” |
| 0x5C | VMBEL2PIR-20Â³ | no | yes | yes | â€” |
| 0x5F | VMBGP4PIR-20 | no | yes | unconfirmedÂ¹ | â€” |

Â¹ Open-collector support unconfirmed against real hardware â€” see [section 13](#13-known-open-issues).
Â² Confirmed no open-collector commands in the protocol PDF, but not yet live-verified.
Â³ The official Velbus type list shows different module names at these two type bytes than
what this registry currently uses â€” flagged for verification, see
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

### Blind / shutter
| Type byte | Module | Node |
|---|---|---|
| 0x03 | VMB1BL | velbus-blind |
| 0x09 | VMB2BL | velbus-blind |
| 0x1D | VMB2BLE | velbus-blind-s |
| 0x2E | VMB1BLS | velbus-blind-s |
| 0x4A | VMB2BLE-10 | velbus-blind-s |
| 0x61 | VMB2BLE-20 | velbus-blind-20 |

### Not yet built
| Type byte | Module | Status |
|---|---|---|
| 0x04 | VMBPSUMNGR-20 (energy/power supply monitor) | No node yet â€” see [section 13](#13-known-open-issues) |

---

## 7. Critical protocol knowledge

### 7.1 Firmware build number â€” the official docs mislabel this field

In the `0xFF` module-identification response, bytes labelled "Build Year" and
"Build Week" in the official protocol PDFs are, in every module tested against real
hardware, actually the **high and low bytes of a single build number**, not a
year/week pair:

```
build = (body[5] Ã— 100) + body[6]
Example: body[5]=0x24 (36 decimal), body[6]=0x36 (54 decimal) â†’ (36Ã—100)+54 = 3654
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
body[7] = properties byte â€” V2 modules only (bit 5 = CAN FD capable, bit 0 = terminator fitted)
```
Original-series modules: 7 bytes total (no `body[7]`).
Exceptions confirmed against real hardware: **VMB1BL/VMB2BL** send only 5 bytes (no
serial number;

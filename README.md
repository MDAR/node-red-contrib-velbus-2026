# node-red-contrib-velbus-2026

A Node-RED palette for [Velbus](https://www.velbus.eu) building automation systems.

> **⚠ Testing status:** This palette was generated with Claude.ai and is in need of
> extensive field testing before being deployed into a commercial project. It is presented
> "as is" — any use beyond testing is entirely at your own risk and liability.
> Constructive feedback is welcomed, accompanied by as many examples and debug captures
> as possible. Please
> [file an issue on GitHub](https://github.com/MDAR/node-red-contrib-velbus-2026/issues).

---

## About

Velbus is a CAN-bus building automation system manufactured in Belgium. This palette
provides Node-RED nodes for all major Velbus module families — both the original series
and the current V2 (-20 series) modules.

Developed and maintained by [MDAR Limited](https://mdar.co.uk), the UK distributor
for Velbus building automation systems.

This is a ground-up rewrite replacing the abandoned
[node-red-contrib-velbus](https://github.com/gertst/node-red-contrib-velbus) palette
(last updated 2020).

---

## Requirements

- Node-RED v3.0 or later (tested on v5.0)
- A Velbus TCP gateway:
  - [velbus-tcp snap](https://snapcraft.io/velbus-tcp)
  - [python-velbustcp](https://github.com/velbus/python-velbustcp)
  - [C++ Velserv](https://forum.velbus.eu/t/how-to-install-and-run-velserv-a-velbus-tcp-gateway/15422)
  - [PureBasic Velbus_PBserver](https://forum.velbus.eu/t/an-other-velbus-server-purebasic/5523)
  - [Signum](https://www.velleman.eu/products/search/?q=signum&search=Search)
- Node.js 18+
- **Optional, for the module emulators (`velbus-emulate-*`) only**: a
  persistent context store configured in `settings.js` if you want their
  memory (channel names, Linked Push Button entries) to survive a Node-RED
  restart — e.g. `contextStorage: { default: { module: "localfilesystem" } }`.
  Without it, the emulators still work fully, they just reset to
  factory-fresh memory on every restart.

---

## Installation

Via palette manager: search for `velbus-2026`.

Via npm:
```bash
cd ~/.node-red
npm install node-red-contrib-velbus-2026
```

Via local tarball:
```bash
cd ~/.node-red
npm install /path/to/node-red-contrib-velbus-2026_vX.Y.Z.tar.gz
```
(replace `X.Y.Z` with whichever version tarball you have — deliberately not
hardcoded here, since a literal version number in this file has gone stale
every single time it's been written one before)

---

## Nodes

### Infrastructure
| Node | Description |
|---|---|
| `velbus-bridge` | Config node. TCP/TLS connection to gateway. Handles packet routing, subaddress mapping, scan locking. |
| `velbus-scan` | Bus scanner. Sends RTR to all addresses 0xFE→0x01, collects 0xFF responses. Populates address dropdowns in all other nodes. |

### Inputs (teal)
| Node | Modules |
|---|---|
| `velbus-glass-panel` | All VMBEL and VMBGP variants — 29 types including OLED, PIR, and original series. Thermostat, LED control, open collector. `VMBEL` family only: edge colour control (`set_edge_color`) — applies an already-defined colour across layer/edge/page combinations; defining new custom colours stays in VelbusLink. |
| `velbus-thermostat` | Dedicated thermostat node for all glass panel modules. |
| `velbus-button` | 12 types across original and V2 series: VMB8PB, VMB8PBU, VMB6PBN, VMB2PBN, VMB4PB, VMB6PB-20, VMB8IR, VMB4PD, VMB4RF, VMBRFR8S, VMBVP01, VMBKP, VMBIN. Lock/unlock and richer status decode where the specific type supports it (not universal); named channels in event output; fixed semantic labels for VMBVP01 (DoorBird). |
| `velbus-pir` | VMBPIRM, VMBPIRC, VMBPIRO, VMBPIRO-10 |
| `velbus-pir-20` | VMBPIR-20, VMBPIRO-20 |
| `velbus-meteo` | VMBMETEO — wind, rain, light, temperature, alarm outputs |
| `velbus-sensor` | VMB7IN (8 digital inputs + 4 pulse counters), VMB4AN (channels 1-8 alarm outputs + generic analogue reading on channels 9-12 — mode-aware but deliberately no engineering-unit conversion), VMB6IN (6 digital inputs) |
| `velbus-sensor-20` | VMB8IN-20 (8 digital + 24 alarm channels via subaddresses, energy counters) |

### Outputs (blue)
| Node | Modules |
|---|---|
| `velbus-relay` | VMB1RY, VMB4RY, VMB4RYLD, VMB4RYNO, VMB1RYNO, VMB1RYNOS, VMB1RYS, VMB4RYLD-10, VMB4RYNO-10 |
| `velbus-relay-20` | VMB1RYS-20, VMB4RYLD-20, VMB4RYNO-20 |
| `velbus-dimmer` | VMBDMI, VMBDMI-R, VMB4DC |
| `velbus-dimmer-20` | VMB2DC-20, VMB8DC-20, VMB4LEDPWM-20 |
| `velbus-blind` | VMB1BL, VMB2BL — original series, stop/up/down only |
| `velbus-blind-s` | VMB1BLS, VMB2BLE, VMB2BLE-10 — full position, lock, force, inhibit |
| `velbus-blind-20` | VMB2BLE-20 — V2 series with CAN FD support |
| `velbus-clock` | No fixed module — broadcasts time/date/DST to bus address `0x00`, plus global/local clock alarm and sunrise/sunset enable (V2 series only) |
| `velbus-energy` | VMBPSUMNGR-20 — power supply manager: PSU load, live wattage/voltage/amperage, warranty counter, PSU alarms (V2 series only) |
| `velbus-emulate-button-io` | **Module emulator** (new "Velbus (emulate)" category) — emulates a real VMB4PB in "I/O module" mode: 4 button inputs + 4 open-collector outputs, so VelbusLink can scan, see, and link against it without physical hardware |
| `velbus-emulate-dimmer` | **Module emulator** — emulates a real VMB4DC, for the same training/testing purpose as above |
| `velbus-emulate-counter` | **Module emulator** — emulates a real VMB7IN pulse-counting utility meter interface. Purpose-built for bringing third-party data (MQTT, Modbus, anything Node-RED can reach) onto the Velbus bus as a genuine module, so VelbusLink can assign it to a real OLED Counter page — not a scrolling text banner |

---

## Examples

After installation, example flows are available via **Import → Examples → node-red-contrib-velbus-2026**
in the Node-RED editor.

### velbus-scan-and-relay
Bus scan, then on/off/toggle relay control — toggle demonstrates the
node's own internal state tracking, not a wire command. Uses only core
Node-RED nodes (inject, debug, comment) plus this package's own nodes, no
other palette required.

**To use:** configure the velbus-bridge node, click "Scan bus" to find
modules, open the relay node and select a real relay address from the
scan results, then deploy and use the On/Off/Toggle inject buttons.

### velbus-dimmer-levels
Preset-percentage dimmer control via inject buttons (0%, 25%, 50%, 100%).

**To use:** configure the velbus-bridge node, open the dimmer node and
select a real V2-series dimmer address, then deploy.

### velbus-scan-and-debug
A minimal bus scan with two debug outputs — the full raw scan result, and
a status-line view showing just each discovered module as it's found.

**To use:** configure the velbus-bridge node, deploy, then click "Scan".

### velbus-VMB4PB-emulator
Exercises `velbus-emulate-button-io`'s full input contract: simulated
button events (press/release/long, individually or combined) and direct
output commands (on/off/toggle/force_off/force_toggle/force_cancel).

**To use:** configure the velbus-bridge node, confirm the emulator's
address (0x60) is free on your bus, deploy, then try the inject buttons —
watch the debug sidebar for the resulting output and forced-state changes.

### velbus-counter-emulator-random-values
Generates plausible-looking live data for `velbus-emulate-counter`'s 4
reference channels (electricity/kWh, water/liter, gas/m³, a second
liter channel) every 3 seconds — useful for watching real OLED Counter
page behaviour update live without a real utility meter connected.

**To use:** configure the velbus-bridge node, confirm the emulator's
address (0x50) and channel configuration match your own setup, then
deploy — the inject node fires automatically every 3 seconds. Cumulative
values genuinely accumulate over time (reset on redeploy); the current
rate is randomised within a plausible range each cycle rather than
derived from the cumulative change, so treat it as "moving numbers for a
real display," not a physically accurate simulation.

---

## Quick start

1. Add a **velbus-bridge** config node pointing at your gateway (default: `127.0.0.1:6000`)
2. Add a **velbus-scan** node, connect to the bridge, deploy and inject to scan
3. All other nodes will have address dropdowns populated from the scan results
4. Add the node for your module type, select the address, deploy

---

## Confirmed hardware

Tested on a live 18-module installation including VMBEL4, VMBELO, VMBELPIR,
VMBPIR-20, VMB1RYS, and VMB8DC-20. CAN FD modules confirmed working.
`VMBGPOD` specifically confirmed against two real panels on a separate
installation, after an earlier gap where it showed as `unknown` in a scan.

---

## Further documentation

- [`HANDOVER.md`](https://github.com/MDAR/node-red-contrib-velbus-2026/blob/main/HANDOVER.md) —
  comprehensive technical reference for developing this palette: architecture, protocol
  quirks found the hard way, per-node testing status, and known open issues. Written to
  assume no prior context.
- [`CHANGELOG_FORUM.md`](https://github.com/MDAR/node-red-contrib-velbus-2026/blob/main/CHANGELOG_FORUM.md) —
  full version-by-version development history, including *why* things changed, not just what.
- [`coverage-roadmap.md`](https://github.com/MDAR/node-red-contrib-velbus-2026/blob/main/coverage-roadmap.md) —
  every Velbus module type and feature considered for this palette, what's in scope, and why.

---

## Contributing

Issues and pull requests welcome at the
[GitHub repository](https://github.com/MDAR/node-red-contrib-velbus-2026).

Please include Node-RED version, gateway type, module model and firmware build,
and a packet capture where possible.

---

## Licence

MIT — see [LICENSE](LICENSE)

## Author

Stuart Hanlon, [MDAR Limited](https://mdar.co.uk)

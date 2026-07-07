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
  - [velbus-tcp snap](https://snapcraft.io/velbus-tcp) (default port 6000)
  - [python-velbustcp](https://github.com/velbus/python-velbustcp) (default port 27015)
- Node.js 18+

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
npm install /path/to/node-red-contrib-velbus-2026_v0.8.1.tar.gz
```

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
| `velbus-glass-panel` | All VMBEL and VMBGP variants — 26 types including OLED, PIR, and original series. Thermostat, LED control, open collector. |
| `velbus-thermostat` | Dedicated thermostat node for all glass panel modules. |
| `velbus-button` | VMB8PB, VMB8PBU, VMB6PBN, VMB2PBN, VMB4PB, VMB6PB-20 |
| `velbus-pir` | VMBPIRM, VMBPIRC, VMBPIRO, VMBPIRO-10 |
| `velbus-pir-20` | VMBPIR-20, VMBPIRO-20 |
| `velbus-meteo` | VMBMETEO — wind, rain, light, temperature, alarm outputs |
| `velbus-sensor` | VMB7IN (8 digital inputs + 4 pulse counters), VMB4AN (16-channel analogue/alarm) |
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
| `velbus-clock` | No fixed module — broadcasts time/date/DST to bus address `0x00`, plus global/local clock alarm (V2 series only) |

---

## Examples

After installation, example flows are available via **Import → Examples → node-red-contrib-velbus-2026**
in the Node-RED editor.

### velbus-basic-relay-dimmer
A minimal working example with:
- Bus scan (inject to discover modules)
- Relay toggle — Dashboard 2 switch → velbus-relay command, with state feedback
- Dimmer slider — Dashboard 2 slider (0-100%) → velbus-dimmer-20 command, with level readout

**To use:** configure the velbus-bridge node, scan the bus, open the relay and dimmer
nodes and select your module addresses from the dropdowns, then deploy. Dashboard UI
at `/velbus`.

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

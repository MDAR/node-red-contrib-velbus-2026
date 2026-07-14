# Coverage Roadmap — Rationalized 09/07/2026

**STATUS: Implemented in v0.10.0 (09/07/2026).** Everything marked "confirmed
and ready to build" below has been built, tested, and shipped — including
the type-byte fixes and real protocol divergences caught along the way (see
`CHANGELOG_FORUM.md` v0.10.0 for the full list). The two genuinely deferred
items (dimmer family, bus error counter) and the OLED stretch goal are now
tracked directly in `HANDOVER.md` section 13 going forward — this document
remains as the record of the original rationalization discussion, not the
place to look for current status.

Synthesized from a full pass over every Velbus module type and feature not yet
covered by this palette. Organized by what actually needs to happen, not by the
order it came up in discussion.

---

## 1. New types to add to existing nodes' registries

No new nodes required — each of these is a straightforward registry addition
to a node that already exists and already handles this exact command family.

| Type | Module | Target node | Note |
|---|---|---|---|
| 0x07 | VMB1DM | `velbus-dimmer` | Old, likely rare in the field, minimal effort |
| 0x14 | VMBDME | `velbus-dimmer` | |
| 0x0F | VMB1LED | `velbus-dimmer` | Confirmed via protocol PDF: "PWM LED strip dimmer module" — genuinely dimmer-family, not a separate concept |
| 0x0A | VMB8IR | `velbus-button` | Confirmed — just a button-event module |
| 0x0B | VMB4PD | `velbus-button` | Reclassified from "not supported" — confirmed as a 4-button interface |
| 0x1A | VMB4RF | `velbus-button` | Presents 8 button events to the bus, nothing more |
| 0x30 | VMBRFR8S | `velbus-button` | Same mechanism as VMB4RF |
| 0x33 | VMBVP01 | `velbus-button` | DoorBird video intercom OEM module — 8 button events |
| 0x42 | VMBKP | `velbus-button` | Already agreed — plus lock/unlock and richer status decode (section 3) |
| 0x43 | VMBIN | `velbus-button` | Single-channel input, EOL but real installed base |
| 0x05 | VMB6IN | `velbus-sensor` | Sibling of VMB7IN |
| 0x3E | VMBGP4PIR-2 | `velbus-glass-panel` | Original-series-2 sibling of the -20 already covered |
| 0x25 | VMBGPTC | `velbus-glass-panel` | Confirmed — shares its actual protocol PDF with VMBGPO (0x21), genuine glass-panel sibling |

**Resolved — `VMB1TC`/`VMB1TS`: out of scope, not "super easy."** Checked the
actual protocol: `VMB1TC` has its own distinct command vocabulary ("Sensor
zone number," "sensor time statistics request," "lock/unlock sensor local
control") that doesn't overlay onto the existing `velbus-thermostat` decode —
this would be real new command handling, not a registry entry. Per the
stated condition, this stays out of scope. Nothing in Velbus is genuinely
wireless (confirmed) other than 433MHz/IR modules, which translate to the
bus rather than living on it — so no "W"-variant type IDs to separately track.

**Resolved — `VMBLCDWB` (0x13):** confirmed as a pre-glass-panel thermostat
controller (Velleman product page: 4-button control with LCD display, 32
functions, time/date backup). Out of scope, name-only in section 2.

---

## 2. Scan-table "see it, don't support it" additions

Named correctly in a scan (not `unknown_0xNN`), explicit "Not supported" note
in place of a suggested node — no live node built.

| Type | Module | Note |
|---|---|---|
| 0x45 / 0x5A | VMBDALI / VMBDALI-20 | Real prevalence (12 VLP projects) but DALI is its own protocol layer beyond the gateway — explicit "Not supported" label requested |
| 0x13 | VMBLCDWB | Pre-glass-panel thermostat controller (4-button + LCD + time/date backup) — confirmed out of scope, name only |
| 0x3F | VMCM3 | Custom corporate-client module, function unknown — name only |
| 0x39 / 0x5B / 0x60 | VMBSIG / VMBSIG-20 / VMBSIG-21 | Custom HomeAssistant-based master clock, not interactable — already named in the scanner; **worth aligning to the same explicit "Not supported" note style as VMBDALI for consistency**, rather than leaving these as a bare name with no note at all |
| 0x40 | VMBUSBIP | Already correctly handled as-is — no use in this context beyond potentially being what the bridge itself connects to |

---

## 3. Feature additions to existing nodes

- **`velbus-clock`: add sunrise/sunset enable/disable (`0xAE`)** — part of the
  same shared system block as time/date/DST/alarm, genuinely missing.
- **`velbus-button`: lock/unlock (`0x12`/`0x13`) + richer `0xED` status decode**
  (locked/enabled/inverted/program-selection) — already agreed, applies as a
  general button-family capability, not scoped to VMBKP alone.
- **`velbus-button`: surface channel names in the event output** — using the
  existing `0xF0`/`0xF1`/`0xF2` pattern, so named-channel modules (VMBKP, and
  potentially others) show real names, not just channel numbers, while every
  existing numbered-only setup keeps working unchanged.

- **Bus error counter (`0xDA`) — resolved design, scoped as a follow-up, not
  built today.** Confirmed genuinely useful, but explicitly framed as an edge
  case: "the once in a blue moon bus error message will clear itself within
  a second or two — including it in normal payload traffic will cause
  confusion." Resolved design: every node that registers for its own address
  already receives every packet addressed to it, including an unsolicited
  `0xDA` broadcast if one occurs — so no new "request" command is needed, just
  passive decoding. Add `0xDA` handling to every existing node, emitting
  **only on the secondary output** (never mixed into the main status payload
  on output 1), and **only when at least one counter is non-zero** — silent
  during normal operation, so it never appears unless there's genuinely
  something to see. Nodes that currently only have a single output would need
  a second one added. **Scoped as its own follow-up given it touches most or
  all existing nodes — not part of today's build.**

---

## 4. Deferred — logged as a stretch goal, not being built now

- **OLED image writing** (pushing a custom B&W 1-bit bitmap to an OLED glass
  panel) — genuine use case raised (swapping in a different-language greeting
  for a visitor without opening VelbusLink). **Confirmed: no solid reason to
  build it now** — parked in `HANDOVER.md` as an explicit stretch goal rather
  than an open question.

**Resolved — calibration data:** no concrete current need. Stays out of
scope alongside generic memory read/write, parked for if/when a real need
comes up rather than built speculatively.

---

## 5. Confirmed out of scope — no action

- **Generic memory read/write** — the foundation Program Step would sit on;
  out of scope as a consequence of Program Step being out of scope.
- **Program Step read/write** — explicitly parked pending VelbusLink's own
  Delphi rewrite; a strong candidate to become its own separate project
  rather than living in this palette at all.
- **Cross-module "linked" LED control** — out of scope.
- **IR learn-and-replay, reframed correctly:** this was mischaracterized in
  the original list — it isn't third-party IR code learning at all. The
  glass-panel IR variants simply respond to Velbus-defined HEX codes and
  present them as button events (up to 32), with codes 33-39 specifically
  translated into heating temperature mode changes that `velbus-thermostat`
  would see. Genuinely out of scope as a project, but worth remembering this
  detail if the IR-capable glass panel variants (`VMBGPOD_IR` etc.) ever get
  addressed — the 33-39 range needs the same special handling as any other
  thermostat mode change, not treatment as plain numbered buttons.
- **DALI bridging** — out of scope, name-only per section 2.
- **Signum integration** — out of scope, name-only per section 2.

---

## 6. VMB4AN — groups 2/3 parked, large commitment

**Status: parked 09/07/2026, not scoped for near-term work.** `velbus-sensor`
currently only implements Group 1 of VMB4AN's three functional groups (alarm
outputs, channels 1-8, via the standard `0x00` button-style event — the same
path VMB7IN uses). The `isVMB4AN` flag already in the code is a placeholder
that's never actually consumed anywhere.

- **Group 2 — sensor inputs (channels 9-12).** Each channel supports 4
  configurable operating modes (voltage 0-10V / current 4-20mA / resistance
  PT100-1000 / period measurement), 4 presets (safe/night/day/comfort — same
  naming as thermostat presets), a sleep timer, and configurable auto-send
  behaviour (fixed interval, or threshold-based at 3.125%/6.25%/12.5%/25%
  change). Reading a value and reading full settings are two separate
  packets (`0xEA` status, `0xE8`+`0xE9` two-part settings, confirmed from
  `protocol_vmb4an.pdf`).
- **Group 3 — analog outputs (channels 13-16).** Effectively a full dimmer
  control surface bolted onto VMB4AN — same command bytes as `velbus-dimmer`
  itself (`0x07` set value, `0x11` restore last value), percentage or 12-bit
  precision, timer/forced-on/inhibit, even reusing `0xB8` for its status
  (same byte as `VMBDMI`'s dimmer status — no real conflict, different
  module addresses, just worth knowing Velbus reuses this byte across
  contexts). **Deprioritized further:** not yet configurable natively in
  VelbusLink, so unlikely to appear in any real installation regardless of
  whether this palette supports it — low priority until that changes.
- **Comparable in size to `velbus-energy`** — a genuine second build, not a
  quick addition. Revisit if/when there's a concrete need.

---

## 7. Final scope — everything below is confirmed and ready to build

**New registry entries** (sections 1 and 2 above) — 13 types added to
existing nodes' registries, 5 types added as scan-visible "not supported"
entries, no new nodes required for any of it.

**Feature additions to existing nodes:**
- `velbus-clock`: sunrise/sunset enable/disable (`0xAE`)
- `velbus-button`: lock/unlock (`0x12`/`0x13`), richer `0xED` status decode,
  channel names surfaced in event output

**Explicitly deferred to a later session, design already settled:**
- Bus error counter (`0xDA`) — touches most/all existing nodes, scoped above

**Confirmed out of scope, no action ever:**
- Generic memory read/write, calibration data (no concrete need), Program
  Step read/write, cross-module linked LED control, IR learn-and-replay (as
  a feature — though see the 33-39 thermostat-mode detail above if the
  IR-capable glass panel variants ever get addressed), DALI bridging, Signum
  integration, `VMB1TC`/`VMB1TS` (genuinely not "easy"), `VMBLCDWB`.

**Logged as a stretch goal in `HANDOVER.md`, not built now:**
- OLED image writing

---

## 8. Module emulators — `velbus-emulate-button-io` / `velbus-emulate-dimmer`
(built v0.11.0; Action-assignment engine scoped 14/07/2026, not yet built)

Full technical detail — confirmed real build numbers, exact memory layouts,
confirmed action-byte tables, and the reasoning behind every scope call
below — lives in `HANDOVER.md` section 17. This entry is the summary.

**Shipped (v0.11.0):** both emulator nodes exist and work as plain
initiator/subject devices — button events, output on/off, dimmer level
set/status, identification, module status. **Known defect, fix parked for
the next build phase:** both currently use placeholder build numbers
(`26`/`1`); real, VelbusLink-whitelisted values are now confirmed
(`VMB4PB`=`2531`, `VMB4DC`=`2446`) and need swapping in — a real
compatibility risk against genuine VelbusLink until fixed, not cosmetic.

**Action-assignment engine (the "respond to a real VelbusLink-programmed
link" capability) — scoped, not yet built:**
- Corrected a genuine terminology mix-up from earlier discussion: "Program
  Steps out of scope" was meant to exclude Summer/Winter/Holiday *program
  groups* and full time/date scheduling — not the basic link/action
  mechanism itself, which is now confirmed in scope.
- `VMB4PB` (open-collector outputs as subject): all 9 real actions
  (General + Forced-off family) byte-confirmed via real VLP files.
- `VMB4DC` (dimmer channels as subject): ~15 actions scoped (General,
  `0202`/`0214`, both-direction Forced, Inhibit, the dimmer-specific
  `0408`-family timer) — only 3 byte-confirmed so far (`0103`, `0202`,
  `0214`); the rest need the same VLP-based confirmation process before
  building.
- Confirmed architecturally: action-code bytes are a **separate internal
  enum per module type**, not a shared Velbus-wide code space — `0103`
  Toggle is `0x31` on `VMB4PB` but `0x0B` on `VMB4DC`. The engine needs a
  distinct lookup table per subject module type.
- Explicitly out of scope, real actions deliberately excluded: remaining
  Dimming variants (`0201`,`0203`-`0208`,`0213`,`0215`), Slow-on/off
  (`0301`-`0304`), Disable-timer (`1201`-`1209`), program groups, full
  time/date scheduling.

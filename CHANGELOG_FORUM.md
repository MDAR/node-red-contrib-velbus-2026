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

## Field-confirmed — 09/07/2026

**v0.9.3 confirmed working against real hardware** (Stuart, his own home
installation). Both real VMBGPOD panels present on the bus (addresses 0x05
and 0x18/0x2C) now report correctly — `"module":"VMBGPOD"`, correct
suggested node, correct channel count — where a rescan previously showed
`unknown_0x28` twice. The only remaining unknown in the same scan is
`unknown_0x42` (VMBKP, address 0xFD on Stuart's bus) — expected and correct,
since that module genuinely has no node built yet. This closes out the
VMBGPOD saga (v0.9.2 → v0.9.3) with an actual confirmed result, not just
passing tests — worth the distinction given how much back-and-forth two
separate duplicate-table bugs took to fully resolve.

---

## v0.12.6 — 15/07/2026

### Fixed: forced-off state was never broadcast, so VelbusLink never showed it

- **Reported by Stuart**: forced outputs work correctly (confirmed working
  in harmony with plain toggles, v0.12.4), but VelbusLink's own display
  never showed the forced indication.
- **Root cause, confirmed from the protocol document rather than guessed**:
  `DATABYTE4`'s upper nibble in the `0xED` module status broadcast is
  documented as open-collector "locked/unlocked" — and the protocol
  document's own section headers for `COMMAND_FORCED_OFF`/
  `COMMAND_CANCEL_FORCED_OFF` are literally titled "Lock channel"/"Unlock
  channel". On this module, "locked" and "forced off" are the same status
  bit. The code hardcoded this nibble to always-unlocked regardless of
  actual forced state — output on/off was broadcast correctly, but nothing
  ever told VelbusLink a channel was forced.
- **Fixed**: `DATABYTE4` bits 4-7 now reflect `_forcedOff[]` per channel,
  matching the documented bit-per-channel layout exactly.
- **Left deliberately unset, flagged rather than guessed**: `DATABYTE5`
  is separately documented as "locked channel status" with no further
  per-channel bit breakdown given anywhere in the protocol document. Could
  be redundant with `DATABYTE4`'s nibble, could cover a different channel
  range — genuinely unclear from the documentation alone. Left at `0x00`
  rather than risk another mapping error the way the Forced-off action
  bytes were wrong before real VLP testing caught it.
- Verified via the mock-RED harness: forcing channel 9 sets bit4, also
  forcing channel 11 sets bit6 while bit4 remains set, and cancelling
  channel 9 clears bit4 while bit6 stays — checked against the actual
  packet bytes, not just that the forced-state logic itself runs
  (which was already correct; only the broadcast was missing).

---

## v0.12.5 — 15/07/2026

### `velbus-emulate-button-io` can now accept direct output commands from Node-RED

- **Requested by Stuart**, for parity with `velbus-emulate-dimmer`'s
  existing `{ channel, percent }` input — this module's outputs (9-12)
  previously had no Node-RED-side control at all, only the button-
  simulation input (channels 1-4).
- **Command set deliberately matches only what this module can genuinely
  be commanded to do in practice** — confirmed from VelbusLink's own
  filtered action list (`HANDOVER.md` 17.5), not the full real-relay
  action set: `on`/`off`/`toggle` plus the Forced-*off* family
  (`force_off`/`force_toggle`/`force_cancel`). **Deliberately no
  `force_on`** — this module has no Forced-on action at all, confirmed
  from real VelbusLink testing, so adding one would be pure invention with
  no wire-level equivalent. Considered and explicitly declined.
- **Reuses the existing `setOutput()`/`_forcedOff`/`broadcastOutputChange`
  machinery directly** rather than a parallel implementation — a
  Node-RED-driven `force_off` behaves identically to the same action
  arriving over the real bus, including genuinely blocking a subsequent
  `on` (from Node-RED *or* the bus) until specifically cancelled.
- Verified via the mock-RED harness: all 6 commands produce the expected
  state change; a Node-RED `force_off` followed by a *real bus* `0x02` (on)
  command confirms the bus command is correctly ignored — cross-checking
  that both control paths share the same guarded state, not two separate,
  potentially inconsistent implementations. Existing button-simulation
  input (channels 1-4) confirmed unaffected.

---

## v0.12.4 — 15/07/2026

### Fixed: Forced-off action byte mapping was wrong, not the logic

- **Reported by Stuart against real VelbusLink**, and resolved with a real
  VLP file (5 real `VMBELO` buttons, one Forced action each, individually
  confirmed in order) rather than guessed at — the earlier mapping
  (`HANDOVER.md` 17.5) had been confirmed only by sequential-byte-pattern
  plus assumed display order, explicitly flagged there as "high
  confidence, not certainty." That guess was wrong.
- **Corrected mapping** (each logic block itself was already correct
  against the guide's real definitions — this was purely a case-to-byte
  reassignment):

  | Byte | Real action | Previously mislabeled as |
  |---|---|---|
  | `0x01` | `0807` Forced off while closed | `0806` |
  | `0x02` | `0808` Forced off while open | `0807` |
  | `0x03` | `0806` Forced off | `0808` |
  | `0x04` | `0810` Toggle forced off | `0809` |
  | `0x05` | `0809` Cancel forced off | `0810` |

  This exactly explains what Stuart observed: `0806` (which should hold a
  sticky forced state until cancelled) behaved like the momentary `0807`;
  `0809` (plain cancel) appeared to toggle, because the byte VelbusLink
  actually writes for `0809` was running `0810`'s toggle logic.
- Verified via the mock-RED harness replaying the exact confirmed VLP
  setup (5 buttons, 5 actions, matching addresses and channels) and
  checking each against the guide's real semantics individually: `0806`
  stays forced after release and blocks a direct on-command; `0807`
  releases automatically on release; `0808` behaves as the reverse
  (forces on release, releases on press); `0809` unconditionally cancels;
  `0810` correctly toggles the forced state on repeated presses.

---

## v0.12.3 — 15/07/2026

### Fixed a real bug: relay actions fired on every event type, not just press

- **Reported by Stuart against real VelbusLink, confirmed against the raw
  log rather than assumed**: a single button gesture (press → release, or
  a separate long-press) caused Toggle to fire multiple times — once per
  event type reaching the emulator, when it should fire once, on the press
  edge only. Traced precisely in the log: `SEND 0x00 [pressed]` → emulator
  toggles on; `SEND 0x00 [released]` → toggles off again; a later
  `SEND 0x00 [long]` → toggles a third time.
- **Root cause**: `On`/`Off`/`Toggle` and the unconditional Forced actions
  (`0806`/`0809`/`0810`) had no event-type filter at all in `executeAction`
  — they fired on any matching event (press, release, *or* long) from a
  single physical gesture. `Momentary-follow` and the closed/open Forced
  variants (`0807`/`0808`) already correctly filtered by event type; this
  was a gap specific to the simpler actions, not a general design flaw.
- **Fixed**: all of `On`/`Off`/`Toggle`/`0806`/`0809`/`0810` now require
  `eventBits.pressed` specifically — matching the guide's own wording
  ("each time the initiator closes or is pressed"), consistent with how
  the other actions already worked.
- **Dimmer confirmed correct, no fix needed** — the initial report of "no
  dimming reaction" turned out to be a test-methodology gap, not a code
  bug: the original test log showed press immediately followed by release
  (35ms apart), with no `long` event ever actually sent. A follow-up log
  with genuine held long-presses confirmed the ramp, direction
  alternation, and release-stops-the-ramp behaviour all work correctly as
  designed — traced directly against real dimvalue sequences in the log
  (e.g. a clean 100→31 ramp down, then a clean 31→79 ramp up on the next
  long-press, confirming direction alternation).
- Verified via the mock-RED harness replaying the exact real gesture
  sequence from the log (press, long, release) and confirming exactly one
  status broadcast for the whole gesture, not three.

---

## v0.12.2 — 14/07/2026

### Configurable per-channel long-press dim speed

- **Requested by Stuart**: real VMB4DC hardware only offers a fixed 4 or 8
  second full-range dim speed — genuinely configurable per channel now
  instead, not limited to either of those two values.
- Added 4 new config fields (`dimSpeedCh1`-`dimSpeedCh4`, seconds for a
  complete 0-100% ramp, default 4s each). The ramp's tick interval stays
  fixed (200ms) — only the step size per tick varies by channel, computed
  from the configured speed, so any duration works cleanly rather than
  being limited to values the fixed tick size divides evenly.
- Applies specifically to the continuous ramp triggered by a long-press
  gesture on a linked `0202` action — direct level-set commands (`0x07`)
  are unaffected, still jumping straight to the target level as before.
- **Corrected stale help text found while documenting this**: the dimmer's
  own help page still said Program Steps were "entirely out of scope" and
  that the emulator "jumps straight to a commanded level rather than
  ramping" — both were true when originally written but became wrong once
  the Action-assignment engine and genuine long-press ramping were built
  (v0.12.0/v0.12.1). Corrected to describe what's actually implemented now.
- Verified via the mock-RED harness: a 4-second-configured channel and an
  8-second-configured channel, both started from the same level and
  long-pressed simultaneously, confirmed to ramp at proportionally
  different rates (roughly 2:1, matching the configured speed ratio) after
  a single tick — checked against raw packet contents, not just that the
  code runs.

---

## v0.12.1 — 14/07/2026

### Both v0.12.0 simplifications replaced with genuine behaviour

- **Reported by Stuart, correctly rejected outright**: flattening
  Forced-off to plain Off "is absolutely not the way forward... what is
  the point otherwise?" — and the long-press dimming step approximation
  wasn't needed at all; the real gesture logic is straightforward.
- **`velbus-emulate-button-io`: genuine persistent forced-off state.**
  Added `_forcedOff[]`, one per output, and routed every code path that
  changes an output — the Action-assignment engine *and* direct `0x01`/
  `0x02` commands — through a single guarded `setOutput()` so nothing can
  bypass a forced channel by accident. All 5 Forced actions now do what
  they actually mean: `0806` forces off unconditionally, `0807`/`0808`
  force off for as long as the initiator stays closed/open respectively
  (released when it changes), `0809` cancels unconditionally, `0810`
  toggles the forced state itself. Verified: a channel turned on directly,
  then forced off, then a direct "turn on" command correctly has no effect
  while forced — only cancelling releases it.
- **`velbus-emulate-dimmer`: genuine continuous long-press ramping.**
  Implemented exactly as specified: a press does nothing yet; a release
  with no long-press in that gesture triggers Toggle; a long-press starts
  a real `setInterval`-driven ramp (5%/200ms) that stops at full on/off or
  the moment release arrives, whichever comes first. Direction alternates
  each new long-press gesture (matching typical real Velbus dimmer-button
  behaviour, so repeated holds don't get stuck dimming one way) — flagged
  as an interpretation of "opposite direction" worth confirming, since it
  could instead have meant relative to the current level. Ramp intervals
  are cleaned up on node close, alongside the existing persist interval.
- Verified via the mock-RED harness with a properly persistent (not
  construction-only) `setInterval` mock — an earlier version of this same
  test suite had a harness bug that silently prevented the ramp's own
  timer from ever firing, caught and fixed before relying on the results.
  Confirmed: short press+release toggles, long-press ramps a measurable
  amount per tick, release mid-ramp stops it without toggling, a second
  long-press reverses direction, and a ramp reaching a boundary stops
  itself automatically.

---

## v0.12.0 — 14/07/2026

### Action-assignment engine — both emulators now react to real bus events

- **The actual missing piece**: after v0.11.5 confirmed VelbusLink could
  read and write memory correctly, testing showed the emulators still
  didn't *react* to bus events per the links VelbusLink writes into that
  memory. Pointed at a working prior virtual-module implementation
  (`velbus_vmb4ryld_flow.json`, a separate earlier Node-RED-based Velbus
  emulator project) as reference — the full mechanism (bus-wide listening,
  action-table parsing, match-and-execute) already existed there and was
  adapted here, not re-invented from scratch.
- **Bridge registration changed from address-specific to `'all'`** — both
  emulators previously only ever saw packets addressed to themselves,
  which structurally prevented ever seeing another module's button event.
  The bridge already supported an `'all'`-address listener mode; own-
  address commands and bus-wide initiator watching are now two separate
  branches in the packet handler, avoiding double-processing of the
  node's own traffic.
- **`velbus-emulate-button-io` (`VMB4PB`)**: parses its confirmed Linked
  Push Button table (`0x0128`-`0x0253`, one shared table, subject channel
  stored as a parameter byte) and executes all 9 confirmed real actions —
  General (On/Off/Toggle/Momentary-follow) and the Forced-off family.
  Forced-off is a documented simplification: treated as plain Off, since
  this emulator doesn't track a persistent forced-state override that
  blocks subsequent commands — flagged clearly as a place to revisit if
  genuine forced-state fidelity is ever needed, not a silent gap.
- **`velbus-emulate-dimmer` (`VMB4DC`)**: parses its confirmed per-channel
  memory blocks (subject channel implicit in which 256-byte block an entry
  lives in, 6-byte entries) and executes the 3 currently byte-confirmed
  actions — Toggle, `0202` (Dim at long press/toggle at short press — long
  press is a documented simplification, a fixed 20% step per event rather
  than continuous dimming, since this emulator's button input is discrete
  events, not a continuously-held state), and `0214` Atmospheric dimvalue
  (confirmed reading its stored percentage from the correct parameter
  byte). The remaining scoped-but-not-yet-byte-confirmed actions (Forced
  both directions, Inhibit, the `0408` timer family) are recognised as
  gaps, not silently guessed at — unrecognised action bytes are ignored
  rather than assumed.
- Corrected stale top-of-file scope comments in both emulators, left over
  from before the "Program Steps out of scope" terminology was corrected
  in `HANDOVER.md` section 17.3 — they still said the opposite of what's
  now actually implemented.
- Verified via the mock-RED harness end-to-end: a real VelbusLink-style
  write sequence (`0xCA`/`0xFC` writing a link entry into memory) followed
  by a genuine bus-wide button event from an unrelated module address,
  confirmed to correctly toggle the right output/dimmer channel, confirmed
  a second press toggles back, and confirmed an event from a non-matching
  address is correctly ignored — for both emulators, checked against raw
  packet contents throughout, not just that the code runs.

---

## v0.11.5 — 14/07/2026

### Fixed: VelbusLink stalling when writing memory back to either emulator

- **Reported by Stuart**: read confirmed working (v0.11.3's dump fix), but
  writing changes back stalled. Diagnosed against a working prior virtual-
  module implementation (`velbus_vmb4ryld_flow.json`, a separate earlier
  project) rather than guessing — that reference confirmed exactly what
  was missing: **every single-byte write (`0xFC`) requires a `0xFE`
  (`COMMAND_MEMORY_DATA`) acknowledgment in response, the same way `0xCA`
  block writes are already correctly echoed back via `0xCC`.** Neither
  emulator sent anything back after a `0xFC` write at all — the first byte
  would write fine, then VelbusLink's write sequence would wait
  indefinitely for a confirmation that never arrived, exactly matching
  "stalling."
- **Also found missing entirely while fixing this**: `0xFD`
  (`COMMAND_READ_DATA_FROM_MEMORY`, single-byte read) — confirmed present
  in `VMB4PB`'s own protocol document, never implemented. Added alongside
  the `0xFC` fix, using the same `0xFE` response.
- Both fixes applied identically to `velbus-emulate-dimmer.js`, since
  `VMB4DC`'s memory commands are confirmed identical to `VMB4PB`'s.
- **Testing note worth recording**: a test script hung during this session
  with no error — turned out to be the `setInterval` added for persistence
  (v0.11.4) keeping Node's event loop alive indefinitely, not a real bug.
  Any future test harness for these emulators needs either an explicit
  `process.exit()` or a bash-level `timeout` wrapper; a plain hang doesn't
  necessarily mean broken product code.
- Verified via the mock-RED harness: confirmed a single `0xFC` write now
  produces exactly one `0xFE` acknowledgment, confirmed a sequence of 7
  writes (simulating VelbusLink writing a channel name byte-by-byte)
  produces exactly 7 acknowledgments, and confirmed the new `0xFD` handler
  correctly reads back a previously-written byte — for both emulators,
  with hand-checked checksums.

---

## v0.11.4 — 14/07/2026

### Both emulators now persist memory across Node-RED restarts — with two real corrections along the way

- **Prompted by a direct question**: does the v0.11.3 memory image survive a
  Node-RED restart? Honest answer at the time: no — plain in-memory state,
  wiped on every restart or redeploy.
- **First design, corrected before it shipped**: initially persisted output/
  dim-level state too, reasoning "real modules hold state across a power
  cycle." **Wrong, corrected by Stuart**: real modules "start safe" — outputs
  off at boot, full stop. The one real exception is newer firmware
  persisting a *Forced Off* safety state specifically, which doesn't apply
  here since forced/inhibit states aren't modelled in this emulator at all.
  Outputs and dim levels never persist; only the memory image does, since
  that's genuinely EEPROM-backed on real hardware (channel names, link
  configuration) while output/level state isn't.
- **Second correction**: initially called `context.set()` synchronously on
  every single memory write, reasoning the configured `localfilesystem`
  context store batches its own disk writes anyway. **Flagged as worth not
  assuming** — a full VelbusLink config sync could mean 256+ writes in a
  row, and controlling actual write frequency explicitly is safer than
  relying on unverified internal batching behaviour. Redesigned as a dirty
  flag plus a 30-second interval (matching the context store's own
  documented flush cadence) — the interval only calls `context.set()` if
  something actually changed since the last one, and a final flush happens
  on node close so a clean redeploy doesn't lose the last few seconds of
  writes.
- Uses `node.context()` (node-scoped, not flow/global) — this state
  belongs to one emulator instance, not shared across others. Falls back
  silently to Node-RED's default in-memory context if no persistent store
  is configured in `settings.js` — not a regression, just no improvement
  without one.
- Verified via the mock-RED harness with a captured `setInterval` callback
  (fired manually rather than waiting 30 real seconds): confirmed no
  `context.set()` call happens immediately after a write, confirmed it does
  happen once the interval fires, and confirmed a simulated restart (fresh
  node instance sharing the same mock context store) correctly restores
  memory while correctly resetting outputs/levels to safe — not just that
  the code runs, but the actual timing and reset behaviour checked directly.

---

## v0.11.3 — 14/07/2026

### Fixed: both emulators didn't respond to VelbusLink's memory dump at all

- **Reported by Stuart**: "VelbusLink is sending a Memory Dump request
  `0xCB` to the Emulated Node and it just isn't responding." Confirmed
  directly against the protocol documents: neither emulator had *any*
  internal memory representation at all — only `velbus-emulate-button-io`
  tracked its 4 output states, `velbus-emulate-dimmer` its 4 channel
  levels. VelbusLink performs a memory dump as part of its normal
  module-sync process, not only when a user explicitly requests one — with
  nothing to answer from, the request simply went unanswered.
- **Added a real, persistent 1024-byte memory image** (`0x0000`-`0x03FF`,
  confirmed range from both protocol documents) to both emulators,
  initialised to `0xFF` throughout — matching what every real VLP file
  examined shows for unconfigured memory, not `0x00`.
- **Implemented the full memory command set, confirmed identical across
  both modules**: `0xCB` (dump — answered as a burst of 256 `0xCC` 4-byte
  blocks covering the entire range, since the request itself carries no
  address parameter), `0xC9` (read one block on request), `0xFC` (write
  one byte), `0xCA` (write one 4-byte block, echoed back as a confirmation
  block — confirmed from the protocol document's own remark that real
  modules do this before accepting a next command).
- **This directly supports the already-scoped Action-assignment engine
  work too, not a separate concern**: VelbusLink writes Linked Push Button
  entries into this exact memory range (`0x0128`-`0x0253` for `VMB4PB`,
  confirmed in `HANDOVER.md` section 17.5) when a link is configured. A
  real, writable memory image was a shared prerequisite for both this bug
  fix and that future work, not two unrelated pieces.
- Verified via the mock-RED harness: a full 256-block dump, write-then-read
  consistency for both single-byte and block writes, and confirmed a full
  dump correctly reflects prior writes rather than showing stale/default
  data — checked directly against raw packet contents throughout.

---

## v0.11.2 — 14/07/2026

### Fixed a real bug in both emulators: wrong firmware build bytes transmitted

- **Reported by Stuart via direct testing against real VelbusLink.** The
  v0.11.1 documentation (and the code it described) got the build-number
  decode wrong: it treated the human-readable build string's two halves
  ("25"/"31" for `VMB4PB`, "24"/"46" for `VMB4DC`) as **decimal** numbers
  needing conversion to hex bytes. They aren't — those digits **are** the
  raw hex byte values directly. Entering decimal 25/31 into the node's
  config produced wire bytes `0x19`/`0x1F` — a build VelbusLink doesn't
  recognise at all and won't permit building actions against. Entering
  `0x25`/`0x31` directly, confirmed by Stuart, produces the correct,
  recognised build.
- **Fixed by hardcoding the confirmed-correct real bytes** rather than
  re-exposing this as an editable field: `velbus-emulate-button-io.js` now
  always sends `BuildYear=0x25, BuildWeek=0x31` (`VMB4PB`);
  `velbus-emulate-dimmer.js` now always sends `BuildYear=0x24,
  BuildWeek=0x46` (`VMB4DC`). The editable "Build year"/"Build week" config
  fields are removed entirely — there's no way to expose this as a
  year/week pair without reintroducing the exact decimal/hex confusion
  that caused the bug. Each node's editor now shows a fixed, non-editable
  "Firmware build: 2531"/"2446" line instead.
- **`HANDOVER.md` section 17.5/17.6 corrected to match** — the original
  v0.11.1 write-up stated the wrong decode as if it were confirmed fact;
  now corrected with the actual finding and how it was caught.
- Verified via the mock-RED harness: both emulators' `0xFF` identification
  response now transmits the exact confirmed-correct bytes (`0x25`/`0x31`
  and `0x24`/`0x46`), checked directly against the raw packet contents, not
  just the code that produces them.

---

## v0.11.1 — 14/07/2026

### Documentation only — Action-assignment engine ground truth captured

No code changes. A substantial, hard-won scoping conversation confirmed
real, concrete technical facts about `VMB4PB`/`VMB4DC` that didn't exist in
durable form anywhere — captured properly in `HANDOVER.md` section 17 and
`coverage-roadmap.md` section 8 before being lost to conversation
compaction, rather than left on recall alone.

- **Corrected a genuine terminology mix-up**: "Program Steps out of scope"
  (stated when the two emulators were first built) actually meant to
  exclude Summer/Winter/Holiday "program groups" and full time/date
  scheduling — not the basic link/action mechanism itself. The basic
  mechanism (VelbusLink writing "button X does action Y to channel Z" onto
  a subject module's memory) is now confirmed in scope for a future
  Action-assignment engine.
- **Real build numbers confirmed from genuine VelbusLink project files**:
  `VMB4PB`=`2531` (`BuildYear=0x19/25, BuildWeek=0x1F/31`), `VMB4DC`=`2446`
  (`BuildYear=0x18/24, BuildWeek=0x2E/46`) — both currently-shipped
  emulators use placeholder `26`/`1` values instead. A prior session
  confirmed VelbusLink validates build numbers against a whitelist of real
  firmware and rejects unrecognised ones — this is a real compatibility
  defect against genuine VelbusLink, not cosmetic, flagged for the next
  build phase.
- **`VMB4PB`'s Linked Push Button memory table fully decoded** from a real
  VLP file: location (`0x0128`-`0x0253`), 5-byte entry format, and all 9
  real action byte values it actually offers — confirmed directly from
  VelbusLink's own filtered action-list UI, which turns out to disagree
  with the public actions guide (the guide doesn't list `VMB4PB` as an
  applicable subject for any action at all, despite real working links
  existing against it — confirmed out of date for this module).
- **`VMB4DC`'s completely different memory architecture decoded**: a
  dedicated 256-byte block per channel rather than one shared table, with
  a 6-byte entry format (one more parameter byte than `VMB4PB`'s 5,
  matching dimmer actions needing more configuration). 3 of ~15 in-scope
  action bytes confirmed so far.
- **Confirmed architecturally significant finding**: action-code bytes are
  a separate internal enum per module type, not one shared Velbus-wide
  code space — Toggle (`0103`) is `0x31` on `VMB4PB` but `0x0B` on
  `VMB4DC`. The eventual engine needs a distinct lookup table per subject
  module type, not one shared table with type-based filtering.
- Full final in-scope/out-of-scope action lists recorded for both modules,
  and the "seen but deliberately excluded" set logged explicitly.

None of this changes shipped behaviour — it's the confirmed ground truth
the next actual build phase (build-number fix + Action-assignment engine)
will work from, written down before it could be lost to summarization.

---

## v0.11.0 — 14/07/2026

### Module emulators — first two nodes, new "Velbus (emulate)" category

- **New category, same package** — following discussion, these live inside
  `node-red-contrib-velbus-2026` under a new "Velbus (emulate)" node-picker
  category rather than a separate npm package. With only two nodes, a
  whole separate repo/npm identity wasn't worth the overhead; revisit if
  the emulator surface grows significantly (see the `VMB8IN-20` idea below).
- **These are module *emulators*, not controller nodes — the opposite role
  to every other node in this palette.** Where `velbus-relay`/`velbus-dimmer`
  etc. receive real modules' status and send them commands, these nodes
  *receive* commands and *transmit* status/identification, so VelbusLink (or
  any real linked module) can scan, see, and drive them exactly as it would
  real hardware — without needing physical devices for training or testing.
- **`velbus-emulate-button-io`** emulates a `VMB4PB` in "I/O module" mode —
  4 button inputs (channels 1-4) plus 4 open-collector outputs (channels
  9-12), confirmed from the actual protocol document to be genuinely
  simultaneous, not mode-gated at the wire level. VelbusLink's own
  "pushbutton interface" vs "I/O module" setting, confirmed from its UI, is
  a labelling/navigation distinction only — this node always answers both
  kinds of traffic regardless.
- **`velbus-emulate-dimmer`** emulates a `VMB4DC` — chosen over `VMBDMI`
  (extra thermal bits this tool has no use for) and `VMB1LED` (a combined
  button+dimmer role that stops being an advantage once
  `velbus-emulate-button-io` already covers the initiator side generically
  for any target). Reuses the `0xB8` status format already implemented and
  debugged in `velbus-dimmer.js` (see `HANDOVER.md` section 7.5a).
- **Program Steps are entirely out of scope for both, by explicit design
  decision, not an oversight.** Real Velbus link behaviours like "toggle"
  or "dim on long press" aren't wire commands — they're memory-based Action
  configuration a real module's own firmware executes against raw
  initiator events. Neither emulator ever needs to store or execute one:
  as an initiator, the real richness belongs on whatever it's linked to;
  as a subject, plain on/off is genuinely all that's needed to confirm a
  link fired, never a stand-in for real relay/dimmer richness (timer,
  forced-on/off, inhibit, fade animation). Building genuine Program Step
  storage/execution would be close to reimplementing real module firmware
  — a large, separate undertaking, out of proportion to what this tool is
  for.
- **Help documentation written to explicitly justify the two-module scope**,
  per request — not just "how to use this," but why these two, and why
  nothing richer, so the reasoning survives independently of this
  conversation.
- **Noted for later, not now:** a `VMB8IN-20` emulator becomes genuinely
  useful once real hardware firmware supports injecting sensor data onto
  the bus for OLED displays to consume — flagged as a real future
  candidate, not scoped or built.

Verified via the mock-RED harness: RTR → identification (confirmed 8 bytes
for `VMB4PB` including a terminator, 7 bytes for `VMB4DC` with none — not
assumed to share a shape just because both are original-series), module
status request answered correctly, output/level commands update internal
state and broadcast status correctly, all-channels bitmask commands fan out
to every affected channel, address isolation confirmed (wrong-address
traffic produces no response), every checksum hand-verified. Not yet
tested against a real VelbusLink scan/link.

---

## v0.10.5 — 09/07/2026

### Fixed the "no examples" Flow Library evaluation flag

- **Prompted by the Node-RED Flow Library evaluator flagging this package as
  having no examples**, despite `examples/velbus-basic-relay-dimmer.json`
  genuinely existing with real flow content. Checked the official docs
  rather than guess at the cause: example flows must **"not use any other
  3rd party nodes that need to be installed."** The existing example used
  seven Dashboard 2 node types (`ui-base`, `ui-group`, `ui-page`,
  `ui-slider`, `ui-switch`, `ui-text`, `ui-theme`) — a genuine third-party
  dependency this package doesn't include, which almost certainly explains
  why the evaluator didn't count it as valid.
- **A second, independent staleness found while rebuilding it:** the old
  example's `velbus-relay`/`velbus-dimmer-20` nodes used field names
  `address`/`channel` — checked the actual current node definitions
  directly, which use `moduleAddr`/`startChannel`/`channelCount`. The
  `velbus-bridge` node used `"tls"` where the real field is `"useTLS"`.
  This example would not have worked correctly even before the Dashboard
  issue, on top of not counting toward the evaluator.
- **Replaced with two short, self-contained examples**, per the "should be
  short" guidance in the official docs, using only core Node-RED nodes
  (`inject`/`debug`/`comment`) plus this package's own nodes — no other
  palette required to run either one:
  - `velbus-scan-and-relay.json` — bus scan, then on/off/toggle relay
    control (toggle demonstrates the node's own internal state tracking,
    not a wire command)
  - `velbus-dimmer-levels.json` — preset-percentage dimmer control
- Every field name and command verified directly against the actual current
  node code before writing the flow — not carried over from the old,
  already-stale example. Both files validated: proper JSON, every wire and
  config reference resolves to a real node, only the expected node types
  present.

---

## v0.10.4 — 09/07/2026

### README.md — fixed real staleness, now publicly visible on the Flow Library

- **Prompted by successfully getting listed on the Node-RED Flow Library**
  (`flows.nodered.org/node/node-red-contrib-velbus-2026`) — checked the
  rendered page and found the displayed README was genuinely stale, not a
  caching artifact: `velbus-glass-panel` still said "26 types" (actually 29),
  `velbus-button` still listed only the original 6 types (actually 12, plus
  lock/unlock/status/naming capability added since), `velbus-sensor` didn't
  mention `VMB6IN` or the new generic analogue reading, `velbus-clock`
  didn't mention sunrise/sunset, and the tarball install example still
  hardcoded `v0.8.1`.
- **Root cause:** `README.md` was fixed once, early on, during initial npm
  publish prep — then never touched again despite `HANDOVER.md` and
  `CHANGELOG_FORUM.md` being kept scrupulously current through every
  subsequent change. This is the user-facing document (visible on both npm
  and the Flow Library), arguably more consequential to get right than the
  developer-facing ones, and it drifted the most.
- **Fixed the specific staleness, and the root cause of it recurring:**
  the hardcoded tarball version number is now written as `vX.Y.Z` with an
  explanatory note, rather than a literal version that will go stale again
  next release exactly as it did this time.
- Added pointers to `HANDOVER.md`, `CHANGELOG_FORUM.md`, and
  `coverage-roadmap.md` — none of which were linked from `README.md` at all
  before, despite being genuinely useful to anyone landing on the repo.
- Also confirmed, while investigating: the earlier concern about Node-RED's
  post-2022 scoped-package naming policy did **not** block Flow Library
  approval — this package is listed successfully under its original
  unscoped name.

---

## v0.10.3 — 09/07/2026

### velbus-glass-panel — VMBEL edge colour control (set_edge_color)

- **Prompted by Stuart asking whether edge LED colours on `VMBEL` panels
  could be controlled, or whether a raw-packet escape-hatch node (like the
  original palette had) was needed instead.** Confirmed a real, well-defined
  live-bus command exists — no raw-packet node needed for this case.
- **Scope deliberately split, per explicit decision:** `COMMAND_SET_PB_
  BACKLIGHT` (`0xD4`) covers two different operations distinguished only by
  DLC — "Set Custom Color" (`DLC=6`, *defines* a custom RGB palette slot)
  and "Set Edge Color" (`DLC=4`, *applies* an already-defined colour).
  Only the latter is implemented: defining new custom colours is
  commissioning-time configuration, staying in VelbusLink's domain, same
  reasoning as `VMB4LEDPWM-20`'s grouping mode and Program Step read/write
  elsewhere in this project. See `HANDOVER.md` section 7.8b for the full
  byte layout.
- **`hasEdgeLed` gated to the confirmed `VMBEL` family only** (12 of 29
  glass panel types: `VMBEL1/2/4`, `VMBELO`, `VMBELPIR`, `VMBEL2PIR`, and
  their `-20` siblings) — `VMBGP`-family panels have only a single-colour
  front LED per button, genuinely different hardware, not just a missing
  feature. Verified the command is byte-for-byte identical across every
  `VMBEL` sub-family protocol PDF before implementing once. One vestigial
  "Edge color inhibited" status bit found in `VMBGP1-20/2-20/4-20`'s own
  `0xED` — confirmed as inherited documentation cruft, not evidence of real
  edge-colour hardware on those panels.
- New `set_edge_color` command: `layers` (background/continuous/slow_blink/
  fast_blink, any combination), `edges` (left/top/right/bottom, any
  combination), `page` (1-8 or "all"), `palette` (default/custom), `index`
  (0-31), `priority` (custom only), `blink`. Sending to a non-`VMBEL` panel
  warns clearly and sends nothing, matching the established per-type
  gating pattern used throughout this palette.
- Housekeeping: removed a stale "`VMBKP` has no node at all" entry from
  `HANDOVER.md`'s known-open-issues — that was resolved back in v0.10.0
  when `VMBKP` was folded into `velbus-button`, but the issue list was
  never updated to reflect it.

Verified via the mock-RED harness: default palette, custom palette with
priority and blink flag, all-defaults shorthand, and rejection on a
non-`VMBEL` type — every case with hand-checked checksums and manually
verified bitfield encoding, not just visual review. Not yet sent to a real
bus.

---

## v0.10.2 — 09/07/2026

### velbus-sensor — VMB4AN generic analogue reading (channels 9-12)

- **Prompted by Stuart noticing `isVMB4AN` was defined but never used** —
  confirmed the sensor-input channels (Group 2 of VMB4AN's three functional
  groups) produced literally no output at all beforehand; the packet
  carrying that data wasn't handled anywhere in the file.
- **Real trap found and avoided:** the obviously-named `0xEA`
  ("sensor status") packet does **not** carry a value at all — it's
  operating-mode/sleep-timer/auto-send configuration only. The actual
  reading lives in a separate, easy-to-miss packet earlier in the protocol
  document: `0xA9` (`COMMAND_SENSOR_RAW_DATA`, "Transmit the sensor raw
  value"), genuinely standalone with no need to cross-reference anything
  else. Also confirmed `0xE8`/`0xE9` ("sensor settings") is preset
  *configuration* storage, not a live value either — three different
  packets that could each plausibly have been mistaken for "the reading."
- Deliberately generic, per explicit preference: emits `{ type: "analogue",
  channel, mode, raw }` with no engineering-unit conversion attempted —
  `mode` (voltage/current/resistance/period) and the PDF's resolution
  table are exposed in the node's help so conversion can happen in the flow
  instead.
- New `get_analogue` input command (`0xE5`, request-a-reading-now) — uses
  the protocol's own "auto-send config byte = 0" option to request a value
  without side-effecting the module's existing auto-send schedule.
  **Priority byte corrected during verification:** the protocol PDF
  explicitly states "SID10-SID9 = 11 (lowest priority)" for this specific
  command — `0xFB`, not the `0xF8` most other commands in this file use.
  Checked directly rather than assumed, since this is the one place it
  genuinely differs from the file's established convention.
- Both confirmed absent from `VMB7IN`'s own protocol PDF before wiring
  in — this file's switch statement handles both module types together,
  so a collision would misfire for `VMB7IN` modules if either byte had
  been reused there.
- **Full Group 2 configuration (presets, mode-switching, sleep time,
  offset, auto-send interval config) and all of Group 3 (analog outputs)
  remain parked** — see `coverage-roadmap.md` section 6. This is
  deliberately just the minimal reading piece, not the full feature.

Verified via the mock-RED harness: voltage/period modes, both period
special-value cases (`0x000000` short-circuit, `0xFFFFFF` open-circuit),
`VMB7IN` isolation confirmed (same bytes produce no output on that type),
`get_analogue` checksum hand-verified, correctly rejected on non-VMB4AN
types. Not yet sent to a real bus.

---

## v0.10.1 — 09/07/2026

### Two critical bugs found on real hardware — velbus-dimmer and velbus-glass-panel

**velbus-dimmer — `on`/`state` always wrong for original-series dimmers.**
Reported by Stuart: a VMBDMI at 75% dim showing `state:"off"`, `on:false`.
Root cause was a genuine misunderstanding of the protocol, not a small
off-by-one: `0xB8`'s `DATABYTE3` packs run-mode, error, load-type, and
temperature band **all into one status byte** (confirmed identical across
`protocol_vmbdmi.pdf`, `protocol_vmbdmi_r.pdf`, and `protocol_vmb4dc.pdf`).
The previous code treated this as if it were a separate mode-byte +
status-byte pair (the way relay modules genuinely have), and additionally
read `DATABYTE5` (LED indicator status — real values `0x00`/`0x80`/`0x40`/
`0x20`/`0x10`) as a second status word, checking its low 2 bits for
confirmation. Since none of the real LED status values have those bits
set, a dimmer in ordinary "normal running" mode — the overwhelmingly
common case — always fell through to `'off'`, regardless of actual dim
level. Also fixed in the same pass: the 24-bit current-delay timer was
being read as only 16 bits from the wrong byte offset, and `decodeThermal`
was being called on the LED byte instead of the real status byte (explains
why `thermal` always showed all zeros in the field report). `ledState` is
now correctly decoded and added to the payload. Verified against the exact
reported scenario plus inhibited/forced_on/disabled/thermal-alarm cases,
with the bit-field math for the packed status byte hand-checked.

**velbus-glass-panel — `0xEA` thermostat status has been silently crashing
since it was written.** Reported by Stuart via a `"velbus-bridge dispatch
error: currentTemp is not defined"` message appearing repeatedly while
testing a VMBGP2. Root cause: `currentTemp` and `targetTemp` were only ever
assigned as properties of the `payload` object literal, never declared as
their own variables — but the very next line referenced them as bare
identifiers in the `setStatus(...)` call. Because JS evaluates a function's
arguments before calling it, this threw a `ReferenceError` before
`node.send()` on the following line ever executed. **This means the
`type:"thermostat"` payload has likely never once been successfully
delivered for any thermostat-equipped glass panel** — the bridge's
dispatch-error handling caught the exception each time rather than
crashing the whole process, which is exactly why this went unnoticed for
so long rather than being immediately obvious. Fixed by declaring both as
proper local `const`s before use. Did a full sweep of every other packet
case in this file (button, module status, temperature, light sensor, memo
text, counter, name parts) via the mock harness afterward, specifically
exercising the OLED- and PIR-gated branches too — no other instances
found. Also swept every other node file for the same bare-identifier
`.toFixed()` pattern that caused this — one other match (`velbus-meteo`)
checked and confirmed already correct (properly prefixed with `payload.`).

Both verified via the mock-RED harness against the exact reported symptoms
before and after the fix — not just re-reading the corrected code. Not yet
re-confirmed on Stuart's real hardware.

---

## v0.10.0 — 09/07/2026

### Coverage roadmap implementation — 9 new module types, velbus-button overhaul, velbus-clock sunrise/sunset

Following a full rationalization pass over every unaddressed Velbus module
type and feature (see `coverage-roadmap.md`), this implements everything
confirmed in scope. Every single item below was checked against its actual
protocol document before being added — several real divergences were caught
in the process that would otherwise have shipped silently wrong.

**velbus-button — substantial overhaul, not just new registry entries:**
- 7 new module types: VMB8IR, VMB4PD, VMB4RF, VMBRFR8S, VMBVP01, VMBKP, VMBIN.
- **Lock/unlock (0x12/0x13)** — confirmed present on 8 of the 12 total types
  now covered; **NOT universal**, despite being asked for as "a key Velbus
  feature." VMB8PB, VMB8IR, VMB4PD, and VMBVP01 genuinely lack this command
  in their own protocol documents. Gated per-type (`hasLock`) — sending it to
  an unsupported type now warns clearly on output 2 rather than silently
  doing nothing.
- **Richer 0xED status decode** (locked/enabled/inverted/program-disabled) —
  also NOT universal. VMB8PB's 0xED is a completely different, simpler
  LED-only format; VMB4RF's status uses command byte 0xB4, not 0xED, with a
  different field at DATABYTE4 ("learn transmitter mode"); VMBVP01's 0xED is
  a third, shorter shape again. Gated per-type (`hasRichStatus`) — decoding
  is skipped entirely for types that don't match, rather than risk
  misreading whatever they actually send.
- **Channel names surfaced in event output** (0xF0/F1/F2) — found the
  selector byte convention itself is inconsistent across types: some use a
  bitmask (one bit per channel), others a literal 1-based number. These
  produce the *same* byte value for channels 1-2, diverging only from
  channel 3 onward — exactly the kind of thing that would pass casual
  testing and then silently corrupt every name from channel 3 up. Verified
  explicitly at channel 3 for both conventions before shipping.
- **VMBVP01 (DoorBird)** gets fixed semantic channel labels (Motion 1/2,
  Bell 1/2, Door 1/2, Virtual button 1/2) — hardware-fixed functions, not
  VelbusLink-configurable names, so not sourced from 0xF0-F2 at all.
- Output changed from 1 to 2 (events/status, warnings) — non-breaking for
  existing flows, the new output simply has no wires by default.
- **Real mistake caught before shipping:** first pass had VMB4RF at 8
  channels; its own status packet says "channel 1 to 4," matching its name.
  Corrected to 4 before release, not after.
- **A second, more serious pre-existing bug found and fixed, unrelated to
  today's additions:** `VMB4PB` and `VMB6PB-20` — two of the *original* five
  button types, present since v0.5.2 — were registered under wrong type
  bytes (`0x1C` and `0x20`) in this file's own registry. `0x1C` isn't a real
  Velbus type byte at all; `0x20` actually belongs to `VMBGP4`, an unrelated
  glass panel type. `velbus-scan.js` has always had the correct values
  (`0x44`/`0x4C`) — only this file's internal lookup was wrong, meaning a
  real `VMB4PB` or `VMB6PB-20`, correctly identified by a scan, would never
  have matched this file's own type descriptor at all. Every type-specific
  feature (and now, lock/unlock and rich status too) would have silently
  never activated for these two types. Found by cross-referencing the
  official type list while writing this changelog entry, not by design —
  worth remembering that documentation review can surface real bugs too.

**velbus-sensor:** VMB6IN added. Confirmed simpler than its VMB7IN sibling,
not just a smaller version of it — no lock/unlock command exists for it at
all, and its 0xED module status is 5 bytes vs VMB7IN's 7. The existing
`body.length < 7` guard already skips it safely; no code change needed
beyond the registry entry itself.

**velbus-glass-panel:** VMBGP4PIR-2 (0x3E) and VMBGPTC (0x25) added.
- **Real mistake caught:** VMBGP4PIR-2's channels 5-8 have completely
  different semantics from its 0x2D sibling despite the near-identical name
  (Dark/Light output, Motion output, Light-depending-motion, Absence output
  — not virtual/dark/light/motion). Copying the sibling's mapping would have
  silently mislabeled four channels.
- VMBGPTC confirmed sharing its actual protocol document with VMBGPO
  (0x21) — a thermostat-only variant of the same panel hardware, added to
  the glass-panel registry rather than as thermostat-node-only, so
  `velbus-thermostat` picks up its function automatically the same way it
  already does for every other panel address.

**velbus-clock:** sunrise/sunset enable/disable (0xAE) added, same
global/local address pattern as the existing `set_alarm` — confirmed
identical packet body for both from the protocol PDF.

**velbus-scan:** all of the above added across its three independent tables
(`ALL_TYPES`/`NODE_SUGGESTION`/`MODULE_CHANNELS`) — the exact lesson from
the VMBGPOD saga (v0.9.2/v0.9.3), applied proactively this time rather than
discovered the hard way again. Also adds explicit `"Not supported"` scan
labels (rather than falling through to a bare name with no node) for
VMBDALI, VMBDALI-20, VMBLCDWB, VMCM3, VMBSIG, VMBSIG-20, and VMBSIG-21 —
recognized correctly in a scan, deliberately not built, by design rather
than oversight.

**Explicitly deferred, not built this round:** VMB1DM, VMBDME, and VMB1LED
(the dimmer-family additions) all turned out to use a genuinely different
single-channel `0xEE` status layout — distinct from both `velbus-dimmer`'s
own format and `velbus-dimmer-20`'s multi-channel bitmask format. This needs
real new decode logic, not a registry entry, and doesn't meet the
"minimal effort" bar set for this round. Parked rather than forced in.

**Verification:** every new packet format checked against its actual
protocol document (not inferred from a same-named sibling) before being
implemented; every new command exercised through the mock-RED harness with
hand-checked checksums; the channel-3 naming-convention divergence
specifically tested for both conventions, not just one; a full simulated
scan run across every new and "not supported" type confirmed correct
`suggestedNode`/`channels` output end to end. Not yet sent to a real bus.

---

## v0.9.4 — 09/07/2026

### velbus-button — critical bug, live since v0.5.2: button events shifted by one byte

- **Found while scoping VMBKP's decode logic, not reported directly** — checking
  `velbus-button.js` as a template surfaced that its `0x00` handler read
  `body[0]`/`body[1]`/`body[2]` for pressed/released/long-pressed, when
  `body[0]` is always the command byte itself (always `0x00`, per this
  project's own most-repeated rule — see `HANDOVER.md` section 4.3). Every
  field was reading one byte too early.
- **Real impact, not theoretical:** `pressed` was always empty (reading the
  constant command byte), `released` was actually reporting what DATABYTE2
  (the real "pressed" bitmask) contained, `longPressed` was reporting what
  DATABYTE3 (the real "released" bitmask) contained, and the real
  DATABYTE4 (long-press bitmask) was never read at all. The `on` field
  followed the same corruption — it could report `true` on a release and
  never correctly on an immediate press.
- **Confirmed live since `velbus-button`'s introduction in v0.5.2** — this
  is not a new regression, it has been shipping incorrect button-event data
  for the entire time this node has existed. `velbus-glass-panel`'s own
  `0x00` handler was checked immediately afterward and confirmed **not**
  affected — it already used the correct `body[1]`/`body[2]`/`body[3]`
  indexing, so this was isolated to one file, not systemic.
- **Fixed and verified with a real repro, not just a corrected read of the
  code:** built a mock-harness test that reproduces the exact failure first
  (channel 3 pressed came back reported as "released") before applying the
  fix, then re-ran the same test plus three more (release, long-press,
  simultaneous multi-channel press) to confirm all four now report
  correctly.
- **If you have flows depending on `velbus-button`'s `pressed`/`released`/
  `longPressed` distinction** (rather than just the `on` boolean, or
  scanning/discovery, which were unaffected), check them after updating —
  behaviour that previously "worked" by only watching `on`, or by
  compensating for the shift some other way in the flow itself, may now
  behave differently now that the underlying data is actually correct.

---

## v0.9.3 — 09/07/2026

### velbus-scan — VMBGPOD still showed "unknown_0x28" after the v0.9.2 fix

- **Reported by Stuart:** re-ran a scan against v0.9.2 pulled fresh from npm,
  `VMBGPOD` still showed as `unknown_0x28`.
- **Root cause:** `velbus-scan.js` has its **own, third, independent copy**
  of the type table — `ALL_TYPES`, `NODE_SUGGESTION`, and `MODULE_CHANNELS`
  — entirely separate from `lib/glass-panel-types.js` (used by
  `velbus-glass-panel` at runtime) and the duplicate list inside
  `velbus-glass-panel.html` (used for the editor dropdown), both already
  fixed in v0.9.2. The v0.9.2 fix genuinely worked for the glass-panel node
  itself; the bus scanner simply had no idea `VMBGPOD` existed, since it
  never reads either of the other two files at all.
- **This is now the third type table found in this codebase.** Searched
  exhaustively this time (`grep -rln "VMBGPO'"` across the whole `nodes/`
  and `lib/` tree) rather than assume these three are the only ones — they
  are, confirmed by the search coming back with exactly these three files
  and no others.
- Added `0x28: 'VMBGPOD'` to all three tables in `velbus-scan.js`.
- **Verified end-to-end this time, not just by inspecting the table.** Built
  a full mock-harness test that triggers a real scan, feeds a simulated
  `0xFF` response for `VMBGPOD` (using the exact build/serial from Stuart's
  own scan output), and confirms the emitted `module_found` payload reports
  `"module":"VMBGPOD"`, the correct suggested node, and the correct channel
  count — not just that the table lookup would theoretically work.
- **Worth remembering for any future module type addition:** check all
  three of `lib/<family>-types[-20].js`, the corresponding node's own
  `.html` (editor dropdown), and `velbus-scan.js` (bus-wide discovery).
  Missing any one of the three produces a real, user-visible symptom in a
  different part of the palette than wherever the fix was actually made —
  exactly what happened here.

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


# Mustang Micro Plus on macOS

Read when connecting a Micro Plus over Bluetooth, running its browser controls,
or developing its BLE protocol.

Maneline can read, switch, edit and save Micro Plus presets using Bleak's
CoreBluetooth backend. The browser editor supports amplifier/effect model
selection, parameter changes, preset names, and saving to the current slot or
another slot. The USB cable can remain connected for audio and power.
Signal-chain reordering and a browser backup-import interface are not implemented.

## Setup

Use Python 3.11 or later with Bleak installed. The Python environment created by
`scripts/rebuild_sdk.sh` includes Bleak, or create an isolated environment:

```sh
uv venv _work/mmp-venv
uv pip install --python _work/mmp-venv/bin/python -r scripts/requirements-mmp.txt
```

Turn on the Micro Plus and close Fender Tone on other devices. macOS may ask
the application running Python for Bluetooth permission. If access is denied,
enable it in System Settings > Privacy & Security > Bluetooth before retrying.
macOS holds the app that launched Python responsible: if that app declares no
Bluetooth use, the server prints its address and then crashes with a TCC error in
`~/Library/Logs/DiagnosticReports`. This happened when launching from Claude Code,
so start the server from Terminal or another app with Bluetooth access.

## Browser controls

```sh
bash scripts/run_web_cli.sh --micro-plus
```

Open `http://localhost:8080`. This launch mode serves the Micro Plus page from
`web-app/web_ui`. The page has its own stylesheet, follows the system light or
dark setting, and needs no internet connection. It owns one persistent BLE
connection shared by all browser clients; browser refreshes and preset clicks do
not reconnect the amplifier. The original Java/Lua USB mode is still launched
with `scripts/run_web_cli.sh` without `--micro-plus`.

The preset list marks the active preset. Search by name, or type a number to find
exactly that slot. Empty slots are hidden until you ask for them. The arrows in
the top bar and the `[` and `]` keys step through the listed presets. Selecting a
preset waits for the amp to confirm the change. The display also follows preset
changes received from the device. Switching presets does not rewrite saved preset
settings. On narrow screens the list opens as a drawer from the **Presets** button.

### Editing and saving

Saving was tested only against disposable slot 100 on firmware 1.1.11. Other
destinations use the same write path but were not overwritten during testing.

Choose a preset, then pick a module in the signal chain to open its controls.
Each effect has an on/off switch in the chain, and less common settings are under
**More settings**. Changes are sent to the active sound while you make them.
Controls stay usable during a send: the amp takes about a second per change, so
only the newest value of each control is sent and a slider drag is heard in steps.
A parameter change is acknowledged and its updated preset is read back before the
browser accepts it. The editor queries the device's parameter type before
writing, distinguishing continuous float controls from integer choices.

The top bar counts unsaved changes. Changed controls are marked with a **Reset**
button, and the list under the module shows each change from the saved preset.
That comparison is held by the page for the current connection, so a page opened
after edits were made can show "Unsaved changes" without listing them.

Normalized controls use a 0–10 slider when the stored value is between 0 and 1.
Other numeric controls display the device's native values; many units and ranges
are inferred from preset definitions rather than documented, and the amp rejects
values it does not accept. Numbered choices such as **Delay modulation type**
stay numbered because the amp does not report their names. String menus include
values observed on the device and may not contain every option supported by the
firmware. Amplifier choices currently cover the app's 25 guitar models. An
unsupported value is reported as an error, not success.

**Save** replaces the active preset, and **Save as copy** writes to another slot,
defaulting to the first empty one. Both confirmations name the preset being
replaced. Before writing, the server reads that slot's saved definition and writes
a JSON backup under `_work/preset-backups/`. If the backup cannot be created, no
save is sent. Saving to another slot creates a copy with a new preset ID and
leaves the source's saved contents unchanged. The device's saved response must be
followed by a matching read-back of the destination name and signal chain before
success is reported. Acknowledgement alone is insufficient.

**Undo this save** restores the backup from the most recent save, after backing up
what it replaces. It is available until the server restarts.

**Discard changes** reloads the saved preset. Switching away from an edited preset
also asks before discarding live edits or an unsaved name. Browser requests include
the selected slot and an opaque editor revision, so stale controls cannot quietly
edit a different preset. The revision includes a fresh connection identity,
including after restarting the server.

Backups contain the device ID, destination slot and full preset JSON. Keep them
when moving or cleaning a worktree. They are not committed to Git. Older backups
have no restore button; the controller's `restore_preset` method uses the verified
full-preset write operation.

If the amplifier disconnects, the page keeps showing the last settings it read,
with controls disabled and a notice, until the connection recovers. The server
retries automatically, using the device ID from the first connection. It does not
retry an unconfirmed switch: it reconnects and reads the actual current selection
instead, and the page reports which preset the amp is on.

### Working on the page without an amp

```sh
_work/mmp-venv/bin/python scripts/mmp_mock.py
```

This serves the real page at `http://localhost:8092` through the real request
handling, against a simulated amp with no Bluetooth. Open `/__mock/mode/disconnected`,
`/__mock/mode/fail`, `/__mock/mode/stall` or `/__mock/knob/5` to simulate a lost
connection, unconfirmed writes, the stall described below, or a preset change made
on the amp; `/__mock/mode/ok` returns to normal. Use it for anything that would
otherwise overwrite presets.

Use `--device ID` to select a specific Micro Plus and `--port NUMBER` to change
the HTTP port. If using another Python environment, set `MANELINE_PYTHON` to its
interpreter. The server binds to `0.0.0.0`; localhost and this Mac's hostname and
`.local` hostname are accepted. For another hostname or a numeric LAN address,
add `--allow-host HOSTNAME_OR_IP` (repeatable). Use this on a trusted network;
there is no user login. Browser writes require a matching Origin and Host.

The API is `GET /api/micro-plus` for connection state, selected preset, names and
connection count, and `POST /api/micro-plus` with JSON `{"preset": 72}` to switch.
Preset numbers are 1–100, matching the display. Invalid numbers return HTTP 400;
an unavailable connection or unconfirmed switch returns HTTP 503. A failed
confirmation does not establish that the amplifier stayed on its previous preset.
The editor endpoint is `POST /api/micro-plus/editor` with an `action` of
`parameter`, `model`, `save`, or `undo-save`. Each action includes `preset` and
`revision` from the latest GET response. Parameter changes also supply `node`,
`parameter` and `value`; model changes supply `node` and `model`; saves supply
`target` and `name`. A stale revision returns HTTP 409, invalid data returns 400, an
unconfirmed device operation returns 503, and a backup-file failure returns 500.
Do not retry an unconfirmed save automatically: read the actual state first.

Traffic logs are appended to `_work/mmp-web.jsonl` and can include preset data.
Stop the server before using any other BLE controller, including the commands
below, so only one program holds the connection.

## One-shot command-line controls

```sh
_work/mmp-venv/bin/python scripts/mmp_ble.py scan
_work/mmp-venv/bin/python scripts/mmp_ble.py status
_work/mmp-venv/bin/python scripts/mmp_ble.py presets
_work/mmp-venv/bin/python scripts/mmp_ble.py preset 72
```

These commands connect, perform one operation and disconnect. Put `--device ID`
before the command to select the ID returned by `scan`. On macOS this is a local
CoreBluetooth UUID, not a Bluetooth MAC address. Multiple matching devices require
an explicit selection. `--log _work/mmp-ble.jsonl` records timestamped BLE traffic.

## Persistent connection and verification

The service/characteristic UUIDs, startup sequence and switch command come from
`mmp_helper.py.disabled` and `mmp_startup.gatttool.json`. The wire protocol uses
zero-based preset indices; the controller converts them to display numbers.
Notifications are reassembled before decoding protobuf messages.

On the tested firmware (1.1.11), one-second keep-alives allowed the connection
to remain open while notifications stopped. Sending the captured heartbeat
`3500050a03c20100` every 250 ms kept notifications working after idle periods.
The original Linux experiment specifies a 500 ms interval. Maneline uses 250 ms
to leave scheduling margin and continues sending while a switch awaits its
acknowledgement. Commands share a write lock, while whole switch operations are
serialized separately. This interval is verified behavior, not a documented
Fender timing guarantee.

It may not cover every case. In one live test on 30 October 2026, about ten minutes
into a connection, a switch reached the amp but no notifications arrived for the
8-second timeout even though heartbeats continued. Reconnecting recovered in about
three seconds. The cause is unknown and this has not been reproduced.

On 30 October 2026 live testing on macOS read all 100 saved preset definitions.
Editor tests were restricted to disposable slot 100, with a backup created before
its first write. Float, integer and boolean parameter edits, effect replacement,
unsaved-change discard, same-slot save and cross-slot copy were exercised. A
saved test name and gain were also verified over a new Bluetooth connection.
The reworked page was then run against slot 100 in the browser: keyboard and
sustained slider edits, a number box, an effect on/off switch, an integer setting,
Reset, saving with a new name, and undo. The saved result survived switching away
and back, and after undo the slot's definition matched its original exactly.
Disconnect handling is covered by simulated lifecycle tests; physical power-cycle
recovery was not tested.

```sh
_work/mmp-venv/bin/python -m unittest discover -s scripts/tests -v
```

The 48 hardware-independent tests cover captured packets, fragmented names,
typed parameters, acknowledgement and read-back requirements, backups before
writes, undo, stale editor state, copy identities, keep-alives during pending switches,
HTTP validation, same-origin writes and static-file access restrictions.

### Editing protocol

Command and response IDs were recovered from the protobuf descriptors in the
user-installed Fender Tone Android package, version 5.1.3.112680, specifically
`mp/MustangLtxAppMessage.proto`. No app binaries, private app data, or proprietary
implementation code are included in this repository. Model identifiers are
from the app's Micro Plus interface metadata. String choices and numeric display
hints are interface facts observed in preset definitions, not complete firmware
parameter specifications.

| Operation | Request field | Response field |
| --- | --- | --- |
| Read current preset and JSON | 4 | 5 (selection), 4 (JSON) |
| Read saved slot without selecting it | 12 | 10 |
| Read a parameter's value/type | 11 | 9 |
| Set a parameter | 20 | 9 |
| Replace an amp/effect model | 17 | 15 |
| Save the current preset | 5 | 13 |
| Write a preset copy to a slot | 18 | 13 |

Requests use outer field 1 and responses outer field 2. Preset JSON is an LZ4
block inside protobuf bytes fields; no fixed offsets are assumed. Large messages
use transport markers `0x33`, `0x34`, `0x35`. The Micro Plus can emit `0x35` before
the message is complete, so reassembly also checks the protobuf envelope length.
Full-preset writes hold the write lock across their fragments to prevent a
heartbeat from appearing inside a fragmented command.

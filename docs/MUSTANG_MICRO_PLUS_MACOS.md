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

## Browser controls

```sh
bash scripts/run_web_cli.sh --micro-plus
```

Open `http://localhost:8080`. This launch mode serves the Micro Plus page from
`web-app/web_ui`, using the existing Maneline styles. It owns one persistent BLE
connection shared by all browser clients; browser refreshes and preset clicks do
not reconnect the amplifier. The original Java/Lua USB mode is still launched
with `scripts/run_web_cli.sh` without `--micro-plus`.

The page displays the current preset, highlights its button, and lets you filter
presets by number or name. Selecting a preset waits for the amp to confirm the
change. The display also follows preset changes received from the device.
Switching presets does not rewrite saved preset settings.

### Editing and saving

Saving was tested only against disposable slot 100 on firmware 1.1.11. Other
destinations use the same write path but were not overwritten during testing.

Choose a preset, then use the model menus and parameter controls in **Preset
editor**. Changes are sent to the active sound so you can hear them immediately.
An **Unsaved changes** indicator remains until you save or discard them. A
parameter change is acknowledged and its updated preset is read back before the
browser reports success. The editor queries the device's parameter type before
writing, distinguishing continuous float controls from integer choices.

Common normalized controls use a 0–10 slider. Other numeric controls display the
device's native values; advanced parameter units and ranges are not all known.
String menus include values observed on the device and may not contain every
option supported by the firmware. Amplifier choices currently cover the app's
25 guitar models. An unsupported value is reported as an error, not success.

Set **Preset name** (up to 16 characters) and **Destination preset**, then click
**Save to device**. The in-page confirmation identifies the destination. Before
writing, the server reads that slot's saved definition and writes a JSON
backup under `_work/preset-backups/`. If the backup cannot be created, no save is
sent. Saving to another slot creates a copy with a new preset ID and leaves the
source's saved contents unchanged. The device's saved response must be followed
by a matching read-back of the destination name and signal chain before success
is reported. Acknowledgement alone is insufficient.

**Discard unsaved changes** reloads the saved preset. Switching away from an
edited preset also asks before discarding live edits or an unsaved name. Browser
requests include the selected slot and an opaque editor revision, so stale
controls cannot quietly edit a different preset. The revision includes a fresh
connection identity, including after restarting the server.

Backups contain the device ID, destination slot and full preset JSON. Keep them
when moving or cleaning a worktree. They are not committed to Git. The browser
does not currently provide a restore/import button; the controller's
`restore_preset` method uses the verified full-preset write operation.

If the amplifier disconnects, the page clears its current selection and disables
switching until the connection recovers. The server retries automatically, using
the device ID from the first connection. It does not retry an unconfirmed
switch: it reconnects and reads the actual current selection instead.

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
`parameter`, `model`, or `save`. Each action includes `preset` and `revision`
from the latest GET response. Parameter changes also supply `node`, `parameter`
and `value`; model changes supply `node` and `model`; saves supply `target` and
`name`. A stale revision returns HTTP 409, invalid data returns 400, an
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

On 30 October 2026 live testing on macOS read all 100 saved preset definitions.
Editor tests were restricted to disposable slot 100, with a backup created before
its first write. Float, integer and boolean parameter edits, effect replacement,
unsaved-change discard, same-slot save and cross-slot copy were exercised. A
saved test name and gain were also verified over a new Bluetooth connection.
Disconnect handling is covered by simulated lifecycle tests; physical power-cycle
recovery was not tested.

```sh
_work/mmp-venv/bin/python -m unittest discover -s scripts/tests -v
```

The 39 hardware-independent tests cover captured packets, fragmented names,
typed parameters, acknowledgement and read-back requirements, backups before
writes, stale editor state, copy identities, keep-alives during pending switches,
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

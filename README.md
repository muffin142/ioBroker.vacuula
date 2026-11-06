![Logo](admin/vacuula.png)
# ioBroker.vacuula

[![NPM version](https://img.shields.io/npm/v/iobroker.vacuula.svg)](https://www.npmjs.com/package/iobroker.vacuula)
[![Downloads](https://img.shields.io/npm/dm/iobroker.vacuula.svg)](https://www.npmjs.com/package/iobroker.vacuula)
![Number of Installations](https://iobroker.live/badges/vacuula-installed.svg)
![Current version in stable repository](https://iobroker.live/badges/vacuula-stable.svg)
![Test and Release](https://github.com/muffin142/ioBroker.vacuula/workflows/Test%20and%20Release/badge.svg)

[![NPM](https://nodei.co/npm/iobroker.vacuula.png?downloads=true)](https://nodei.co/npm/iobroker.vacuula/)

## Vacuula Adapter for ioBroker

Connect to your [Vacuula Server](https://github.com/vacuula/vacuula) and regain control of your Neato robot vacuum in ioBroker

## Usage

The adapter connects to a Vacuula server via its HTTP API, discovers all robots registered there and exposes their status and controls as ioBroker states. A running and reachable Vacuula server is required; the robots themselves are never contacted directly.

### Configuration

| Setting | Description |
|---|---|
| **Protocol** | `HTTP` or `HTTPS`, depending on how your Vacuula server is exposed. With HTTPS the server certificate must be valid and trusted by Node.js – self-signed certificates are not accepted. |
| **Server address** | Hostname, IPv4 or IPv6 address of the Vacuula server, optionally followed by a port. Do not enter a protocol or path. Examples: `192.168.1.10`, `vacuula.local:8080`, `[fd00::10]:8080`. IPv6 addresses must be enclosed in square brackets. |
| **Polling interval** | Interval in seconds (5–3600, default 30) at which the robot list and the state of each robot are queried. |

### Objects

`vacuula.0.info.connection` indicates whether the adapter can reach the Vacuula server. It is updated on every request, not only during polling.

Every robot reported by the server is created as a device `vacuula.0.<robotId>`. The device name is the robot's name, and its online indicator in the object view is linked to the robot's `connected` state. Robots that are no longer reported by the server are kept, but marked as disconnected. The detailed state is only queried for connected robots.

| State | Type | Writable | Description |
|---|---|---|---|
| `name` | string | – | Name of the robot as configured on the server |
| `connected` | boolean | – | Robot is connected to the Vacuula server |
| `info.modelName` | string | – | Model, e.g. `BotVacD7Connected` |
| `info.firmware` | string | – | Firmware version |
| `status.state` | number | – | `1` Idle, `2` Cleaning, `3` Paused, `4` Docking |
| `status.action` | number | – | Current action, e.g. `4` Docking, `9` Recovering location, `11` Cleaning, `13` Acquiring map IDs |
| `status.charge` | number | – | Battery level in % |
| `status.isCharging` | boolean | – | Robot is charging |
| `status.isDocked` | boolean | – | Robot is in its base |
| `status.dockHasBeenSeen` | boolean | – | Robot has located its base |
| `status.isScheduleEnabled` | boolean | – | Cleaning schedule is enabled on the robot |
| `status.error` | string | – | Current error reported by the robot, empty if none |
| `status.alert` | string | – | Current alert reported by the robot, empty if none |
| `cleaning.category` | number | ✓ | Cleaning type: `2` House, `3` Spot, `4` Map |
| `cleaning.mode` | number | ✓ | `1` Eco, `2` Normal |
| `cleaning.modifier` | number | ✓ | `1` Normal, `2` Intensive |
| `cleaning.navigationMode` | number | ✓ | `1` Normal, `2` Extra Care, `3` Deep |
| `cleaning.spotWidth` | number | ✓ | Width of the spot area in cm |
| `cleaning.spotHeight` | number | ✓ | Height of the spot area in cm |
| `commands.start` | button | ✓ | Start cleaning with the current `cleaning.*` settings |
| `commands.pause` | button | ✓ | Pause cleaning |
| `commands.resume` | button | ✓ | Resume a paused cleaning |
| `commands.stop` | button | ✓ | Stop cleaning |
| `commands.findMe` | button | ✓ | Make the robot play a sound to locate it |

### Controlling a robot

Commands are triggered by setting the corresponding `commands.*` state to `true` (without ack). The adapter sends the command to the server, resets the button to `false` and immediately refreshes the robot's state. Commands the robot cannot execute in its current situation (e.g. `resume` while not paused) are rejected by the server and logged as an error.

The `cleaning.*` states reflect the settings reported by the robot and serve as parameters for `commands.start`:

1. Set the desired values, e.g. `cleaning.category = 3`, `cleaning.mode = 1`, `cleaning.spotWidth = 200`, `cleaning.spotHeight = 200` for a 2 × 2 m spot cleaning in eco mode.
2. Set `commands.start` to `true`.

Values written by you (ack = false) are not overwritten by polling until the cleaning has been started; afterwards the values reported by the robot are shown again. The start command always sends `category`, `mode` and `navigationMode`; `spotWidth` and `spotHeight` are only sent for spot cleaning (`category = 3`).

Example (JavaScript adapter):

```js
const robot = 'vacuula.0.OPS36118-f045da63f5f4';
await setStateAsync(`${robot}.cleaning.category`, 2); // House
await setStateAsync(`${robot}.cleaning.mode`, 2);     // Normal
await setStateAsync(`${robot}.commands.start`, true);
```

### Troubleshooting

Connection problems and failed commands are written to the ioBroker log. A persisting error is logged once as an error and then only at debug level until it is resolved, so the log is not flooded on every polling cycle. Set the instance log level to `debug` to see every request sent to the Vacuula server.

## Changelog
<!--
	Placeholder for the next version (at the beginning of the line):
	### **WORK IN PROGRESS**
-->
### **WORK IN PROGRESS**
*

### 0.0.2 (2026-11-05)
* (muffin142) enabled automated releases

### 0.0.1 (2026-11-05)
* (muffin142) initial release

## License
MIT License

Copyright (c) 2026 muffin142 <muffin142@outlook.com>

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
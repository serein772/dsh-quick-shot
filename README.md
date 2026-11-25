# Quick shot (`dsh-quick-shot`)

English | [中文](README.zh.md)

**Windows only.** The capture is a WinForms/C# helper the Host compiles on first
use; there is no non-Windows path.

A camera button in the composer toolbar that turns a screen region into an
attachment:

1. Click the camera button next to the send control.
2. The Harness window hides and a dimmed selection overlay appears.
3. Drag the region you want (Esc or right-click cancels, a long idle time cancels
   too). The label shows the region size in pixels.
4. The window comes back and the PNG lands in the composer as a pending
   attachment, ready to send with your next message.

The button is a small ghost icon in the `conversation.input.right` slot, so it sits
with the other composer controls and inherits the host theme. Next to it is a tiny
range toggle. While a shot is in flight the camera icon turns into a spinner; a
canceled shot or a failure is reported through the composer's own notice banner.

## Capture range

A small monitor/window icon beside the camera button switches the capture range;
the choice is remembered across reloads (`localStorage`):

| Mode | Behavior |
|---|---|
| **Desktop area** (default, monitor icon) | The Harness window hides, the whole desktop dims, and you drag any region across the screen. |
| **Harness window** (window icon) | The Harness window stays visible; the dim overlay covers only that window, so you can snip part of the app UI itself. |

The tooltip on the toggle shows the current range and what a click switches to.

## Cursor and selection

The overlay is dimmed to 50% black. The system pointer is hidden and replaced by a
small high-contrast crosshair drawn at the pointer: black outline, bright red core,
a centre dot and short arms — visible on both dark and busy backgrounds without
covering the screen with guide lines.

The selection is drawn as a white underline plus a blue border and carries a
`width x height` label. Esc or right-click cancels; a long idle time cancels too.

## No Harness residue in the shot

Hiding the window with `ShowWindow(SW_HIDE)` can fade out over ~150–250 ms under
Windows' DWM transitions; grabbing the screen immediately then catches the window
half-transparent, which shows up as faint Harness UI inside the screenshot. The
helper instead **cloaks** the window (`DWMWA_CLOAK`): the compositor drops it
instantly with no animation, while placement, taskbar presence and window state are
unchanged, so the grab happens on a clean desktop and un-cloaking restores the
window in place. A plain hide remains as a fallback with a longer settle wait for
systems where cloaking is unavailable.

## Why it feels instant

A native C# helper (`helper.cs`) is compiled **once** with the in-box .NET
Framework compiler and cached by source hash under
`%LOCALAPPDATA%\dsh-quick-shot\quick-shot-<hash>.exe`. Each click spawns that
executable, which hides the window, grabs the screen, shows the overlay and exits —
so there is no warm process and no idle memory.

| Path | Click → overlay visible |
|---|---|
| Steady state (cached executable) | ~0.3 s (process start ~50–90 ms + hide/grab ~180 ms + overlay ~100 ms) |
| First click after a rebuild / cold file cache | ~0.5–0.6 s |
| Old cold PowerShell path | ~3 s |
| Alternative warm-PowerShell daemon | ~0.23 s but ~90 MB idle |

## How it works

| Piece | Role |
|---|---|
| `client.js` | Registers the button. Posts to the Host, then turns the returned PNG into a `File`, creates a draft attachment through the Conversation service (`createDrafts`) and adds it with the session input handle (`input.addAttachments`) — the same path the built-in file picker uses. |
| `index.js` | Serves `POST /quick-shot/capture` on the same origin, behind the Web carrier's trust gate. Builds/reuses the helper executable, spawns one helper per capture, and falls back to PowerShell when compilation is unavailable (desktop mode only). |
| `helper.cs` | The capture itself: find the window by page title, then either hide it and grab the desktop or keep it visible and grab only its rectangle (`--mode desktop|window`); show the dimmed rubber-band overlay with crosshair guides, restore the window if it was hidden, crop and return the PNG as base64 JSON. |
| `capture.ps1` | Slow-path fallback with the same capture flow in PowerShell (used when `csc.exe` is missing or the build fails). |

Only Windows is supported. The helper build needs the .NET Framework 4.x compiler
that ships with Windows (`%WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe`).
No pixel leaves the machine: the image travels page -> Host -> page, nothing is
written to disk except the cached executable, and the system clipboard is not
touched.

## Using the pieces without the page

```
powershell -STA -NoProfile -File capture.ps1 -DryRun -TitleB64 <base64 title>
powershell -STA -NoProfile -File capture.ps1 -SelfTest -TitleB64 <base64 title>
```

The helper itself accepts `--title-b64 <b64> [--mode desktop|window] [--timeout
<seconds>] [--selftest] [--auto-drag]` and prints one `started` line followed by
one result line.

## Install

```
dsh plugin add github:serein772/dsh-quick-shot
```

Or find it in the plugin market. For local development, point a profile dependency
at this directory with `link:`.

Both JavaScript halves have no build step; the C# helper is compiled by the Host
on activation.

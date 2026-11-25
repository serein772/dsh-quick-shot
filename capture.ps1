param(
  [string]$TitleB64 = "",
  [int]$TimeoutSeconds = 120,
  [switch]$DryRun,
  [switch]$SelfTest,
  [switch]$AutoDrag,
  [switch]$Daemon
)

# Quick shot host helper.
#
# One-shot mode (`-File capture.ps1 -TitleB64 ...`) answers a single capture.
# Daemon mode (`-Daemon`) keeps the expensive parts warm: the WinForms/Drawing
# assemblies and the compiled P/Invoke type load once, then it answers one
# newline-delimited JSON request per line on stdin. The Host starts it when the
# plugin activates, so a click only pays for hiding the window, grabbing the
# screen and showing the selection overlay (~150-250 ms) instead of ~2.5 s of
# process start + Add-Type + the Windows snip tool (~0.8 s more).
#
# ASCII only: Windows PowerShell 5.1 reads a BOM-less script as ANSI.

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

if (-not ('QS.Win' -as [type])) {
  Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
namespace QS {
  public static class Win {
    public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
    [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
    [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr value);
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc callback, IntPtr lParam);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
    [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int command);
    [DllImport("user32.dll")] public static extern bool IsZoomed(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
    [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
    [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint attach, uint attachTo, bool on);
    [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, IntPtr extra);
  }
}
'@
}
# Physical pixels everywhere: the overlay and the screenshot must use the same
# coordinate space or the crop comes out scaled on a HiDPI display.
$perMonitorAware = $false
try {
  $perMonitorAware = [QS.Win]::SetProcessDpiAwarenessContext([IntPtr](-4))
} catch {
  $perMonitorAware = $false
}
if (-not $perMonitorAware) {
  try { [void][QS.Win]::SetProcessDPIAware() } catch {}
}

function Write-JsonLine {
  param($Payload)
  [Console]::Out.WriteLine(($Payload | ConvertTo-Json -Compress -Depth 5))
  [Console]::Out.Flush()
}

function Get-TopLevelWindows {
  $script:collected = New-Object System.Collections.ArrayList
  $callback = [QS.Win+EnumProc] {
    param($hWnd, $lParam)
    if ([QS.Win]::IsWindowVisible($hWnd)) {
      $length = [QS.Win]::GetWindowTextLength($hWnd)
      if ($length -gt 0) {
        $builder = New-Object System.Text.StringBuilder ($length + 2)
        [void][QS.Win]::GetWindowText($hWnd, $builder, $builder.Capacity)
        [void]$script:collected.Add([pscustomobject]@{ Handle = $hWnd; Title = $builder.ToString() })
      }
    }
    return $true
  }
  [void][QS.Win]::EnumWindows($callback, [IntPtr]::Zero)
  return $script:collected
}

function Find-TargetWindow {
  param([string]$TitleBase64)
  $windows = Get-TopLevelWindows
  if ($TitleBase64 -ne '') {
    try {
      $wanted = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($TitleBase64))
    } catch {
      $wanted = ''
    }
    if ($wanted -ne '') {
      $exact = $windows | Where-Object { $_.Title -eq $wanted } | Select-Object -First 1
      if ($null -ne $exact) { return $exact }
      $prefix = $windows | Where-Object { $wanted.StartsWith($_.Title) -or $_.Title.StartsWith($wanted) } | Select-Object -First 1
      if ($null -ne $prefix) { return $prefix }
    }
  }
  $foreground = [QS.Win]::GetForegroundWindow()
  $fallback = $windows | Where-Object { $_.Handle -eq $foreground } | Select-Object -First 1
  return $fallback
}

function Restore-TargetWindow {
  param($Window, [bool]$WasZoomed)
  for ($attempt = 0; $attempt -lt 4; $attempt++) {
    try {
      if ($WasZoomed) {
        [void][QS.Win]::ShowWindow($Window.Handle, 3)
      } else {
        [void][QS.Win]::ShowWindow($Window.Handle, 9)
      }
      if (-not [QS.Win]::IsWindowVisible($Window.Handle)) {
        [void][QS.Win]::ShowWindow($Window.Handle, 5)
      }
      $foreground = [QS.Win]::GetForegroundWindow()
      [uint32]$foregroundThread = 0
      if ($foreground -ne [IntPtr]::Zero) {
        [void][QS.Win]::GetWindowThreadProcessId($foreground, [ref]$foregroundThread)
      }
      $currentThread = [QS.Win]::GetCurrentThreadId()
      if ($foregroundThread -ne 0 -and $foregroundThread -ne $currentThread) {
        [void][QS.Win]::AttachThreadInput($currentThread, $foregroundThread, $true)
      }
      [void][QS.Win]::BringWindowToTop($Window.Handle)
      [void][QS.Win]::SetForegroundWindow($Window.Handle)
      if ($foregroundThread -ne 0 -and $foregroundThread -ne $currentThread) {
        [void][QS.Win]::AttachThreadInput($currentThread, $foregroundThread, $false)
      }
    } catch {
      # A failed raise is recoverable by the user from the taskbar.
    }
    Start-Sleep -Milliseconds 120
    try {
      if (-not [QS.Win]::IsIconic($Window.Handle) -and [QS.Win]::IsWindowVisible($Window.Handle)) { return }
    } catch {
      return
    }
  }
}

# Full-screen rubber-band selection over a screenshot. Returns the chosen
# rectangle in screenshot pixels, or $null when cancelled.
function Show-SelectionOverlay {
  param(
    [System.Drawing.Bitmap]$ScreenBitmap,
    [int]$TimeoutSeconds,
    [bool]$AutoDrag = $false
  )

  $script:overlayScreen = $ScreenBitmap
  $script:overlayStart = $null
  $script:overlayRect = [System.Drawing.Rectangle]::Empty
  $script:overlayResult = $null

  $form = New-Object System.Windows.Forms.Form
  $form.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::None
  $form.StartPosition = [System.Windows.Forms.FormStartPosition]::Manual
  $form.Bounds = [System.Windows.Forms.SystemInformation]::VirtualScreen
  $form.TopMost = $true
  $form.ShowInTaskbar = $false
  $form.Cursor = [System.Windows.Forms.Cursors]::Cross
  $form.BackColor = [System.Drawing.Color]::Black
  $form.Opacity = 0.5
  $form.KeyPreview = $true
  $script:overlayForm = $form

  $form.add_KeyDown({
    if ($_.KeyCode -eq [System.Windows.Forms.Keys]::Escape) {
      $script:overlayResult = $null
      $script:overlayForm.Close()
    }
  })
  $form.add_MouseDown({
    if ($_.Button -eq [System.Windows.Forms.MouseButtons]::Left) {
      $script:overlayStart = $_.Location
      $script:overlayRect = [System.Drawing.Rectangle]::Empty
    } elseif ($_.Button -eq [System.Windows.Forms.MouseButtons]::Right) {
      $script:overlayResult = $null
      $script:overlayForm.Close()
    }
  })
  $form.add_MouseMove({
    if ($null -ne $script:overlayStart) {
      $x1 = $script:overlayStart.X
      $y1 = $script:overlayStart.Y
      $x2 = $_.Location.X
      $y2 = $_.Location.Y
      $left = [Math]::Min($x1, $x2)
      $top = [Math]::Min($y1, $y2)
      $width = [Math]::Abs($x2 - $x1)
      $height = [Math]::Abs($y2 - $y1)
      $previous = $script:overlayRect
      $script:overlayRect = New-Object System.Drawing.Rectangle $left, $top, $width, $height
      if ($previous.Width -gt 0 -and $previous.Height -gt 0) {
        $script:overlayForm.Invalidate([System.Drawing.Rectangle]::Inflate($previous, 4, 4))
      }
      $script:overlayForm.Invalidate([System.Drawing.Rectangle]::Inflate($script:overlayRect, 4, 4))
    }
  })
  $form.add_MouseUp({
    if ($null -ne $script:overlayStart) {
      $script:overlayStart = $null
      if ($script:overlayRect.Width -ge 4 -and $script:overlayRect.Height -ge 4) {
        $script:overlayResult = $script:overlayRect
        $script:overlayForm.Close()
      } else {
        $script:overlayRect = [System.Drawing.Rectangle]::Empty
        $script:overlayForm.Invalidate()
      }
    }
  })
  $form.add_Paint({
    param($sender, $eventArgs)
    $graphics = $eventArgs.Graphics
    $rect = $script:overlayRect
    if ($rect.Width -gt 0 -and $rect.Height -gt 0) {
      $pen = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(245, 96, 152, 255)), 2
      $graphics.DrawRectangle($pen, $rect)
      $pen.Dispose()
      $border = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(230, 20, 20, 24))
      $label = "" + $rect.Width + " x " + $rect.Height
      $labelSize = $graphics.MeasureString($label, $script:overlayLabelFont)
      $labelX = [Math]::Min($rect.Left, $script:overlayForm.Width - $labelSize.Width - 16)
      $labelY = $rect.Top - $labelSize.Height - 8
      if ($labelY -lt 8) { $labelY = $rect.Bottom + 8 }
      $graphics.FillRectangle($border, $labelX - 4, $labelY - 1, $labelSize.Width + 8, $labelSize.Height + 2)
      $graphics.DrawString($label, $script:overlayLabelFont, [System.Drawing.Brushes]::White, $labelX, $labelY)
      $border.Dispose()
    }
  })

  $timer = New-Object System.Windows.Forms.Timer
  $timer.Interval = [Math]::Max(5000, $TimeoutSeconds * 1000)
  $timer.add_Tick({
    $script:overlayResult = $null
    $script:overlayForm.Close()
  })

  $script:overlayLabelFont = New-Object System.Drawing.Font('Segoe UI', 10)
  $script:overlayMs = 0
  $autoTimer = $null
  $stopwatch = [System.Diagnostics.Stopwatch]::StartNew()
  try {
    $form.Show()
    $form.Activate()
    $script:overlayMs = $stopwatch.ElapsedMilliseconds
    if ($AutoDrag) {
      # Diagnostic path: synthesize a drag so the overlay's mouse path can be
      # exercised without a human. Never enabled by the plugin UI.
      $script:autoStep = 0
      $script:autoScreenStart = $form.PointToScreen((New-Object System.Drawing.Point 140, 140))
      $script:autoScreenEnd = $form.PointToScreen((New-Object System.Drawing.Point 480, 340))
      $script:autoScreenMid = New-Object System.Drawing.Point ([int](($script:autoScreenStart.X + $script:autoScreenEnd.X) / 2)), ([int](($script:autoScreenStart.Y + $script:autoScreenEnd.Y) / 2))
      $autoTimer = New-Object System.Windows.Forms.Timer
      $autoTimer.Interval = 70
      $autoTimer.add_Tick({
        $script:autoStep = $script:autoStep + 1
        switch ($script:autoStep) {
          1 { [void][QS.Win]::SetCursorPos($script:autoScreenStart.X, $script:autoScreenStart.Y) }
          2 { [QS.Win]::mouse_event(0x0002, 0, 0, 0, [IntPtr]::Zero) }
          3 { [void][QS.Win]::SetCursorPos($script:autoScreenMid.X, $script:autoScreenMid.Y) }
          4 { [void][QS.Win]::SetCursorPos($script:autoScreenEnd.X, $script:autoScreenEnd.Y) }
          5 { [QS.Win]::mouse_event(0x0004, 0, 0, 0, [IntPtr]::Zero); $autoTimer.Stop() }
          default { $autoTimer.Stop() }
        }
      })
      $autoTimer.Start()
    }
    $timer.Start()
    [System.Windows.Forms.Application]::Run($form)
  } finally {
    $timer.Stop()
    $timer.Dispose()
    if ($null -ne $autoTimer) {
      $autoTimer.Stop()
      $autoTimer.Dispose()
      $autoTimer = $null
    }
    $form.Dispose()
    if ($null -ne $script:overlayLabelFont) {
      $script:overlayLabelFont.Dispose()
      $script:overlayLabelFont = $null
    }
  }
  return $script:overlayResult
}

function Invoke-Capture {
  param(
    [string]$TitleBase64 = "",
    [int]$TimeoutSeconds = 120,
    [bool]$SelfTest = $false,
    [bool]$AutoDrag = $false
  )

  $stopwatch = [System.Diagnostics.Stopwatch]::StartNew()
  $target = Find-TargetWindow -TitleBase64 $TitleBase64
  if ($null -eq $target) { return @{ ok = $false; error = 'no-window' } }

  $wasZoomed = $false
  try { $wasZoomed = [QS.Win]::IsZoomed($target.Handle) } catch {}
  [void][QS.Win]::ShowWindow($target.Handle, 0)

  $screen = $null
  $overlayMs = 0
  $hideMs = 0
  $result = $null
  try {
    Start-Sleep -Milliseconds 80
    $virtual = [System.Windows.Forms.SystemInformation]::VirtualScreen
    $screen = New-Object System.Drawing.Bitmap $virtual.Width, $virtual.Height, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $graphics = [System.Drawing.Graphics]::FromImage($screen)
    $graphics.CopyFromScreen($virtual.Left, $virtual.Top, 0, 0, $virtual.Size)
    $graphics.Dispose()
    $hideMs = $stopwatch.ElapsedMilliseconds

    if ($SelfTest) {
      $width = [Math]::Min(320, [Math]::Max(8, $screen.Width - 40))
      $height = [Math]::Min(180, [Math]::Max(8, $screen.Height - 40))
      $result = New-Object System.Drawing.Rectangle 20, 20, $width, $height
    } else {
      $result = Show-SelectionOverlay -ScreenBitmap $screen -TimeoutSeconds $TimeoutSeconds -AutoDrag $AutoDrag
      $overlayMs = $script:overlayMs
    }
  } finally {
    Restore-TargetWindow $target $wasZoomed
  }

  if ($null -eq $result) {
    if ($null -ne $screen) { $screen.Dispose() }
    return @{ ok = $false; cancelled = $true; timings = @{ overlayMs = $overlayMs; hideMs = $hideMs; totalMs = $stopwatch.ElapsedMilliseconds } }
  }

  $crop = $null
  $stream = $null
  try {
    $crop = $screen.Clone($result, $screen.PixelFormat)
    $stream = New-Object System.IO.MemoryStream
    $crop.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png)
    $bytes = $stream.ToArray()
  } finally {
    if ($null -ne $stream) { $stream.Dispose() }
    if ($null -ne $crop) { $crop.Dispose() }
    if ($null -ne $screen) { $screen.Dispose() }
  }

  return @{
    ok = $true
    mime = 'image/png'
    width = $result.Width
    height = $result.Height
    image = [Convert]::ToBase64String($bytes)
    timings = @{ overlayMs = $overlayMs; hideMs = $hideMs; totalMs = $stopwatch.ElapsedMilliseconds }
  }
}

if ($Daemon) {
  [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
  Write-JsonLine @{ type = 'ready' }
  while ($true) {
    $line = [Console]::In.ReadLine()
    if ($null -eq $line) { break }
    if ($line.Trim() -eq '') { continue }
    $id = $null
    try {
      $request = $line | ConvertFrom-Json
      $id = $request.id
      $timeout = 120
      if ($null -ne $request.timeoutSeconds) { $timeout = [int]$request.timeoutSeconds }
      $result = Invoke-Capture -TitleBase64 ([string]$request.titleB64) -TimeoutSeconds $timeout -SelfTest:([bool]$request.selfTest) -AutoDrag:([bool]$request.autoDrag)
      $payload = @{ type = 'result'; id = $id }
      foreach ($key in $result.Keys) { $payload[$key] = $result[$key] }
      Write-JsonLine $payload
    } catch {
      Write-JsonLine @{ type = 'result'; id = $id; ok = $false; error = 'script-error' }
    }
  }
  exit 0
}

try {
  if ($DryRun) {
    $target = Find-TargetWindow -TitleBase64 $TitleB64
    if ($null -eq $target) {
      Write-JsonLine @{ ok = $false; error = 'no-window' }
    } else {
      Write-JsonLine @{ ok = $true; dryRun = $true; title = $target.Title; handle = $target.Handle.ToInt64() }
    }
    exit 0
  }
  $result = Invoke-Capture -TitleBase64 $TitleB64 -TimeoutSeconds $TimeoutSeconds -SelfTest:([bool]$SelfTest) -AutoDrag:([bool]$AutoDrag)
  Write-JsonLine $result
} catch {
  try { [Console]::Error.WriteLine('quick-shot: ' + $_.Exception.Message) } catch {}
  try { Write-JsonLine @{ ok = $false; error = 'script-error' } } catch {}
}
exit 0

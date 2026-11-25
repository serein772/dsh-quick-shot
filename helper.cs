// Quick shot standalone helper.
//
// One process per capture: find the window by its title, then either hide it and
// grab the whole desktop (`--mode desktop`) or grab just the window rectangle and
// leave it visible (`--mode window`); in both cases show a dimmed rubber-band
// overlay with a high-contrast crosshair, restore the window if it was hidden,
// and print the selected region as a base64 PNG.
//
// Compiled by the Host half with the in-box .NET Framework compiler; no runtime
// state and no idle process.
//
// Protocol on stdout: one line `{"type":"started"}` immediately, then one line
// with the result. ASCII-safe JSON.
using System;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Windows.Forms;

namespace QuickShot
{
    internal static class Native
    {
        public const int SW_HIDE = 0;
        public const int SW_SHOWMAXIMIZED = 3;
        public const int SW_SHOW = 5;
        public const int SW_RESTORE = 9;
        private const int DWMWA_EXTENDED_FRAME_BOUNDS = 9;
        private const int DWMWA_CLOAK = 13;

        public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);

        [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr value);
        [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
        [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc callback, IntPtr lParam);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
        [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr hWnd);
        [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
        [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hWnd);
        [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
        [DllImport("user32.dll")] public static extern bool IsZoomed(IntPtr hWnd);
        [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
        [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int command);
        [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
        [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hWnd);
        [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
        [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
        [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
        [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint attach, uint attachTo, bool on);
        [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
        [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, IntPtr extra);
        [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr hWnd, int attribute, out RECT value, int size);
        [DllImport("dwmapi.dll")] public static extern int DwmSetWindowAttribute(IntPtr hWnd, int attribute, ref int value, int size);

        public const uint MOUSEEVENTF_LEFTDOWN = 0x0002;
        public const uint MOUSEEVENTF_LEFTUP = 0x0004;

        [StructLayout(LayoutKind.Sequential)]
        public struct RECT
        {
            public int Left;
            public int Top;
            public int Right;
            public int Bottom;
        }

        public static void EnableDpiAwareness()
        {
            try
            {
                if (SetProcessDpiAwarenessContext(new IntPtr(-4))) return;
            }
            catch (EntryPointNotFoundException)
            {
            }
            catch (DllNotFoundException)
            {
            }
            try { SetProcessDPIAware(); } catch { }
        }

        /** Visible window bounds (excludes the invisible resize border). */
        public static Rectangle WindowBounds(IntPtr window)
        {
            RECT rect;
            try
            {
                if (DwmGetWindowAttribute(window, DWMWA_EXTENDED_FRAME_BOUNDS, out rect, Marshal.SizeOf(typeof(RECT))) == 0)
                {
                    Rectangle result = Rectangle.FromLTRB(rect.Left, rect.Top, rect.Right, rect.Bottom);
                    if (result.Width > 0 && result.Height > 0) return result;
                }
            }
            catch
            {
            }
            if (GetWindowRect(window, out rect))
            {
                return Rectangle.FromLTRB(rect.Left, rect.Top, rect.Right, rect.Bottom);
            }
            return Rectangle.Empty;
        }

        /**
         * DWM cloak: the compositor stops drawing the window immediately, with no
         * hide/minimize transition. Cloaked windows keep their taskbar presence and
         * placement, so unhiding is instant and side-effect free, and a screen grab
         * taken right after never catches the fading window.
         */
        public static bool SetCloaked(IntPtr window, bool cloaked)
        {
            try
            {
                int value = cloaked ? 1 : 0;
                return DwmSetWindowAttribute(window, DWMWA_CLOAK, ref value, sizeof(int)) == 0;
            }
            catch
            {
                return false;
            }
        }

        public static void RaiseForeground(IntPtr window)
        {
            try
            {
                IntPtr foreground = GetForegroundWindow();
                uint foregroundThread = 0;
                if (foreground != IntPtr.Zero) GetWindowThreadProcessId(foreground, out foregroundThread);
                uint currentThread = GetCurrentThreadId();
                bool attached = false;
                if (foregroundThread != 0 && foregroundThread != currentThread)
                {
                    attached = AttachThreadInput(currentThread, foregroundThread, true);
                }
                try
                {
                    BringWindowToTop(window);
                    SetForegroundWindow(window);
                }
                finally
                {
                    if (attached) AttachThreadInput(currentThread, foregroundThread, false);
                }
            }
            catch
            {
                // A failed raise is recoverable from the taskbar.
            }
        }

        public static void RestoreWindow(IntPtr window, bool wasZoomed)
        {
            for (int attempt = 0; attempt < 4; attempt++)
            {
                try
                {
                    ShowWindow(window, wasZoomed ? SW_SHOWMAXIMIZED : SW_RESTORE);
                    if (!IsWindowVisible(window)) ShowWindow(window, SW_SHOW);
                    RaiseForeground(window);
                }
                catch
                {
                }
                System.Threading.Thread.Sleep(120);
                try
                {
                    if (!IsIconic(window) && IsWindowVisible(window)) return;
                }
                catch
                {
                    return;
                }
            }
        }
    }

    internal sealed class Options
    {
        public string Title = "";
        public string Mode = "desktop";
        public int TimeoutSeconds = 120;
        public bool SelfTest;
        public bool AutoDrag;

        public static Options Parse(string[] args)
        {
            var options = new Options();
            for (int index = 0; index < args.Length; index++)
            {
                string arg = args[index];
                switch (arg)
                {
                    case "--title-b64":
                        if (index + 1 >= args.Length) return null;
                        try
                        {
                            options.Title = Encoding.UTF8.GetString(Convert.FromBase64String(args[++index]));
                        }
                        catch
                        {
                            return null;
                        }
                        break;
                    case "--mode":
                        if (index + 1 >= args.Length) return null;
                        options.Mode = args[++index] == "window" ? "window" : "desktop";
                        break;
                    case "--timeout":
                        if (index + 1 >= args.Length) return null;
                        int seconds;
                        if (!int.TryParse(args[++index], out seconds)) return null;
                        options.TimeoutSeconds = Math.Min(300, Math.Max(5, seconds));
                        break;
                    case "--selftest":
                        options.SelfTest = true;
                        break;
                    case "--auto-drag":
                        options.AutoDrag = true;
                        break;
                    default:
                        return null;
                }
            }
            return options;
        }
    }

    internal sealed class SelectionForm : Form
    {
        private readonly bool autoDrag;
        private Point? start;
        private Point? pointer;
        private Rectangle region = Rectangle.Empty;
        private readonly Timer timeoutTimer;
        private Timer autoTimer;
        private int autoStep;
        private readonly Font labelFont = new Font("Segoe UI", 10f);
        private readonly Pen borderPen = new Pen(Color.FromArgb(255, 77, 163, 255), 2f);
        private readonly Pen borderHighlight = new Pen(Color.FromArgb(235, 255, 255, 255), 1f);
        private readonly Pen cursorShadow = new Pen(Color.FromArgb(225, 0, 0, 0), 3f);
        private readonly Pen cursorCore = new Pen(Color.FromArgb(255, 255, 59, 48), 1f);
        private readonly SolidBrush cursorDotShadow = new SolidBrush(Color.FromArgb(225, 0, 0, 0));
        private readonly SolidBrush cursorDotCore = new SolidBrush(Color.FromArgb(255, 255, 59, 48));
        private readonly SolidBrush labelBrush = new SolidBrush(Color.FromArgb(230, 20, 20, 24));
        private bool cursorHidden;

        public Rectangle? Selection { get; private set; }

        public SelectionForm(Rectangle bounds, int timeoutSeconds, bool autoDrag)
        {
            this.autoDrag = autoDrag;
            FormBorderStyle = FormBorderStyle.None;
            StartPosition = FormStartPosition.Manual;
            Bounds = bounds;
            TopMost = true;
            ShowInTaskbar = false;
            BackColor = Color.Black;
            Opacity = 0.5;
            KeyPreview = true;
            SetStyle(ControlStyles.OptimizedDoubleBuffer | ControlStyles.AllPaintingInWmPaint | ControlStyles.UserPaint, true);

            timeoutTimer = new Timer { Interval = Math.Max(5000, timeoutSeconds * 1000) };
            timeoutTimer.Tick += (sender, args) =>
            {
                Selection = null;
                Close();
            };
            timeoutTimer.Start();

            if (autoDrag)
            {
                autoStep = 0;
                autoTimer = new Timer { Interval = 70 };
                autoTimer.Tick += AutoTick;
                autoTimer.Start();
            }
        }

        private void AutoTick(object sender, EventArgs args)
        {
            autoStep++;
            int width = ClientSize.Width;
            int height = ClientSize.Height;
            Point startPoint = new Point(Math.Max(8, width / 5), Math.Max(8, height / 5));
            Point endPoint = new Point(Math.Max(startPoint.X + 40, width / 2), Math.Max(startPoint.Y + 40, height / 2));
            Point screenStart = PointToScreen(startPoint);
            Point screenEnd = PointToScreen(endPoint);
            switch (autoStep)
            {
                case 1:
                    Native.SetCursorPos(screenStart.X, screenStart.Y);
                    break;
                case 2:
                    Native.mouse_event(Native.MOUSEEVENTF_LEFTDOWN, 0, 0, 0, IntPtr.Zero);
                    break;
                case 3:
                    Native.SetCursorPos((screenStart.X + screenEnd.X) / 2, (screenStart.Y + screenEnd.Y) / 2);
                    break;
                case 4:
                    Native.SetCursorPos(screenEnd.X, screenEnd.Y);
                    break;
                case 5:
                    Native.mouse_event(Native.MOUSEEVENTF_LEFTUP, 0, 0, 0, IntPtr.Zero);
                    autoTimer.Stop();
                    break;
                default:
                    autoTimer.Stop();
                    break;
            }
        }

        protected override void OnShown(EventArgs args)
        {
            base.OnShown(args);
            try
            {
                Cursor.Hide();
                cursorHidden = true;
            }
            catch
            {
                cursorHidden = false;
            }
            pointer = PointToClient(Cursor.Position);
            Invalidate();
        }

        private void InvalidateCursor(Point? previous)
        {
            if (!previous.HasValue) return;
            const int padding = 18;
            Invalidate(new Rectangle(previous.Value.X - padding, previous.Value.Y - padding, padding * 2, padding * 2));
        }

        protected override void OnMouseDown(MouseEventArgs args)
        {
            base.OnMouseDown(args);
            pointer = args.Location;
            InvalidateCursor(args.Location);
            if (args.Button == MouseButtons.Left)
            {
                start = args.Location;
                region = Rectangle.Empty;
                Invalidate();
            }
            else if (args.Button == MouseButtons.Right)
            {
                Selection = null;
                Close();
            }
        }

        protected override void OnMouseMove(MouseEventArgs args)
        {
            base.OnMouseMove(args);
            Point? previousPointer = pointer;
            pointer = args.Location;
            InvalidateCursor(previousPointer);
            InvalidateCursor(args.Location);
            if (!start.HasValue) return;
            Point origin = start.Value;
            Rectangle previous = region;
            region = Rectangle.FromLTRB(
                Math.Min(origin.X, args.X),
                Math.Min(origin.Y, args.Y),
                Math.Max(origin.X, args.X),
                Math.Max(origin.Y, args.Y));
            if (previous.Width > 0 && previous.Height > 0)
            {
                Invalidate(Rectangle.Inflate(previous, 4, 4));
            }
            Invalidate(Rectangle.Inflate(region, 4, 4));
        }

        protected override void OnMouseUp(MouseEventArgs args)
        {
            base.OnMouseUp(args);
            if (!start.HasValue) return;
            start = null;
            if (region.Width >= 4 && region.Height >= 4)
            {
                Selection = region;
                Close();
            }
            else
            {
                region = Rectangle.Empty;
                Invalidate();
            }
        }

        protected override void OnKeyDown(KeyEventArgs args)
        {
            base.OnKeyDown(args);
            if (args.KeyCode == Keys.Escape)
            {
                Selection = null;
                Close();
            }
        }

        protected override void OnPaint(PaintEventArgs args)
        {
            base.OnPaint(args);
            Graphics graphics = args.Graphics;
            if (region.Width > 0 && region.Height > 0)
            {
                graphics.DrawRectangle(borderHighlight, region);
                graphics.DrawRectangle(borderPen, region);
                string label = region.Width + " x " + region.Height;
                SizeF size = graphics.MeasureString(label, labelFont);
                float labelX = Math.Min(region.Left, ClientSize.Width - size.Width - 16);
                float labelY = region.Top - size.Height - 8;
                if (labelY < 8) labelY = region.Bottom + 8;
                graphics.FillRectangle(labelBrush, labelX - 4, labelY - 1, size.Width + 8, size.Height + 2);
                graphics.DrawString(label, labelFont, Brushes.White, labelX, labelY);
            }
            if (pointer.HasValue)
            {
                int x = pointer.Value.X;
                int y = pointer.Value.Y;
                const int arm = 11;
                graphics.DrawLine(cursorShadow, x - arm, y, x + arm, y);
                graphics.DrawLine(cursorShadow, x, y - arm, x, y + arm);
                graphics.DrawLine(cursorCore, x - arm, y, x + arm, y);
                graphics.DrawLine(cursorCore, x, y - arm, x, y + arm);
                graphics.FillRectangle(cursorDotShadow, x - 2, y - 2, 5, 5);
                graphics.FillRectangle(cursorDotCore, x - 1, y - 1, 3, 3);
            }
        }

        protected override void Dispose(bool disposing)
        {
            if (disposing)
            {
                if (cursorHidden)
                {
                    try { Cursor.Show(); } catch { }
                    cursorHidden = false;
                }
                timeoutTimer.Dispose();
                if (autoTimer != null) autoTimer.Dispose();
                labelFont.Dispose();
                borderPen.Dispose();
                borderHighlight.Dispose();
                cursorShadow.Dispose();
                cursorCore.Dispose();
                cursorDotShadow.Dispose();
                cursorDotCore.Dispose();
                labelBrush.Dispose();
            }
            base.Dispose(disposing);
        }
    }

    internal static class Program
    {
        private static IntPtr FindWindow(string title)
        {
            IntPtr found = IntPtr.Zero;
            IntPtr prefixMatch = IntPtr.Zero;
            Native.EnumWindows((handle, state) =>
            {
                if (!Native.IsWindowVisible(handle)) return true;
                int length = Native.GetWindowTextLength(handle);
                if (length <= 0) return true;
                var builder = new StringBuilder(length + 2);
                Native.GetWindowText(handle, builder, builder.Capacity);
                string text = builder.ToString();
                if (title.Length > 0)
                {
                    if (text == title)
                    {
                        found = handle;
                        return false;
                    }
                    if (prefixMatch == IntPtr.Zero && (text.StartsWith(title) || title.StartsWith(text)))
                    {
                        prefixMatch = handle;
                    }
                }
                return true;
            }, IntPtr.Zero);
            if (found != IntPtr.Zero) return found;
            if (prefixMatch != IntPtr.Zero) return prefixMatch;
            IntPtr foreground = Native.GetForegroundWindow();
            if (foreground != IntPtr.Zero && Native.IsWindowVisible(foreground)) return foreground;
            return IntPtr.Zero;
        }

        private static void WriteLine(string json)
        {
            try
            {
                using (Stream stdout = Console.OpenStandardOutput())
                {
                    byte[] bytes = Encoding.UTF8.GetBytes(json + "\n");
                    stdout.Write(bytes, 0, bytes.Length);
                    stdout.Flush();
                }
            }
            catch
            {
                // The parent may have gone away.
            }
        }

        [STAThread]
        private static int Main(string[] args)
        {
            WriteLine("{\"type\":\"started\"}");
            try
            {
                Options options = Options.Parse(args);
                if (options == null)
                {
                    WriteLine("{\"type\":\"result\",\"ok\":false,\"error\":\"bad-args\"}");
                    return 0;
                }
                Native.EnableDpiAwareness();
                IntPtr target = FindWindow(options.Title);
                if (target == IntPtr.Zero)
                {
                    WriteLine("{\"type\":\"result\",\"ok\":false,\"error\":\"no-window\"}");
                    return 0;
                }
                WriteLine(Execute(target, options));
                return 0;
            }
            catch (Exception error)
            {
                WriteLine("{\"type\":\"result\",\"ok\":false,\"error\":\"helper-error\"}");
                try { Console.Error.WriteLine("quick-shot helper: " + error.Message); } catch { }
                return 0;
            }
        }

        private static string Execute(IntPtr target, Options options)
        {
            var total = Stopwatch.StartNew();
            bool windowMode = options.Mode == "window";
            bool wasZoomed = false;
            try { wasZoomed = Native.IsZoomed(target); } catch { }

            Rectangle captureBounds;
            bool cloaked = false;
            if (windowMode)
            {
                // Keep the Harness window on screen and capture its own pixels.
                if (Native.IsIconic(target)) Native.ShowWindow(target, Native.SW_RESTORE);
                Native.RaiseForeground(target);
                System.Threading.Thread.Sleep(70);
                Rectangle windowBounds = Native.WindowBounds(target);
                Rectangle virtualScreen = SystemInformation.VirtualScreen;
                captureBounds = Rectangle.Intersect(windowBounds, virtualScreen);
                if (captureBounds.Width < 16 || captureBounds.Height < 16)
                {
                    return "{\"type\":\"result\",\"ok\":false,\"error\":\"window-offscreen\"}";
                }
            }
            else
            {
                // Cloak first: the compositor drops the window instantly, unlike a
                // hide which can fade out over ~150-250 ms and leave the window
                // half-transparent in the screen grab. The longer sleep is only for
                // the fallback path where cloaking is unsupported.
                cloaked = Native.SetCloaked(target, true);
                if (!cloaked) Native.ShowWindow(target, Native.SW_HIDE);
                System.Threading.Thread.Sleep(cloaked ? 90 : 340);
                captureBounds = SystemInformation.VirtualScreen;
            }

            Bitmap screen = null;
            Rectangle? selection = null;
            long hideMs = 0;
            long overlayMs = 0;
            try
            {
                screen = new Bitmap(captureBounds.Width, captureBounds.Height, PixelFormat.Format32bppArgb);
                using (Graphics graphics = Graphics.FromImage(screen))
                {
                    graphics.CopyFromScreen(captureBounds.Left, captureBounds.Top, 0, 0, captureBounds.Size);
                }
                hideMs = total.ElapsedMilliseconds;

                if (options.SelfTest)
                {
                    int width = Math.Min(320, Math.Max(8, captureBounds.Width - 40));
                    int height = Math.Min(180, Math.Max(8, captureBounds.Height - 40));
                    selection = new Rectangle(20, 20, width, height);
                }
                else
                {
                    var form = new SelectionForm(captureBounds, options.TimeoutSeconds, options.AutoDrag);
                    var shown = Stopwatch.StartNew();
                    form.Shown += (sender, args) => { overlayMs = shown.ElapsedMilliseconds; };
                    Application.Run(form);
                    selection = form.Selection;
                    if (overlayMs == 0) overlayMs = shown.ElapsedMilliseconds;
                }
            }
            finally
            {
                if (!windowMode)
                {
                    if (cloaked)
                    {
                        Native.SetCloaked(target, false);
                        Native.RaiseForeground(target);
                    }
                    else
                    {
                        Native.RestoreWindow(target, wasZoomed);
                    }
                }
            }

            if (!selection.HasValue || selection.Value.Width < 1 || selection.Value.Height < 1)
            {
                if (screen != null) screen.Dispose();
                return "{\"type\":\"result\",\"ok\":false,\"cancelled\":true,\"timings\":{\"hideMs\":" + hideMs
                    + ",\"overlayMs\":" + overlayMs + ",\"totalMs\":" + total.ElapsedMilliseconds + "}}";
            }

            Rectangle region = selection.Value;
            string base64;
            try
            {
                using (var crop = screen.Clone(region, screen.PixelFormat))
                using (var stream = new MemoryStream())
                {
                    crop.Save(stream, ImageFormat.Png);
                    base64 = Convert.ToBase64String(stream.ToArray());
                }
            }
            finally
            {
                screen.Dispose();
            }

            return "{\"type\":\"result\",\"ok\":true,\"mime\":\"image/png\",\"width\":" + region.Width
                + ",\"height\":" + region.Height + ",\"image\":\"" + base64
                + "\",\"timings\":{\"hideMs\":" + hideMs + ",\"overlayMs\":" + overlayMs
                + ",\"totalMs\":" + total.ElapsedMilliseconds + "}}";
        }
    }
}

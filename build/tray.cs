// DeviceKeeper 托盘宿主(C#5,系统自带 csc 编译,零依赖)
// 职责:托盘图标(双击打开 WebUI)、按需拉起/监视 node 服务、静默退出。
using System;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Text;
using System.Threading;
using System.Windows.Forms;
using System.Drawing;

namespace DeviceKeeper
{
    static class Program
    {
        const int Port = 3618;
        const string TokenFile = @"DeviceKeeper\token";
        const int MaxNodeRestarts = 3;

        static NotifyIcon _tray;
        static Process _nodeProc;
        static int _restarts;
        static Mutex _mutex;
        static bool _weStartedNode;

        static string DataDir
        {
            get { return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData), "DeviceKeeper"); }
        }
        static string LogFile
        {
            get { return Path.Combine(DataDir, "logs", "tray.log"); }
        }
        static void Log(string msg)
        {
            try
            {
                Directory.CreateDirectory(Path.GetDirectoryName(LogFile));
                File.AppendAllText(LogFile, DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss") + "  " + msg + "\r\n");
            }
            catch { }
        }

        [STAThread]
        static void Main()
        {
            // 全局异常:不再静默崩溃,弹框 + 写日志,方便定位
            AppDomain.CurrentDomain.UnhandledException += (s, e) =>
            {
                var txt = (e.ExceptionObject == null) ? "" : e.ExceptionObject.ToString();
                Log("UnhandledException: " + txt);
                MessageBox.Show("程序发生错误:\r\n" + txt + "\r\n\r\n日志:" + LogFile, "DeviceKeeper", MessageBoxButtons.OK, MessageBoxIcon.Error);
            };
            Application.ThreadException += (s, e) =>
            {
                Log("ThreadException: " + e.Exception);
                MessageBox.Show("界面线程错误:\r\n" + e.Exception + "\r\n\r\n日志:" + LogFile, "DeviceKeeper", MessageBoxButtons.OK, MessageBoxIcon.Error);
            };

            try
            {
                Log("=== tray starting ===");
                bool createdNew;
                _mutex = new Mutex(true, "DeviceKeeper_Tray_SingleInstance", out createdNew);
                if (!createdNew)
                {
                    Log("another tray instance running, exit");
                    return;
                }
                Log("mutex acquired");

                Application.EnableVisualStyles();
                Application.SetCompatibleTextRenderingDefault(false);

                var menu = new ContextMenuStrip();
                menu.Items.Add("打开控制台", null, (s, e) => OpenUI());
                menu.Items.Add(new ToolStripSeparator());
                menu.Items.Add("退出", null, (s, e) => ExitApp());

                Icon ico = null;
                try { ico = Icon.ExtractAssociatedIcon(Application.ExecutablePath); }
                catch { ico = null; }
                if (ico == null) ico = SystemIcons.Application;

                _tray = new NotifyIcon
                {
                    Icon = ico,
                    Text = "DeviceKeeper - 双击打开控制台",
                    ContextMenuStrip = menu,
                    Visible = true
                };
                _tray.DoubleClick += (s, e) => OpenUI();
                Log("tray icon shown");

                var t = new Thread(EnsureServer) { IsBackground = true };
                t.Start();

                try
                {
                    _tray.ShowBalloonTip(2000, "DeviceKeeper", "设备守护已启动,双击图标打开控制台", ToolTipIcon.Info);
                }
                catch { }

                Log("tray running");
                Application.Run();
                Log("tray exited");
            }
            catch (Exception ex)
            {
                Log("FATAL: " + ex);
                MessageBox.Show("启动失败:\r\n" + ex.Message + "\r\n\r\n日志:" + LogFile, "DeviceKeeper", MessageBoxButtons.OK, MessageBoxIcon.Error);
            }
        }

        static void EnsureServer()
        {
            try
            {
                if (PingServer())
                {
                    Log("server already running, tray-only mode");
                    return;
                }
                var dir = Application.StartupPath;
                var nodeExe = Path.Combine(dir, "node.exe");
                var serverJs = Path.Combine(dir, "server.js");
                Log("dir=" + dir);
                Log("node.exe=" + File.Exists(nodeExe) + ", server.js=" + File.Exists(serverJs));
                if (!File.Exists(nodeExe) || !File.Exists(serverJs))
                {
                    ShowError("未找到 node.exe / server.js,请保持程序目录完整");
                    return;
                }
                StartNode(nodeExe, serverJs);
                Log("node started, pid=" + (_nodeProc == null ? "null" : _nodeProc.Id.ToString()));

                while (_weStartedNode)
                {
                    if (_nodeProc == null) return;
                    if (_nodeProc.WaitForExit(1000))
                    {
                        Log("node exited, code=" + _nodeProc.ExitCode);
                        if (_nodeProc.ExitCode == 2) return;
                        _restarts++;
                        if (_restarts > MaxNodeRestarts)
                        {
                            ShowError("服务多次异常退出,已停止自动重启,请查看日志");
                            return;
                        }
                        Thread.Sleep(2000);
                        StartNode(nodeExe, serverJs);
                        Log("node restarted #" + _restarts);
                    }
                }
            }
            catch (Exception ex)
            {
                Log("EnsureServer error: " + ex);
            }
        }

        static void StartNode(string nodeExe, string serverJs)
        {
            var psi = new ProcessStartInfo
            {
                FileName = nodeExe,
                Arguments = "\"" + serverJs + "\"",
                WorkingDirectory = Path.GetDirectoryName(serverJs),
                UseShellExecute = false,
                CreateNoWindow = true,
                WindowStyle = ProcessWindowStyle.Hidden
            };
            _nodeProc = Process.Start(psi);
            _weStartedNode = true;
        }

        static bool PingServer()
        {
            try
            {
                var req = (HttpWebRequest)WebRequest.Create("http://127.0.0.1:" + Port + "/api/ping");
                req.Timeout = 1500;
                req.Method = "GET";
                using (var resp = (HttpWebResponse)req.GetResponse())
                using (var sr = new StreamReader(resp.GetResponseStream(), Encoding.UTF8))
                {
                    var body = sr.ReadToEnd();
                    return body.IndexOf("\"app\":\"DeviceKeeper\"") >= 0;
                }
            }
            catch { return false; }
        }

        static string ReadToken()
        {
            try
            {
                return File.ReadAllText(Path.Combine(DataDir, "token")).Trim();
            }
            catch { return ""; }
        }

        static void OpenUI()
        {
            var token = ReadToken();
            var url = "http://127.0.0.1:" + Port;
            if (token.Length > 0) url += "/?token=" + Uri.EscapeDataString(token);
            try { Process.Start(new ProcessStartInfo(url) { UseShellExecute = true }); }
            catch (Exception ex) { ShowError("打开浏览器失败:" + ex.Message); }
        }

        static void ShowError(string msg)
        {
            try
            {
                _tray.BalloonTipTitle = "DeviceKeeper";
                _tray.BalloonTipText = msg;
                _tray.BalloonTipIcon = ToolTipIcon.Error;
                _tray.ShowBalloonTip(3000);
            }
            catch { }
            Log("ERROR: " + msg);
        }

        static void ExitApp()
        {
            _weStartedNode = false;
            try { if (_nodeProc != null && !_nodeProc.HasExited) _nodeProc.Kill(); }
            catch { }
            try { _tray.Visible = false; _tray.Dispose(); }
            catch { }
            try { _mutex.ReleaseMutex(); }
            catch { }
            Application.Exit();
        }
    }
}

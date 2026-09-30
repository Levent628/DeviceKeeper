@echo off
rem ============================================================
rem  一键编译 DeviceKeeper.exe  (双击本文件即可)
rem  使用系统自带编译器,无需安装任何东西
rem ============================================================
cd /d "%~dp0"

set CSC=%WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe
if not exist "%CSC%" set CSC=%WINDIR%\Microsoft.NET\Framework\v4.0.30319\csc.exe
if not exist "%CSC%" (
  echo [ERROR] Compiler csc.exe not found. Please enable .NET Framework.
  pause
  exit /b 1
)

echo Compiling DeviceKeeper.exe ...
"%CSC%" /nologo /target:winexe /out:"%~dp0DeviceKeeper.exe" /win32icon:"%~dp0assets\icon.ico" /win32manifest:"%~dp0build\app.manifest" /r:System.Windows.Forms.dll /r:System.Drawing.dll "%~dp0build\tray.cs"

if errorlevel 1 (
  echo.
  echo [ERROR] Compile failed. Please screenshot this window and report.
  pause
  exit /b 1
)

echo.
echo [OK] DeviceKeeper.exe generated successfully!
echo Now double-click DeviceKeeper.exe to launch.
echo.
pause

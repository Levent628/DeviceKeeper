@echo off
rem DeviceKeeper 托盘程序编译脚本(使用系统自带 .NET Framework csc,无需安装任何 SDK)
setlocal
set CSC=%WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe
if not exist "%CSC%" set CSC=%WINDIR%\Microsoft.NET\Framework\v4.0.30319\csc.exe
if not exist "%CSC%" (
  echo [错误] 未找到系统 csc 编译器,请确认 .NET Framework 4.x 已启用
  exit /b 1
)
"%CSC%" /nologo /target:winexe ^
  /out:"%~dp0..\DeviceKeeper.exe" ^
  /win32icon:"%~dp0..\assets\icon.ico" ^
  /win32manifest:"%~dp0app.manifest" ^
  /r:System.Windows.Forms.dll /r:System.Drawing.dll ^
  "%~dp0tray.cs"
if errorlevel 1 (
  echo [错误] 编译失败
  exit /b 1
)
echo [成功] 已生成 DeviceKeeper.exe
endlocal

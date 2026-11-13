@echo off
setlocal
rem Grok runs this in the open repository. Leave that folder and stop cmd
rem searching the current folder first, so a node.bat or node.cmd there never runs.
set NoDefaultCurrentDirectoryInExePath=1
rem Move to a local system folder: unlike pushd to a network clone, it maps no
rem drive letter that a killed run would leave behind. If it fails, stop here.
cd /d "%SystemRoot%\System32" || exit /b 1
node "%~dp0statusline.mjs"
exit /b %errorlevel%

@echo off
setlocal
rem Grok runs this in the open repository. Leave that folder and stop cmd
rem searching the current folder first, so a node.bat or node.cmd there never runs.
set NoDefaultCurrentDirectoryInExePath=1
cd /d "%~dp0"
node "%~dp0statusline.mjs"

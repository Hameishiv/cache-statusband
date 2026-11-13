@echo off
setlocal
rem Grok runs this in the open repository. Leave that folder and stop cmd
rem searching the current folder first, so a node.bat or node.cmd there never runs.
set NoDefaultCurrentDirectoryInExePath=1
rem pushd also works from a network path; if it fails, stop rather than run from here.
pushd "%~dp0" || exit /b 1
node "%~dp0statusline.mjs"

@echo off
chcp 65001 >nul
title CST.,JSC - Trang va Admin
cd /d "%~dp0"
python admin\server.py --open
if errorlevel 1 pause

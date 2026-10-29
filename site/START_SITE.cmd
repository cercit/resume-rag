@echo off
cd /d "%~dp0"
echo Resume Tailor
echo Open http://127.0.0.1:4173 in your browser.
echo Keep this window open while using the site. Press Ctrl+C to stop.
start "" "http://127.0.0.1:4173"
python -m http.server 4173 --bind 127.0.0.1
pause

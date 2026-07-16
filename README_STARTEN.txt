START LOKAL:
1. Terminal in diesem Ordner öffnen.
2. npm install
3. npm start
4. Im Browser öffnen: http://localhost:4173

EVENTS ÄNDERN:
- event.json ändern
- Browser refreshen
- Anzeige wird direkt neu aus JSON gelesen

VIDEO:
- Datei muss exakt aftermovie.mp4 heißen
- Datei muss direkt neben index.html liegen, nicht in einem Unterordner
- Der Server unterstützt jetzt Byte-Range Requests, damit Safari/Chrome MP4-Dateien sauber laden.

ZWEITES MAL STARTEN:
- Läuft der Server noch: nichts neu starten, nur Browser refreshen.
- Neu starten: im Terminal CTRL + C drücken, danach wieder npm start.
- Falls Port blockiert ist: lsof -ti:4173 | xargs kill -9

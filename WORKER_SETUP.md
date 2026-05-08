# Worker-Setup – Schritt für Schritt

Einmalige Einrichtung des `germania-notion-sync`-Workers, damit das Dashboard live aus Notion liest.

## 1. Wrangler-Cache räumen (Trash-Permission-Bug fixen)

```bash
sudo rm -rf ~/Library/Preferences/.wrangler/cache
sudo rm -rf ~/Library/Caches/wrangler
```

## 2. Notion-Internal-Integration anlegen

1. Browser auf <https://www.notion.so/my-integrations>
2. **„+ New integration"**
3. **Name:** `Germania Bambini Read`
4. **Associated workspace:** Andis Workspace
5. **Type:** `Internal`
6. **Capabilities:** nur **Read content** (Read user info ist OK, schreiben NICHT nötig)
7. Speichern → **Token kopieren** (beginnt mit `ntn_…`). Der erscheint nur einmal!

## 3. Integration mit den 3 Datenbanken verbinden

In Notion zu jeder DB navigieren (oder zur Eltern-Page), dann oben rechts auf **„•••" → „Connections" → „+ Connect to" → Germania Bambini Read** auswählen:

- **Trainingshistorie** (`https://www.notion.so/9467a2c9c52e49f2b2096471944ea105`)
- **Spieler** (`https://www.notion.so/e740590b1f1a42f48cf9df67123db23c`)
- **Übungsbibliothek** (`https://www.notion.so/6041118a4ed44340b54e02a29e3bde41`)

(Wenn alle drei unter einer gemeinsamen Eltern-Page liegen, reicht es die einmal dort zu connecten – die Verbindung vererbt sich.)

## 4. Wrangler einrichten

```bash
cd ~/germania-deploy
# wrangler.toml liegt schon im Repo (gerade gepusht)
wrangler login   # öffnet Browser, einmal Cloudflare-Account autorisieren
```

## 5. Secrets setzen

```bash
cd ~/germania-deploy
wrangler secret put NOTION_TOKEN
# → bei der Aufforderung: ntn_… (Token aus Schritt 2) einfügen, Enter

wrangler secret put SYNC_SECRET
# → irgendwas Eigenes, z.B. "germania-sync-2026", Enter
```

## 6. Deploy

```bash
cd ~/germania-deploy
wrangler deploy
```

**Output enthält die URL!** Etwas wie:
```
https://germania-notion-sync.<dein-account>.workers.dev
```

→ **Diese URL mir schicken.** Ich tausche sie im Dashboard ein und deploye nochmal. Ab dann zieht das Dashboard live aus Notion.

## 7. Testen

Im Browser (oder per curl):
```
https://germania-notion-sync.<dein-account>.workers.dev/health
```
sollte zurückgeben:
```json
{ "status": "ok", "service": "germania-notion-sync" }
```

Und der eigentliche Test:
```
https://germania-notion-sync.<dein-account>.workers.dev/trainings
```
sollte ein JSON mit allen Trainings zurückliefern.

## Troubleshooting

- **„API token is unauthorized"** → Schritt 3 vergessen (Connect to DB)
- **Wrangler-Cache-Error** → Schritt 1 nochmal
- **CORS-Fehler im Browser** → kein Problem, Worker erlaubt `https://rb-hubs.github.io` und `localhost`

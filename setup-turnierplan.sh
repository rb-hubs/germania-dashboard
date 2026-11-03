#!/bin/bash
# Einmalige Einrichtung des zentralen Turnierplan-Speichers. Fragt nach Cloudflare-Login und Trainer-Passwort.
set -euo pipefail
cd "$(dirname "$0")"
W="npx -y wrangler@3"; C="wrangler.turnierplan.toml"; TOKEN_FILE="$HOME/.ava/germania-turnier-token"

$W whoami 2>/dev/null | grep -q 'You are logged in' || $W login
if grep -q KV_ID_EINTRAGEN "$C"; then
  ID=$($W kv:namespace create TURNIERPLAN -c "$C" | grep -oE '[0-9a-f]{32}' | head -1)
  [ -n "$ID" ] || { echo "KV-Speicher konnte nicht angelegt werden"; exit 1; }
  sed -i '' "s/KV_ID_EINTRAGEN/$ID/" "$C"
fi
$W deploy -c "$C"

echo; echo "Trainer-Passwort festlegen (wird beim Tippen nicht angezeigt):"
$W secret put TURNIER_PASSWORT -c "$C"

mkdir -p "$HOME/.ava"; [ -s "$TOKEN_FILE" ] || { (umask 077; openssl rand -hex 32 > "$TOKEN_FILE"); }
$W secret put TURNIER_AGENT_TOKEN -c "$C" < "$TOKEN_FILE"
echo; echo "Fertig. Du kannst dieses Fenster schliessen."

#!/usr/bin/env bash
# One-time probe: PowerFlex Manager 4.x API paths vary by deployment. This
# script tries the candidate login endpoints, then dumps candidate Resources
# endpoints so you can identify the working pair and the field holding the
# iDRAC management IP. Enter the working values in Settings > Advanced API
# paths — no image rebuild needed.
# Usage: ./probe-powerflex.sh https://pfxmgr.example.com [username] [password]
set -euo pipefail

PFURL="${1:?Usage: $0 https://pfxmgr.example.com [username] [password]}"
USER="${2:-${PF_USER:-}}"
PASS="${3:-${PF_PASSWORD:-}}"
if [ -z "$USER" ] || [ -z "$PASS" ]; then
  echo "Provide username and password as arguments or via PF_USER / PF_PASSWORD." >&2
  exit 1
fi
PFURL="${PFURL%/}"

LOGIN_PATHS=("/rest/login" "/rest/auth/login" "/Api/V1/Authenticate")
TOKEN=""
USED_LOGIN=""
for p in "${LOGIN_PATHS[@]}"; do
  echo "== Trying login: $p =="
  RESP=$(curl -sk --max-time 15 -X POST -H 'Content-Type: application/json' \
    -d "{\"username\":\"$USER\",\"password\":\"$PASS\"}" "$PFURL$p" || true)
  TOKEN=$(echo "$RESP" | python3 -c 'import json,sys
try:
    d = json.load(sys.stdin)
    print(d.get("access_token") or d.get("accessToken") or d.get("token") or "")
except Exception:
    print("")')
  if [ -n "$TOKEN" ]; then
    USED_LOGIN="$p"
    echo "  -> logged in via $p"
    break
  fi
  echo "  -> no token in response: $(echo "$RESP" | head -c 300)"
done
if [ -z "$TOKEN" ]; then
  echo "Could not authenticate against any candidate login path." >&2
  exit 1
fi

RESOURCES_PATHS=("/rest/api/v1/resources" "/rest/resources" "/rest/api/v1/inventory")
for p in "${RESOURCES_PATHS[@]}"; do
  echo
  echo "== Trying resources: $p =="
  RESP=$(curl -sk --max-time 15 -H "Authorization: Bearer $TOKEN" "$PFURL$p" || true)
  echo "$RESP" | python3 -c 'import json,sys
try:
    d = json.load(sys.stdin)
except Exception:
    print("  non-JSON response:", sys.stdin.read()[:300] or "(empty)"); raise SystemExit
items = d.get("items") or d.get("Resources") or d.get("resources") or (d if isinstance(d, list) else [])
print(f"  {len(items)} entries")
for it in items[:3]:
    keys = [k for k in it if any(t in k.lower() for t in ("ip", "tag", "name", "serial"))]
    print("   ", {k: it[k] for k in keys})' || echo "  (no parseable JSON)"
done

echo
echo "If a login+resources pair worked above, enter them in Settings > Advanced"
echo "API paths (login: $USED_LOGIN). If none worked, capture the real paths"
echo "from the appliance's web UI network traffic (browser devtools) and enter"
echo "those — the app only needs a JSON login returning a token and a JSON"
echo "resource list with a management-IP field."

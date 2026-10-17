#!/usr/bin/env bash
# One-time probe: dumps the authenticated Redfish System resource so the exact
# field holding the iDRAC "System Location" string can be identified.
# Usage: ./probe.sh [host]
set -euo pipefail
cd "$(dirname "$0")"

if [ ! -f .env ]; then
  echo "Create .env first (copy .env.example and fill in the password)." >&2
  exit 1
fi
set -a; . ./.env; set +a

HOST="${1:-idrac1.example.com}"
COLLECTION=$(curl -sk -u "$IDRAC_USER:$IDRAC_PASSWORD" "https://$HOST/redfish/v1/Systems")

echo "== Systems collection on $HOST =="
echo "$COLLECTION" | python3 -m json.tool

for id in $(echo "$COLLECTION" | python3 -c 'import json,sys; [print(m["@odata.id"]) for m in json.load(sys.stdin).get("Members", [])]'); do
  echo
  echo "== $id =="
  curl -sk -u "$IDRAC_USER:$IDRAC_PASSWORD" "https://$HOST$id" | python3 -m json.tool
done

echo
echo "== DellAttributes (System.Embedded.1) =="
curl -sk -u "$IDRAC_USER:$IDRAC_PASSWORD" "https://$HOST/redfish/v1/Managers/iDRAC.Embedded.1/Oem/Dell/DellAttributes/System.Embedded.1" \
  | python3 -c 'import json,sys; a=json.load(sys.stdin).get("Attributes",{}); print(json.dumps({k:v for k,v in a.items() if "SysLocation" in k or "ServerType" in k}, indent=1))'

CHASSIS=$(curl -sk -u "$IDRAC_USER:$IDRAC_PASSWORD" "https://$HOST/redfish/v1/Chassis")
for id in $(echo "$CHASSIS" | python3 -c 'import json,sys; [print(m["@odata.id"]) for m in json.load(sys.stdin).get("Members", [])]'); do
  echo
  echo "== $id =="
  curl -sk -u "$IDRAC_USER:$IDRAC_PASSWORD" "https://$HOST$id" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(json.dumps({"Model": d.get("Model"), "AssetTag": d.get("AssetTag"), "Location": d.get("Location")}, indent=1))'
done

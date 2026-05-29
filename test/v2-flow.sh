#!/usr/bin/env bash
# Walk the full Docker Registry v2 pull flow through the proxy, against REAL
# Docker Hub. Proves feasibility without needing docker installed: curl speaks
# the same HTTP API the docker daemon uses.
#
#   BASE=http://localhost:8787 bash test/v2-flow.sh
set -uo pipefail

BASE="${BASE:-http://localhost:8787}"
IMAGE="${IMAGE:-library/hello-world}"
REF="${REF:-latest}"
TMP="$(mktemp -d)"
pass=0; fail=0

ok()   { printf "  \033[32mPASS\033[0m %s\n" "$1"; pass=$((pass+1)); }
no()   { printf "  \033[31mFAIL\033[0m %s\n" "$1"; fail=$((fail+1)); }
hdr()  { printf "\n\033[1m%s\033[0m\n" "$1"; }

hdr "1) GET /v2/  -> 401 with realm rewritten to the proxy"
resp="$(curl -sS -i "$BASE/v2/")"
code="$(printf '%s' "$resp" | head -1 | awk '{print $2}')"
realm="$(printf '%s' "$resp" | tr -d '\r' | grep -i '^www-authenticate:' | head -1 || true)"
[ "$code" = "401" ] && ok "status 401" || no "status was '$code' (want 401)"
case "$realm" in
  *"$BASE/v2/auth"*) ok "realm points back to proxy: $realm" ;;
  *) no "realm not rewritten: $realm" ;;
esac
# Derive the token `service` from the (rewritten) challenge so the test works
# against any upstream (Docker Hub, or a mirror like daocloud).
SERVICE="$(printf '%s' "$realm" | sed -n 's/.*service="\([^"]*\)".*/\1/p')"
[ -z "$SERVICE" ] && SERVICE="registry.docker.io"
printf "  service = %s\n" "$SERVICE"

hdr "2) GET /v2/hello-world/...  -> 301 redirect to library/ namespace"
loc="$(curl -sS -o /dev/null -w '%{http_code} %{redirect_url}' "$BASE/v2/hello-world/manifests/$REF")"
case "$loc" in
  301*library/hello-world*) ok "301 -> $loc" ;;
  *) no "expected 301 to library/hello-world, got: $loc" ;;
esac

hdr "3) GET /v2/auth  -> bearer token from auth.docker.io"
TOKEN="$(curl -sS "$BASE/v2/auth?service=$SERVICE&scope=repository:$IMAGE:pull" | jq -r '.token // .access_token // empty')"
if [ -n "$TOKEN" ]; then ok "got token (${#TOKEN} chars)"; else no "no token returned"; fi

hdr "4) GET manifest (multi-arch index) with Accept negotiation"
ACCEPT="application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.v2+json, application/vnd.oci.image.manifest.v1+json"
INDEX="$(curl -sS -H "Authorization: Bearer $TOKEN" -H "Accept: $ACCEPT" "$BASE/v2/$IMAGE/manifests/$REF")"
mt="$(printf '%s' "$INDEX" | jq -r '.mediaType // empty')"
if printf '%s' "$INDEX" | jq -e '.manifests' >/dev/null 2>&1; then
  ok "multi-arch index returned (mediaType=$mt)"
  AMD64="$(printf '%s' "$INDEX" | jq -r '.manifests[] | select(.platform.architecture=="amd64" and .platform.os=="linux") | .digest' | head -1)"
  [ -n "$AMD64" ] && ok "found linux/amd64 digest: $AMD64" || no "no amd64 manifest in index"
else
  no "expected manifest index, got: $(printf '%s' "$INDEX" | head -c 200)"
  AMD64=""
fi

hdr "5) HEAD manifest -> Docker-Content-Digest header present"
dch="$(curl -sS -I -H "Authorization: Bearer $TOKEN" -H "Accept: $ACCEPT" "$BASE/v2/$IMAGE/manifests/$REF" | tr -d '\r' | grep -i '^docker-content-digest:' || true)"
[ -n "$dch" ] && ok "$dch" || no "no Docker-Content-Digest on HEAD"

hdr "6) GET arch manifest by digest -> config + layer digests"
if [ -n "$AMD64" ]; then
  IMGM="$(curl -sS -H "Authorization: Bearer $TOKEN" -H "Accept: application/vnd.docker.distribution.manifest.v2+json, application/vnd.oci.image.manifest.v1+json" "$BASE/v2/$IMAGE/manifests/$AMD64")"
  LAYER="$(printf '%s' "$IMGM" | jq -r '.layers[0].digest // empty')"
  CONFIG="$(printf '%s' "$IMGM" | jq -r '.config.digest // empty')"
  [ -n "$LAYER" ] && ok "layer digest: $LAYER" || no "no layer digest"
  [ -n "$CONFIG" ] && ok "config digest: $CONFIG" || no "no config digest"
else
  no "skipped (no amd64 digest)"; LAYER=""; CONFIG=""
fi

hdr "7) GET blob (streamed through proxy) -> sha256 integrity check"
if [ -n "$LAYER" ]; then
  curl -sS -L -H "Authorization: Bearer $TOKEN" "$BASE/v2/$IMAGE/blobs/$LAYER" -o "$TMP/layer.blob"
  got="sha256:$(shasum -a 256 "$TMP/layer.blob" | awk '{print $1}')"
  size="$(wc -c < "$TMP/layer.blob" | tr -d ' ')"
  if [ "$got" = "$LAYER" ]; then ok "blob streamed byte-exact ($size bytes, sha256 matches digest)"
  else no "sha256 mismatch: got $got want $LAYER"; fi
else
  no "skipped (no layer digest)"
fi

rm -rf "$TMP"
hdr "RESULT"
printf "  %d passed, %d failed\n" "$pass" "$fail"
[ "$fail" -eq 0 ]

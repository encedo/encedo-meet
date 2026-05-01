#!/bin/bash
set -e

# Encedo Meet — build na serwerze i restart kontenerów
# Użycie:
#   ./deploy.sh          — build wszystkiego + restart web i encedo-host
#   ./deploy.sh jitsi    — tylko jitsi-meet (długi, ~8 min)
#   ./deploy.sh host     — tylko encedo-meet-host (krótki, ~30s)

ROOT="$(cd "$(dirname "$0")" && pwd)"
PARENT="$ROOT/.."
TARGET="${1:-all}"

build_lib() {
    echo "==> lib-jitsi-meet build..."
    cd "$PARENT/lib-jitsi-meet"
    npm ci --prefer-offline
    npm run build
}

build_jitsi() {
    echo "==> jitsi-meet build (może trwać ~8 min)..."
    cd "$PARENT/jitsi-meet"
    npm ci --prefer-offline
    make LIBJITSIMEET_DIR="$PARENT/lib-jitsi-meet" compile deploy
}

build_host() {
    echo "==> encedo-meet-host build..."
    cd "$ROOT"
    npm ci --prefer-offline
    npm run build
}

cd "$ROOT"

case "$TARGET" in
    jitsi)
        build_lib
        build_jitsi
        cd "$ROOT"
        docker compose restart web
        ;;
    host)
        build_host
        cd "$ROOT"
        docker compose restart encedo-host
        ;;
    all)
        build_lib
        build_jitsi
        build_host
        cd "$ROOT"
        docker compose restart web encedo-host
        ;;
    *)
        echo "Użycie: $0 [jitsi|host|all]"
        exit 1
        ;;
esac

echo "==> Gotowe."
cd "$ROOT"
docker compose ps web encedo-host

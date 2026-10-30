#!/usr/bin/env bash
set -euo pipefail
release_checkout="$HOME/.cache/opensensor-hosting/saleor-app-release"
if [[ ! -d "$release_checkout/.git" ]]; then
    git clone --branch main --single-branch https://github.com/matteius/saleor-apps.git "$release_checkout"
fi
git -C "$release_checkout" fetch origin main
git -C "$release_checkout" merge --ff-only origin/main
agent="$release_checkout/scripts/hosting_release.py"
[[ -f "$agent" ]] || exit 0
failed=0
for release_app in stripe fief smtp; do
    RELEASE_APP="$release_app" /usr/bin/python3 "$agent" --apply || failed=1
done
exit "$failed"

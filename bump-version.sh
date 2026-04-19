#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
JS_DIR="$ROOT_DIR/asun-js"
PACKAGE_JSON="$JS_DIR/package.json"
PACKAGE_LOCK="$JS_DIR/package-lock.json"

usage() {
  cat <<'EOF'
Usage:
  ./bump-version.sh 1.0.4

Update the JS package version in:
  - asun-js/package.json
  - asun-js/package-lock.json
EOF
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

if [[ $# -ne 1 ]]; then
  usage >&2
  exit 1
fi

RAW_VERSION="$1"
VERSION="${RAW_VERSION#v}"

if [[ ! "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  printf 'Invalid version: %s\n' "$RAW_VERSION" >&2
  printf 'Expected semver like 1.0.4 or v1.0.4\n' >&2
  exit 1
fi

if [[ ! -f "$PACKAGE_JSON" || ! -f "$PACKAGE_LOCK" ]]; then
  printf 'asun-js package files not found under %s\n' "$JS_DIR" >&2
  exit 1
fi

python3 - "$PACKAGE_JSON" "$PACKAGE_LOCK" "$VERSION" <<'PY'
import json
import pathlib
import sys

package_json = pathlib.Path(sys.argv[1])
package_lock = pathlib.Path(sys.argv[2])
version = sys.argv[3]

def update_json(path: pathlib.Path, updater):
    data = json.loads(path.read_text())
    updater(data)
    path.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n")

update_json(package_json, lambda data: data.__setitem__("version", version))

def update_lock(data):
    data["version"] = version
    packages = data.get("packages", {})
    root = packages.get("")
    if isinstance(root, dict):
        root["version"] = version

update_json(package_lock, update_lock)
PY

git tag -f "$VERSION"
git push -f origin "$VERSION"

printf 'Updated asun-js version to %s\n' "$VERSION"
printf '  - %s\n' "asun-js/package.json"
printf '  - %s\n' "asun-js/package-lock.json"

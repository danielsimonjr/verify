#!/usr/bin/env bash
# Copyright 2026 The VeriHarness Authors.
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.
# Install a pinned pi into harness/vendor (self-contained; no global state).
set -euo pipefail

PI_VERSION="${PI_VERSION:-0.84.4}"
# PI_SPEC overrides the whole install spec, for example a local .tgz made with `npm pack`.
PI_SPEC="${PI_SPEC:-@danielsimonjr/pi@${PI_VERSION}}"
VENDOR_DIR="$(cd "$(dirname "$0")/.." && pwd)/vendor"

mkdir -p "$VENDOR_DIR"
cd "$VENDOR_DIR"
[ -f package.json ] || npm init -y >/dev/null
npm install --no-fund --no-audit --save-exact "${PI_SPEC}"

PI_BIN="$VENDOR_DIR/node_modules/.bin/pi"
"$PI_BIN" --version
echo "pi ready at: $PI_BIN"

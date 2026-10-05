#!/bin/bash
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
#
# Mount-namespace jail for verifier runs. Without it an agent can walk out of its
# workspace and read archived grades, sibling runs or the benchmark answer keys.
#
# Visible inside the jail, at their real paths:
#   - the task workspace (rw; spec/, workspace/ and rollouts/ are remounted ro)
#   - ~/.config/gcloud              (cloud credentials for the model provider)
#   - harness/vendor, harness/pi-home, harness/skills
#   - $VERIHARNESS_DATA/_worlds     (shared environment stores, ro)
#   - ~/.cache/ms-playwright        (an installed headless browser, ro, if present)
# The host Python (task pytest / patch lab) and Node (skill CLIs, pi) stay visible
# but read-only: a verifier that pip- or npm-installs a candidate would otherwise
# redirect imports for every other task on the machine. A prefix of /usr is left as
# it is: it is owned by root, which the jail cannot write.
# Everything else under $HOME, the data root, /tmp and /var/tmp is covered by tmpfs,
# and so is every directory listed in $VERIHARNESS_JAIL_HIDE (newline-separated
# absolute paths: the driver lists the run outputs and the benchmark checkout).
# There is no network namespace: the local model proxy and provider egress keep working.
#
# The command runs with no capabilities and no_new_privs (setpriv). `unshare -r` makes the
# caller root inside the new user namespace, and that root may unmount the tmpfs covers
# and remount the read-only binds the script has just made. Dropping the capabilities
# after the last mount is what makes the covers and the read-only binds hold.
#
# The workspace and the harness must not be under /tmp: the jail covers /tmp last, after
# it has mounted them, so they would disappear. The script refuses such a path.
#
# Needs util-linux unshare (with --kill-child) and setpriv.
#
# Usage: jail_run.sh <ws_dir> <cmd...>    (cmd runs with cwd=<ws_dir>)
set -euo pipefail

if [ "$#" -lt 2 ]; then
  echo "usage: jail_run.sh <ws_dir> <cmd...>" >&2
  exit 2
fi
WS_REAL="$(realpath "$1")"; shift

HARNESS_REAL="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
DATA_REAL="$(realpath -m "${VERIHARNESS_DATA:-$HARNESS_REAL/../data}")"

for p in "$WS_REAL" "$HARNESS_REAL"; do
  case "$p/" in
    /tmp/*)
      echo "jail_run.sh: $p is under /tmp, which the jail hides; use a directory outside /tmp" >&2
      exit 2 ;;
  esac
done

if ! command -v setpriv >/dev/null 2>&1; then
  echo "jail_run.sh: setpriv (util-linux) is required to drop the session's capabilities" >&2
  exit 127
fi

PY_PREFIX="$(python3 -c 'import sys; print(sys.prefix)' 2>/dev/null || true)"
# <prefix>/bin/node -> <prefix>
NODE_PREFIX=""
if NODE_BIN="$(command -v node)"; then
  NODE_PREFIX="$(dirname "$(dirname "$(realpath "$NODE_BIN")")")" || NODE_PREFIX=""
fi

exec unshare -r -m -p -f --mount-proc --kill-child /bin/bash -s "$WS_REAL" "$HARNESS_REAL" "$DATA_REAL" "$PY_PREFIX" "$NODE_PREFIX" "$@" <<'JAIL'
set -euo pipefail
WS="$1"; HARNESS="$2"; DATA="$3"; PY_PREFIX="$4"; NODE_PREFIX="$5"; shift 5
H="$HOME"
S=/tmp/vh_stage

# A read-only remount is best effort: some hosts refuse it. Say so, rather than leave a
# mount writable without a word.
ro() {
  mount -o remount,bind,ro "$1" 2>/dev/null || echo "jail_run.sh: warning: $1 could not be made read-only" >&2
}

HIDE=()
while IFS= read -r d; do
  case "$d" in /*) HIDE+=("$d") ;; esac
done <<< "${VERIHARNESS_JAIL_HIDE:-}"

mkdir -p "$S"
mount -t tmpfs tmpfs "$S"
WORLDS="$DATA/_worlds"
mkdir -p "$S/ws" "$S/gcloud" "$S/vendor" "$S/pihome" "$S/skills" "$S/worlds" "$S/browsers"
HAVE_BROWSERS=0
if [ -d "$H/.cache/ms-playwright" ]; then mount --rbind "$H/.cache/ms-playwright" "$S/browsers"; HAVE_BROWSERS=1; fi
mount --rbind "$WS" "$S/ws"
HAVE_WORLDS=0
if [ -d "$WORLDS" ]; then mount --rbind "$WORLDS" "$S/worlds"; HAVE_WORLDS=1; fi
HAVE_GCLOUD=0
if [ -d "$H/.config/gcloud" ]; then mount --rbind "$H/.config/gcloud" "$S/gcloud"; HAVE_GCLOUD=1; fi
mount --rbind "$HARNESS/vendor" "$S/vendor"
mount --rbind "$HARNESS/pi-home" "$S/pihome"
mount --rbind "$HARNESS/skills" "$S/skills"

mount -t tmpfs tmpfs "$H"
mount -t tmpfs tmpfs /var/tmp
# A repo, data root, run directory or benchmark checkout outside $HOME is not hidden by the
# tmpfs above: cover each one too. "/" is never covered.
for d in "$(dirname "$HARNESS")" "$DATA" ${HIDE[@]+"${HIDE[@]}"}; do
  case "$d/" in "$H"/*|/var/tmp/*|//) ;; *) [ -d "$d" ] && mount -t tmpfs tmpfs "$d" ;; esac
done
mkdir -p "$HARNESS/vendor" "$HARNESS/pi-home" "$HARNESS/skills" "$WS"
if [ "$HAVE_GCLOUD" = 1 ]; then
  mkdir -p "$H/.config/gcloud"
  mount --rbind "$S/gcloud" "$H/.config/gcloud"
  ro "$H/.config/gcloud"
fi
mount --rbind "$S/vendor" "$HARNESS/vendor"
mount --rbind "$S/pihome" "$HARNESS/pi-home"
mount --rbind "$S/skills" "$HARNESS/skills"
# Skills and the agent runtime are shared by every task: a verifier must not edit them in place.
for d in "$HARNESS/skills" "$HARNESS/vendor"; do ro "$d"; done
mount --rbind "$S/ws" "$WS"
# Shared environment stores (apex worlds, wb repos): visible read-only at their real path so
# workspace/world symlinks resolve; nothing else under data/ is exposed.
if [ "$HAVE_WORLDS" = 1 ]; then
  mkdir -p "$WORLDS"
  mount --rbind "$S/worlds" "$WORLDS"
  mount -o remount,bind,ro "$WORLDS"
fi
if [ "$HAVE_BROWSERS" = 1 ]; then
  mkdir -p "$H/.cache/ms-playwright"
  mount --rbind "$S/browsers" "$H/.cache/ms-playwright"
  ro "$H/.cache/ms-playwright"
fi
umount -l "$S"
mount -t tmpfs tmpfs /tmp

# Evidence is read-only: spec/, workspace/, rollouts/ cannot be
# altered by the verifier; out/ and the rest of the task dir stay writable.
for d in spec workspace rollouts; do
  if [ -d "$WS/$d" ]; then
    mount --bind "$WS/$d" "$WS/$d"
    mount -o remount,bind,ro "$WS/$d"
  fi
done

# No container runtime from inside the jail: the daemon would be a root-equivalent
# escape (arbitrary host mounts) and a side channel to benchmark/grading images. The
# rootless sockets live under /run/user. A socket that cannot be masked stays usable,
# so failing to mask one stops the jail.
for sock in /run/docker.sock /var/run/docker.sock /run/podman/podman.sock /run/containerd/containerd.sock \
  /run/user/*/docker.sock /run/user/*/podman/podman.sock; do
  [ -e "$sock" ] || continue
  mount --bind /dev/null "$sock" || { echo "jail_run.sh: cannot mask $sock; refusing to run with a container runtime reachable" >&2; exit 1; }
done
for bin in /usr/bin/docker /usr/local/bin/docker /usr/bin/podman /usr/bin/nerdctl; do
  [ -e "$bin" ] && mount --bind /dev/null "$bin" 2>/dev/null || true
done

# Interpreters are shared with the host and with every other task: read-only, and no
# installs. Test plugins that reseed or cache across runs are disabled for repeatability.
for prefix in "$PY_PREFIX" "$NODE_PREFIX"; do
  case "$prefix" in /usr|/|"") ;; *)
    if [ -d "$prefix" ]; then
      if mount --rbind "$prefix" "$prefix" 2>/dev/null; then
        ro "$prefix"
      else
        echo "jail_run.sh: warning: $prefix could not be bound, so it is not read-only" >&2
      fi
    fi ;;
  esac
done
# A copy of the task's own project installed on the machine would shadow the candidates
# (and leak a later version of it): hide any site-packages entry that shares a top-level
# name with a directory of the task inputs.
if [ -d "$WS/workspace" ] && [ -n "$PY_PREFIX" ]; then
  for sp in "$PY_PREFIX"/lib/python3*/site-packages; do
    [ -d "$sp" ] || continue
    for name in $(find -L "$WS/workspace" -maxdepth 3 -mindepth 1 -type d -printf '%f\n' 2>/dev/null | sort -u); do
      case "$name" in .*|__pycache__|src|tests|test|docs|lib|bin) continue;; esac
      for hit in "$sp/$name" "$sp/$name.py" "$sp"/"$name"-*.dist-info "$sp"/"$name".egg-link "$sp"/__editable__."$name"-*; do
        [ -e "$hit" ] || continue
        if [ -d "$hit" ]; then mount -t tmpfs -o size=1k tmpfs "$hit" 2>/dev/null; else mount --bind /dev/null "$hit" 2>/dev/null; fi
      done
    done
  done
fi
export PIP_NO_INPUT=1 PYTHONNOUSERSITE=1 PYTHONDONTWRITEBYTECODE=1
export PYTEST_ADDOPTS="${PYTEST_ADDOPTS:--p no:randomly -p no:cacheprovider}"

# Last step: no more mounts after this. The command gets no capabilities, so it cannot
# unmount a cover or remount a read-only bind, and no_new_privs stops a setuid binary from
# regaining any.
cd "$WS"
exec setpriv --bounding-set=-all --inh-caps=-all --no-new-privs -- "$@"
JAIL

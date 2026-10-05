#!/bin/bash
# Runs harness/scripts/jail_run.sh on the real kernel and fails when a cover or a read-only bind
# does not hold. The unit tests fake the host; only a real mount namespace shows whether
# `unshare -r` root could undo the jail's mounts.
#
#   bash tests/jail/check.sh
#
# Needs Linux, util-linux unshare and setpriv, and unprivileged user namespaces. On an Ubuntu
# 24.04 runner they need  sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0 .
#
# 1. The JAIL run: probe.sh runs inside the jail and must see
#      read_host_secret=no  write_workspace=yes  write_spec=no  write_rollouts=no
#      write_skills=no  write_vendor=no  remount_spec_rw=no  umount_cover=no
#      reach_docker_socket=no  capeff=0000000000000000  nnp=1
# 2. The CONTROL run: the same probe in a bare mount namespace that has a read-only bind and a
#    cover but keeps its capabilities. It must report the escapes (remount_spec_rw=yes,
#    umount_cover=yes, a non-zero capeff, nnp=0). If it does not, the probe cannot tell a broken
#    jail from a sound one and a green jail run would mean nothing.
set -uo pipefail

if [ "$(uname -s)" != "Linux" ]; then
  echo "check.sh: the jail needs Linux" >&2
  exit 2
fi
for tool in unshare setpriv; do
  command -v "$tool" >/dev/null 2>&1 || { echo "check.sh: $tool (util-linux) is required" >&2; exit 2; }
done

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
JAIL="$REPO/harness/scripts/jail_run.sh"
# The workspace and the harness must not be under /tmp, which the jail covers last; $HOME is outside it.
WS="$(mktemp -d "$HOME/vh-jail-ws.XXXXXX")"
SECRET="$(mktemp "$HOME/vh-jail-secret.XXXXXX")"
OUT="$(mktemp "$HOME/vh-jail-out.XXXXXX")"
MADE_DIRS=()
cleanup() {
  rm -rf "$WS" "$SECRET" "$OUT"
  # A mount that is still there when the namespace ends leaves nothing behind; only the made dirs do.
  for d in "${MADE_DIRS[@]+"${MADE_DIRS[@]}"}"; do rmdir "$d" 2>/dev/null || true; done
}
trap cleanup EXIT

# harness/vendor is not in git, and the jail binds it.
for d in "$REPO/harness/vendor" "$REPO/harness/pi-home"; do
  [ -d "$d" ] || { mkdir -p "$d"; MADE_DIRS+=("$d"); }
done
mkdir -p "$WS/spec" "$WS/workspace" "$WS/rollouts"
echo "host secret" > "$SECRET"
cp "$REPO/tests/jail/probe.sh" "$WS/probe.sh"

PROBE_ARGS=("$SECRET" "$HOME" "$REPO/harness/skills" "$REPO/harness/vendor")
failed=0

# expect <file> <key> <value>
expect() {
  local got
  got="$(grep -m1 "^$2=" "$1" | cut -d= -f2-)"
  if [ "$got" = "$3" ]; then
    printf '  ok    %-22s %s\n' "$2" "$got"
  else
    printf '  FAIL  %-22s got "%s", want "%s"\n' "$2" "$got" "$3"
    failed=1
  fi
}

echo "== jail: harness/scripts/jail_run.sh"
if ! "$JAIL" "$WS" bash "$WS/probe.sh" "${PROBE_ARGS[@]}" >"$OUT" 2>"$OUT.err"; then
  echo "  FAIL  the jail did not run the probe:"
  sed 's/^/        /' "$OUT.err"
  rm -f "$OUT.err"
  exit 1
fi
cat "$OUT.err" >&2
rm -f "$OUT.err"
expect "$OUT" read_host_secret no
expect "$OUT" write_workspace yes
expect "$OUT" write_spec no
expect "$OUT" write_rollouts no
expect "$OUT" write_skills no
expect "$OUT" write_vendor no
expect "$OUT" remount_spec_rw no
expect "$OUT" umount_cover no
expect "$OUT" reach_docker_socket no
expect "$OUT" capeff 0000000000000000
expect "$OUT" nnp 1

echo "== control: the same probe in a mount namespace that keeps its capabilities"
rm -rf "$WS/out.txt" "$WS/spec/probe.txt" "$WS/rollouts/probe.txt"
mkdir -p "$WS/cover"
if ! unshare -r -m bash -c '
  set -e
  ws="$1"; shift
  mount --bind "$ws/spec" "$ws/spec"
  mount -o remount,bind,ro "$ws/spec"
  mount -t tmpfs tmpfs "$ws/cover"
  cd "$ws"
  exec bash "$ws/probe.sh" "$1" "$ws/cover" "$3" "$4"
' control "$WS" "${PROBE_ARGS[@]}" >"$OUT" 2>"$OUT.err"; then
  echo "  FAIL  the control namespace did not run the probe:"
  sed 's/^/        /' "$OUT.err"
  rm -f "$OUT.err"
  exit 1
fi
rm -f "$OUT.err"
expect "$OUT" write_spec no
expect "$OUT" remount_spec_rw yes
expect "$OUT" umount_cover yes
expect "$OUT" nnp 0
if [ "$(grep -m1 '^capeff=' "$OUT" | cut -d= -f2-)" = "0000000000000000" ]; then
  echo "  FAIL  capeff               the control kept no capabilities, so it proves nothing"
  failed=1
else
  printf '  ok    %-22s %s\n' capeff "$(grep -m1 '^capeff=' "$OUT" | cut -d= -f2-)"
fi

if [ "$failed" -ne 0 ]; then
  echo "jail check FAILED"
  exit 1
fi
echo "jail check passed"

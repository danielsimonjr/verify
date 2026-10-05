#!/bin/bash
# Runs INSIDE the jail (or inside the weakened control jail of check.sh) and prints one
# key=value line per question. It decides nothing: check.sh compares the answers.
#
# usage: probe.sh <host-secret-file> <cover-dir> <skills-dir> <vendor-dir>
#   cwd is the task workspace, which holds spec/ workspace/ rollouts/.
#
# The <host-secret-file> sits under $HOME outside the workspace; the jail covers $HOME with a tmpfs.
# <cover-dir> is a directory that the jail covered; a process that kept CAP_SYS_ADMIN could
# unmount it.
secret="$1"
cover="$2"
skills="$3"
vendor="$4"

# yes when the command succeeds, no when it fails; the command's own output is dropped.
r() {
  if eval "$2" >/dev/null 2>&1; then echo "$1=yes"; else echo "$1=no"; fi
}

r read_host_secret 'cat "$secret"'
# The task root stays writable (the verdict is written there); the evidence dirs do not.
r write_task_root 'echo hi > "$PWD/out.txt"'
r write_workspace_dir 'echo x > "$PWD/workspace/probe.txt"'
r write_spec 'echo x > "$PWD/spec/probe.txt"'
r write_rollouts 'echo x > "$PWD/rollouts/probe.txt"'
r write_skills 'echo x > "$skills/probe.txt"'
r write_vendor 'echo x > "$vendor/probe.txt"'
# A read-only bind holds only if the caller cannot remount it read-write.
r remount_spec_rw 'mount -o remount,bind,rw "$PWD/spec"'
# A cover holds only if the caller cannot unmount it.
r umount_cover 'umount -l "$cover"'
r reach_docker_socket '[ -S /var/run/docker.sock ] || [ -S /run/docker.sock ]'
echo "capeff=$(awk '/^CapEff/{print $2}' /proc/self/status)"
echo "nnp=$(awk '/^NoNewPrivs/{print $2}' /proc/self/status)"

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
"""Native execution environments for the adjudication and delivery turns (optional).

By default every turn runs in the mount-namespace jail on the host. With `--env native`
the adjudication and delivery turns run instead inside a fresh container of the
benchmark's own task image, so the verifier revises the artifact with the same
interpreter, libraries and tools the rollouts were produced with. The two
investigations stay in the jail.

The container sees the task directory at its real path (spec/, workspace/ and
rollouts/ read-only, the rest writable), the pi runtime and skills read-only, and
shares the host network so the model endpoints stay reachable (the same exposure the
jail has). Everything else of the host is absent. Images per benchmark:

    wb    <data>/_worlds/wb/<task>/.exported names the task's own environment image
    sb2   VERIHARNESS_IMAGE_SB2  (default veriharness-office: harness/env/Dockerfile.office)
    jb    VERIHARNESS_IMAGE_JB   (default veriharness-office: LibreOffice + document libraries)
    wsb   VERIHARNESS_IMAGE_WSB  (default workspace-bench:local)
    apex  VERIHARNESS_IMAGE_APEX (default veriharness-docs: harness/env/Dockerfile.apex; the world files
          are mounted read-only under the data root, as in the jail)
"""

import json
import os
from pathlib import Path
import subprocess
import uuid

from harness import config

NODE = (
    config.HARNESS_DIR / "vendor" / "node-v22" / "bin"
)  # self-contained Node for the pi runtime
DEFAULT_IMAGES = {
    "sb2": "veriharness-office",
    "jb": "veriharness-office",
    "wsb": "workspace-bench:local",
    "apex": "veriharness-docs",
}


def docker_available() -> bool:
  try:
    return (
        subprocess.run(
            ["docker", "info"], capture_output=True, timeout=30
        ).returncode
        == 0
    )
  except (OSError, subprocess.TimeoutExpired):
    return False


def image_for(ws: Path) -> str | None:
  """The task image for a materialized task directory, or None when there is none or when
  docker is not usable on this host (the caller then keeps the jail)."""
  if not docker_available():
    return None
  bench = ws.parent.name.rsplit("_", 1)[0]
  override = os.environ.get(f"VERIHARNESS_IMAGE_{bench.upper()}")
  if override:
    return override
  if bench == "wb":
    marker = (
        config.DATA
        / "_worlds"
        / "wb"
        / ws.name.split("__", 1)[-1]
        / ".exported"
    )
    if not marker.exists():
      return None
    base = marker.read_text().strip()
    derived = (
        "vh/" + base.split("/")[-1].split(":")[0]
    )  # the task image plus the harness tool stack (env/derive.py)
    return derived if _image_exists(derived) else base
  image = DEFAULT_IMAGES.get(bench)
  return image if image and _image_exists(image) else None


def _image_exists(tag: str) -> bool:
  return (
      subprocess.run(
          ["docker", "image", "inspect", tag], capture_output=True
      ).returncode
      == 0
  )


def _image_env(tag: str) -> dict:
  """The environment baked into an image (empty when docker cannot say)."""
  p = subprocess.run(
      ["docker", "image", "inspect", "--format", "{{json .Config.Env}}", tag],
      capture_output=True,
      text=True,
  )
  try:
    return (
        dict(kv.split("=", 1) for kv in json.loads(p.stdout) if "=" in kv)
        if p.returncode == 0
        else {}
    )
  except (ValueError, TypeError):
    return {}


class Native:
  """Runs a pi command inside the task's image. `wrap` returns the docker command and the
  container name, so a timed-out turn can be removed with `kill`."""

  def __init__(self, ws: Path, image: str):
    self.ws, self.image = ws, image
    self.gcloud = Path.home() / ".config" / "gcloud"
    self.image_env = _image_env(image)

  def wrap(self, cmd: list[str], env: dict) -> tuple[list[str], str]:
    ws = str(self.ws)
    name = f"vh_{uuid.uuid4().hex[:12]}"  # unique: task keys can share long prefixes
    docker = [
        "docker",
        "run",
        "--rm",
        "--name",
        name,
        "--network",
        "host",
        "-u",
        f"{os.getuid()}:{os.getgid()}",
        "-w",
        ws,
        "-e",
        "HOME=/tmp/vh_home",
        "-e",
        f"PATH={NODE}:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
        "-v",
        f"{config.HARNESS_DIR / 'vendor'}:{config.HARNESS_DIR / 'vendor'}:ro",
        "-v",
        f"{config.SKILLS_DIR}:{config.SKILLS_DIR}:ro",
        "-v",
        f"{config.PI_HOME}:{config.PI_HOME}",
        "-v",
        f"{ws}:{ws}",
    ]
    for sub in ("spec", "workspace", "rollouts"):
      if (self.ws / sub).is_dir():
        docker += ["-v", f"{ws}/{sub}:{ws}/{sub}:ro"]
    # A task image usually has the repository installed from its own path (here /workspace),
    # so imports resolve there whatever tree the verifier reads. Mount the task's repository
    # over that path, read-only, so the image's install and workspace/repo are one tree.
    repo = self.ws / "workspace" / "repo"
    if repo.is_dir():
      docker += ["-v", f"{repo.resolve()}:/workspace:ro"]
    worlds = config.DATA / "_worlds"
    if worlds.is_dir():
      docker += ["-v", f"{worlds}:{worlds}:ro"]
    # The host's headless browser, as the jail exposes it, for images that bring none. An image
    # that ships its own (PLAYWRIGHT_BROWSERS_PATH set, as the WorkBuddy web images do) keeps it:
    # its playwright wants its own browser build, and the host's is a different one.
    browsers = Path.home() / ".cache" / "ms-playwright"
    if browsers.is_dir():
      docker += ["-v", f"{browsers}:{browsers}:ro"]
      if not self.image_env.get("PLAYWRIGHT_BROWSERS_PATH"):
        docker += ["-e", f"PLAYWRIGHT_BROWSERS_PATH={browsers}"]
    if self.gcloud.is_dir():
      docker += [
          "-v",
          f"{self.gcloud}:{self.gcloud}:ro",
          "-e",
          f"GOOGLE_APPLICATION_CREDENTIALS={self.gcloud / 'application_default_credentials.json'}",
      ]
    for key in (
        "PI_CODING_AGENT_DIR",
        "PI_SKIP_VERSION_CHECK",
        "GOOGLE_CLOUD_LOCATION",
        "GOOGLE_CLOUD_PROJECT",
        "VERTEX_PROJECT",
        "VERTEX_LOCATION",
        "VERIHARNESS_DATA",
    ):
      if env.get(key):
        docker += ["-e", f"{key}={env[key]}"]
    return (
        docker
        + [
            self.image,
            "bash",
            "-c",
            'mkdir -p "$HOME" && exec "$@"',
            "--",
            *cmd,
        ],
        name,
    )

  @staticmethod
  def kill(name: str) -> None:
    subprocess.run(["docker", "rm", "-f", name], capture_output=True)

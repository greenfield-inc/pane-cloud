"""Runs the template's first-boot script in a Linux container with fake tailscale, npx and curl.

Needs docker and cfn-lint (for its CloudFormation YAML loader). Run: python3 -m unittest discover own-aws/test
"""

import json
import os
import re
import subprocess
import tempfile
import unittest
from pathlib import Path

from cfnlint.decode import decode

HERE = Path(__file__).resolve().parent
TEMPLATE = HERE.parent / "pane-cloud.yaml"
IMAGE = "node:22-bookworm-slim"
HANDLE = "https://cloudformation-waitcondition-us-east-1.s3.amazonaws.com/handle?sig=abc"
AUTH_URL = "https://login.tailscale.com/a/1234abcd"


def boot_script() -> str:
    template, problems = decode(str(TEMPLATE))
    assert not problems, problems
    user_data = template["Resources"]["MachineLaunchTemplate"]["Properties"]["LaunchTemplateData"]["UserData"]
    body = user_data["Fn::Base64"]["Fn::Sub"]
    values = {"ReadyHandle": HANDLE, "MachineName": "pane-test"}
    body = re.sub(r"\$\{(?!!)([^}]+)\}", lambda m: values[m.group(1)], body)
    return body.replace("${!", "${")


def run_boot(**env: str) -> dict:
    """Boots the script once and returns what it signalled, its console output and the commands it ran."""
    # Under this folder, because Docker on macOS shares only the home folder with its VM.
    with tempfile.TemporaryDirectory(dir=HERE, prefix="run-") as tmp:
        out = Path(tmp)
        (out / "boot.sh").write_text(boot_script())
        os.chmod(out, 0o777)
        env_args = [arg for key, value in env.items() for arg in ("-e", f"{key}={value}")]
        setup = "useradd -m ubuntu && exec bash /out/boot.sh"
        console = subprocess.run(
            ["docker", "run", "--rm", "-v", f"{out}:/out", "-v", f"{HERE / 'fakes'}:/fakes:ro",
             "-e", "PATH=/fakes:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin", "-e", f"FAKE_AUTH_URL={AUTH_URL}",
             *env_args, IMAGE, "bash", "-c", setup],
            capture_output=True, text=True, timeout=120,
        )
        signal = out / "signal.json"
        calls = out / "calls.log"
        return {
            "exit": console.returncode,
            "console": console.stdout + console.stderr,
            "signal": json.loads(signal.read_text()) if signal.exists() else None,
            "signal_url": (out / "signal.url").read_text().strip() if (out / "signal.url").exists() else None,
            "calls": calls.read_text() if calls.exists() else "",
        }


class BootScriptTest(unittest.TestCase):
    def test_stack_receives_the_tailnet_login_link_once_the_daemon_is_set_up(self):
        result = run_boot()
        self.assertEqual(result["signal_url"], HANDLE)
        self.assertEqual(result["signal"]["Status"], "SUCCESS")
        self.assertEqual(result["signal"]["Data"], AUTH_URL)
        self.assertIn("npx[ubuntu] --yes runpane@latest install daemon --format deb --label pane-test", result["calls"])
        self.assertIn("npx[ubuntu] --yes runpane@latest workspace enable --pane-dir /home/ubuntu/.pane_remote", result["calls"])
        self.assertIn("tailscale up --hostname=pane-test", result["calls"])

    def test_pairing_code_stays_off_the_console(self):
        result = run_boot()
        self.assertNotIn("SECRET-PAIRING-CODE", result["console"])

    def test_failed_daemon_install_fails_the_stack_and_names_the_step(self):
        result = run_boot(FAKE_INSTALL_FAILS="1")
        self.assertEqual(result["signal"]["Status"], "FAILURE")
        self.assertIn("installing the Pane daemon", result["signal"]["Reason"])
        self.assertNotIn("tailscale up", result["calls"])


if __name__ == "__main__":
    unittest.main()

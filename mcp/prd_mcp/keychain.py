import subprocess


def read_secret(service: str, account: str) -> str:
    """Read a secret from the macOS keychain. Never logs the value."""
    out = subprocess.run(
        ["security", "find-generic-password", "-s", service, "-a", account, "-w"],
        capture_output=True, text=True, check=True,
    )
    return out.stdout.strip()

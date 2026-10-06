"""Run the worker with private local configuration; never log its values."""
import os
import sys
from pathlib import Path

from .main import main

WORKER_VARIABLES = {
    "SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY",
    "TOKEN_ENCRYPTION_KEY", "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET",
    "META_GRAPH_VERSION", "TIKTOK_PROFILE_URL", "TIKTOK_CHANNEL_ID",
}


def load_local_config():
    path = Path(__file__).resolve().parent.parent / ".env.local"
    if not path.exists():
        return
    for line in path.read_text().splitlines():
        if line.lstrip().startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key, value = key.strip(), value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        if key in WORKER_VARIABLES and not os.environ.get(key):
            os.environ[key] = value
    if not os.environ.get("SUPABASE_URL") and os.environ.get("NEXT_PUBLIC_SUPABASE_URL"):
        os.environ["SUPABASE_URL"] = os.environ["NEXT_PUBLIC_SUPABASE_URL"]


if __name__ == "__main__":
    try:
        load_local_config()
    except (OSError, UnicodeError):
        print("Cannot read local worker configuration. Check .env.local permissions.")
        raise SystemExit(1) from None
    if len(sys.argv) == 1:
        sys.argv.append("tick")
    main()

"""Run the local-only application without Docker. Ctrl-C stops owned services."""
import os
from pathlib import Path
import signal
import subprocess
import time

root = Path(__file__).resolve().parents[1]
api = root / "services/api"
web = root / "apps/web"
subprocess.run(["uv", "sync", "--frozen"], cwd=api, check=True)
if not (web / "node_modules").exists():
    subprocess.run(["npm", "ci"], cwd=web, check=True)
subprocess.run(["uv", "run", "--no-sync", "alembic", "upgrade", "head"], cwd=api, check=True)
children = []
try:
    children.append(subprocess.Popen(["uv", "run", "--no-sync", "uvicorn", "app.main:app",
                                      "--host", "127.0.0.1", "--port", "8000"], cwd=api, start_new_session=True))
    children.append(subprocess.Popen(["npm", "run", "dev"], cwd=web, start_new_session=True))
    print("Website: http://127.0.0.1:3000/dashboard | API docs: http://127.0.0.1:8000/docs", flush=True)
    while all(p.poll() is None for p in children):
        time.sleep(1)
except KeyboardInterrupt:
    pass
finally:
    for child in children:
        if child.poll() is None:
            os.killpg(child.pid, signal.SIGTERM)
    for child in children:
        child.wait(timeout=15)

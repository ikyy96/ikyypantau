#!/usr/bin/env python3
"""
Lab Monitoring Agent - lintas OS (Windows / Linux / macOS).

Satu file yang sama dipakai sebagai agent.py maupun dibungkus jadi agent.exe
(PyInstaller). Konfigurasi dibaca dari environment variable atau dari file
agent.env di folder yang sama dengan agent.

Topik MQTT (tidak berubah dari versi lama):
  publish  : lab/monitoring/<HOSTNAME>
  subscribe: lab/command/<HOSTNAME>
  hasil    : lab/command/result/<HOSTNAME>

Setiap perintah dari backend WAJIB membawa signature HMAC-SHA256 atas
  "request_id|command|timestamp|params"
dengan params = JSON kanonik (key terurut, tanpa spasi).
"""
import getpass
import hashlib
import hmac
import json
import locale
import math
import os
import platform
import random
import re
import shutil
import socket
import subprocess
import sys
import threading
import time
from datetime import datetime, timezone


# ============================================================
# Env file + logging (harus sebelum konfigurasi)
# ============================================================
def _base_dir():
    if getattr(sys, "frozen", False):
        return os.path.dirname(sys.executable)
    return os.path.dirname(os.path.abspath(__file__))


def _load_env_file():
    path = os.environ.get("LAB_ENV_FILE") or os.path.join(_base_dir(), "agent.env")
    try:
        with open(path, encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                key, val = line.split("=", 1)
                os.environ.setdefault(key.strip(), val.strip().strip('"').strip("'"))
    except OSError:
        pass


_load_env_file()

# Mode --noconsole / service: stdout bisa None
if sys.stdout is None:
    sys.stdout = open(os.devnull, "w")
if sys.stderr is None:
    sys.stderr = open(os.devnull, "w")

LOG_FILE = os.environ.get("LAB_LOG_FILE", "")


def log(msg):
    line = f"[{datetime.now().strftime('%Y-%m-%d %H:%M:%S')}] {msg}"
    try:
        print(line, flush=True)
    except Exception:
        pass
    if LOG_FILE:
        try:
            with open(LOG_FILE, "a", encoding="utf-8") as f:
                f.write(line + "\n")
        except OSError:
            pass


try:
    import psutil
except ImportError:
    log("psutil belum terpasang. Jalankan: pip install -r requirements.txt")
    sys.exit(1)

import paho.mqtt.client as mqtt


# ============================================================
# Konfigurasi (tanpa rahasia hardcoded)
# ============================================================
def _env_int(name, default):
    try:
        return int(os.environ.get(name, default))
    except (TypeError, ValueError):
        return default


BROKER_URL = os.environ.get("LAB_BROKER_URL", "ws-mqtt.ikyypantau.my.id")
PORT = _env_int("LAB_BROKER_PORT", 443)
USE_TLS = os.environ.get("LAB_BROKER_TLS", "1") != "0"
WS_PATH = os.environ.get("LAB_BROKER_PATH", "/mqtt")
AGENT_TOKEN = os.environ.get("LAB_AGENT_TOKEN", "")
MQTT_USER = os.environ.get("LAB_MQTT_USER", "")
MQTT_PASS = os.environ.get("LAB_MQTT_PASS", "")
PING_TARGET = os.environ.get("LAB_PING_TARGET", "8.8.8.8")
PING_TIMEOUT = _env_int("LAB_PING_TIMEOUT", 2)
COMMAND_TIMEOUT = _env_int("LAB_COMMAND_TIMEOUT", 15)
SHUTDOWN_DELAY = _env_int("LAB_SHUTDOWN_DELAY", 30)
TS_TOLERANCE = _env_int("LAB_TS_TOLERANCE", 60)
INTERVAL = _env_int("LAB_INTERVAL", 2)
SEND_FILES = os.environ.get("LAB_SEND_FILES", "0") == "1"

if not AGENT_TOKEN:
    log("LAB_AGENT_TOKEN kosong. Isi di agent.env atau environment, lalu jalankan ulang.")
    sys.exit(1)

OS_NAME = platform.system()
IS_WINDOWS = OS_NAME == "Windows"
IS_MACOS = OS_NAME == "Darwin"
IS_LINUX = OS_NAME == "Linux"
IS_ROOT = hasattr(os, "geteuid") and os.geteuid() == 0

HOSTNAME = socket.gethostname()
TOPIC = f"lab/monitoring/{HOSTNAME}"
COMMAND_TOPIC = f"lab/command/{HOSTNAME}"
RESULT_TOPIC = f"lab/command/result/{HOSTNAME}"


# ============================================================
# Helper subprocess
# ============================================================
NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0) if IS_WINDOWS else 0


def run(args, timeout):
    """Jalankan perintah TANPA shell. stdin ditutup supaya aman di --noconsole."""
    return subprocess.run(
        args,
        capture_output=True,
        timeout=timeout,
        stdin=subprocess.DEVNULL,
        creationflags=NO_WINDOW,
    )


def decode(data):
    if not data:
        return ""
    for enc in ("utf-8", locale.getpreferredencoding(False), "cp1252"):
        try:
            return data.decode(enc)
        except (UnicodeDecodeError, LookupError):
            continue
    return data.decode("utf-8", errors="replace")


# ============================================================
# Info statis (dideteksi sekali saat start)
# ============================================================
def get_cpu_name():
    try:
        if IS_WINDOWS:
            r = run(["powershell", "-NoProfile", "-Command",
                     "(Get-CimInstance Win32_Processor).Name"], 8)
            out = decode(r.stdout).strip()
            if r.returncode == 0 and out:
                return out.splitlines()[0].strip()
            try:
                import winreg
                key = winreg.OpenKey(
                    winreg.HKEY_LOCAL_MACHINE,
                    r"HARDWARE\DESCRIPTION\System\CentralProcessor\0")
                name, _ = winreg.QueryValueEx(key, "ProcessorNameString")
                winreg.CloseKey(key)
                if name:
                    return name.strip()
            except Exception:
                pass
        elif IS_LINUX:
            try:
                with open("/proc/cpuinfo", errors="replace") as f:
                    for line in f:
                        if line.startswith("model name"):
                            return line.split(":", 1)[1].strip()
            except OSError:
                pass
            r = run(["lscpu"], 5)
            for line in decode(r.stdout).splitlines():
                if "Model name" in line:
                    return line.split(":", 1)[1].strip()
        elif IS_MACOS:
            r = run(["sysctl", "-n", "machdep.cpu.brand_string"], 5)
            out = decode(r.stdout).strip()
            if r.returncode == 0 and out:
                return out
    except Exception:
        pass
    return platform.processor() or "Unknown CPU"


CPU_NAME = get_cpu_name()
CPU_THREADS = psutil.cpu_count(logical=True)
CPU_CORES = psutil.cpu_count(logical=False)

# GPU: NVIDIA via pynvml (opsional), init sekali
GPU_OK = False
try:
    import pynvml
    pynvml.nvmlInit()
    GPU_OK = True
except Exception:
    GPU_OK = False

GPU_FALLBACK = []
if IS_WINDOWS and not GPU_OK:
    try:
        r = run(["powershell", "-NoProfile", "-Command",
                 "(Get-CimInstance Win32_VideoController).Name"], 8)
        for name in decode(r.stdout).splitlines():
            name = name.strip()
            if name:
                GPU_FALLBACK.append({
                    "name": name, "type": "Unknown", "temperature": 0,
                    "utilization": 0, "memory_util": 0,
                    "memory_used_gb": 0, "memory_total_gb": 0})
    except Exception:
        pass


def get_gpu_info():
    """Daftar GPU. Kosong ([]) bila tidak ada; tidak pernah melempar error."""
    if not GPU_OK:
        return GPU_FALLBACK
    gpus = []
    try:
        for i in range(pynvml.nvmlDeviceGetCount()):
            h = pynvml.nvmlDeviceGetHandleByIndex(i)
            name = pynvml.nvmlDeviceGetName(h)
            if isinstance(name, bytes):
                name = name.decode("utf-8", errors="replace")
            mem = pynvml.nvmlDeviceGetMemoryInfo(h)
            try:
                temp = pynvml.nvmlDeviceGetTemperature(h, pynvml.NVML_TEMPERATURE_GPU)
            except Exception:
                temp = 0
            try:
                util = pynvml.nvmlDeviceGetUtilizationRates(h)
                gpu_util, mem_util = util.gpu, util.memory
            except Exception:
                gpu_util, mem_util = 0, 0
            gpus.append({
                "name": name, "type": "NVIDIA", "temperature": temp,
                "utilization": gpu_util, "memory_util": mem_util,
                "memory_used_gb": round(mem.used / (1024 ** 3), 2),
                "memory_total_gb": round(mem.total / (1024 ** 3), 2)})
    except Exception:
        return GPU_FALLBACK
    return gpus


def detect_interface():
    """Interface yang dipakai keluar ke internet. Return (nama, ip, mac)."""
    local_ip = None
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.settimeout(2)
        s.connect(("8.8.8.8", 80))  # UDP, tidak mengirim paket
        local_ip = s.getsockname()[0]
        s.close()
    except OSError:
        pass
    try:
        addrs = psutil.net_if_addrs()
    except Exception:
        return "eth0", "N/A", "N/A"
    found = None
    for name, lst in addrs.items():
        for a in lst:
            if a.family == socket.AF_INET:
                if local_ip and a.address == local_ip:
                    found = name
                elif found is None and not a.address.startswith(("127.", "169.254.")) \
                        and name.lower() not in ("lo", "loopback", "localhost"):
                    found = found or name
        if found and local_ip and any(
                a.family == socket.AF_INET and a.address == local_ip for a in lst):
            break
    if not found:
        return (next(iter(addrs), "eth0"), "N/A", "N/A")
    ip, mac = "N/A", "N/A"
    for a in addrs[found]:
        if a.family == socket.AF_INET and ip == "N/A":
            ip = a.address
        if a.family == psutil.AF_LINK and mac == "N/A":
            mac = a.address or "N/A"
    return found, ip, mac


INTERFACE_NAME, IP_ADDRESS, MAC_ADDRESS = detect_interface()


# ============================================================
# Metrik dinamis
# ============================================================
def get_uptime():
    try:
        secs = time.time() - psutil.boot_time()
        return f"{int(secs // 3600)}h {int((secs % 3600) // 60)}m"
    except Exception:
        return "N/A"


def get_latency(host):
    """Ping satu kali. Flag timeout berbeda per OS. 999 bila gagal."""
    if not host:
        return 999
    if IS_WINDOWS:
        cmd = ["ping", "-n", "1", "-w", str(PING_TIMEOUT * 1000), host]
    elif IS_MACOS:
        cmd = ["ping", "-c", "1", "-t", str(PING_TIMEOUT), host]
    else:
        cmd = ["ping", "-c", "1", "-W", str(PING_TIMEOUT), host]
    try:
        r = run(cmd, PING_TIMEOUT + 4)
        if r.returncode != 0:
            return 999
        m = re.search(r"[=<]\s*([\d.]+)\s*ms", decode(r.stdout), re.IGNORECASE)
        return int(float(m.group(1))) if m else 999
    except Exception:
        return 999


def get_net_usage():
    try:
        n = psutil.net_io_counters(pernic=True)
        if INTERFACE_NAME in n:
            return n[INTERFACE_NAME].bytes_recv, n[INTERFACE_NAME].bytes_sent
    except Exception:
        pass
    return 0, 0


SKIP_FSTYPES = {"squashfs", "tmpfs", "devtmpfs", "overlay", "iso9660", "autofs", "proc", "sysfs"}


def get_disk_info():
    total = used = free = 0
    drives = []
    try:
        parts = psutil.disk_partitions()
    except Exception:
        parts = []
    for p in parts:
        if "cdrom" in p.opts or p.fstype == "" or p.fstype in SKIP_FSTYPES:
            continue
        try:
            u = psutil.disk_usage(p.mountpoint)
        except Exception:
            continue
        total += u.total
        used += u.used
        free += u.free
        drives.append({
            "mount": p.mountpoint, "device": p.device, "fstype": p.fstype,
            "total_gb": round(u.total / (1024 ** 3), 1),
            "used_gb": round(u.used / (1024 ** 3), 1),
            "free_gb": round(u.free / (1024 ** 3), 1),
            "percent": round(u.percent, 1)})
    pct = round(used / total * 100, 1) if total > 0 else 0
    return {
        "total_gb": round(total / (1024 ** 3), 1),
        "used_gb": round(used / (1024 ** 3), 1),
        "free_gb": round(free / (1024 ** 3), 1),
        "percent": pct, "drives": drives}


def prime_processes():
    """Panggilan pertama cpu_percent selalu 0; panaskan sekali saat start."""
    for p in psutil.process_iter():
        try:
            p.cpu_percent(None)
        except Exception:
            pass


def get_top_processes(limit=5):
    out = []
    try:
        for p in psutil.process_iter(["name", "cpu_percent", "memory_percent"]):
            i = p.info
            name = i.get("name")
            if not name or name == "System Idle Process":
                continue
            out.append({"name": name,
                        "cpu": round(i.get("cpu_percent") or 0, 1),
                        "mem": round(i.get("memory_percent") or 0, 1)})
    except Exception:
        pass
    out.sort(key=lambda x: x["cpu"], reverse=True)
    return out[:limit]


_files_cache = {"t": 0.0, "v": []}


def get_largest_files(limit=5):
    """Hanya dipakai bila LAB_SEND_FILES=1. Di-cache 5 menit, jumlah file dibatasi."""
    now = time.time()
    if now - _files_cache["t"] < 300:
        return _files_cache["v"]
    home = os.path.expanduser("~")
    found, scanned = [], 0
    for sub in ("Desktop", "Documents", "Downloads"):
        root = os.path.join(home, sub)
        if not os.path.isdir(root):
            continue
        for dirpath, dirnames, filenames in os.walk(root, topdown=True):
            dirnames[:] = [d for d in dirnames if not d.startswith((".", "$"))]
            for fname in filenames:
                scanned += 1
                if scanned > 5000:
                    break
                fp = os.path.join(dirpath, fname)
                try:
                    if os.path.isfile(fp) and not os.path.islink(fp):
                        size = os.path.getsize(fp)
                        if size > 1024 * 1024:
                            found.append((fp, size))
                except OSError:
                    continue
            if scanned > 5000:
                break
    found.sort(key=lambda x: x[1], reverse=True)
    _files_cache["t"] = now
    _files_cache["v"] = [{"name": os.path.basename(p), "path": p,
                          "size_mb": round(s / (1024 * 1024), 1)} for p, s in found[:limit]]
    return _files_cache["v"]


# ============================================================
# Verifikasi perintah (HMAC + timestamp + anti-replay)
# ============================================================
_seen = {}  # request_id -> waktu diterima
_seen_lock = threading.Lock()


def canonical(obj):
    return json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def parse_ts(ts):
    """Terima epoch (detik/ms) atau string ISO-8601. Return epoch detik."""
    if isinstance(ts, (int, float)) or (isinstance(ts, str) and re.fullmatch(r"\d+(\.\d+)?", ts)):
        v = float(ts)
        return v / 1000.0 if v > 1e11 else v
    dt = datetime.fromisoformat(str(ts).replace("Z", "+00:00"))
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.timestamp()


def verify_command(payload, token=None):
    """Return (ok, alasan). Replay hanya dicatat setelah signature valid."""
    token = AGENT_TOKEN if token is None else token
    req_id = payload.get("request_id")
    cmd = payload.get("command")
    ts = payload.get("timestamp")
    sig = payload.get("signature")
    params = payload.get("params") or {}
    if not req_id or not cmd or ts in (None, "") or not sig:
        return False, "field wajib kurang (request_id/command/timestamp/signature)"
    ts_str = ts if isinstance(ts, str) else str(ts)
    message = f"{req_id}|{cmd}|{ts_str}|{canonical(params)}".encode("utf-8")
    expected = hmac.new(token.encode("utf-8"), message, hashlib.sha256).hexdigest()
    if not hmac.compare_digest(expected.encode(), str(sig).lower().encode()):
        return False, "signature tidak valid"
    try:
        delta = abs(time.time() - parse_ts(ts))
    except Exception:
        return False, "format timestamp tidak valid"
    if delta > TS_TOLERANCE:
        return False, f"timestamp kedaluwarsa (selisih {int(delta)} detik; cek jam PC/server)"
    now = time.time()
    with _seen_lock:
        for k in [k for k, t in _seen.items() if now - t > TS_TOLERANCE * 2]:
            del _seen[k]
        if req_id in _seen:
            return False, "request_id sudah dipakai (replay)"
        _seen[req_id] = now
    return True, "ok"


# ============================================================
# Eksekusi perintah (whitelist, tanpa shell)
# ============================================================
PROCESS_NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")
SHUTDOWN_NOTE = "Perintah dikirim oleh admin lab"
NEEDS_ROOT = {"shutdown", "restart", "cancel_shutdown"}
MAX_OUTPUT = 20000


def build_command(name, params):
    """Return (args | None, error | None)."""
    minutes = max(1, int(math.ceil(SHUTDOWN_DELAY / 60.0)))
    if name == "taskkill":
        proc = str((params or {}).get("process_name", ""))
        if not PROCESS_NAME_RE.match(proc):
            return None, "process_name tidak valid (huruf/angka . _ - ; maks 64 karakter)"
        return (["taskkill", "/IM", proc, "/F"] if IS_WINDOWS else ["killall", proc]), None
    if IS_WINDOWS:
        table = {
            "tasklist": ["tasklist"], "ipconfig": ["ipconfig"], "whoami": ["whoami"],
            "systeminfo": ["systeminfo"],
            "shutdown": ["shutdown", "/s", "/t", str(SHUTDOWN_DELAY), "/c", SHUTDOWN_NOTE],
            "restart": ["shutdown", "/r", "/t", str(SHUTDOWN_DELAY), "/c", SHUTDOWN_NOTE],
            "cancel_shutdown": ["shutdown", "/a"],
        }
    else:
        net = ["ifconfig"] if shutil.which("ifconfig") else ["ip", "addr"]
        table = {
            "tasklist": ["ps", "aux"], "ipconfig": net, "whoami": ["whoami"],
            "systeminfo": ["uname", "-a"],
            "shutdown": ["shutdown", "-h", f"+{minutes}", SHUTDOWN_NOTE],
            "restart": ["shutdown", "-r", f"+{minutes}", SHUTDOWN_NOTE],
            "cancel_shutdown": ["shutdown", "-c"],
        }
    if name not in table:
        return None, f"Command '{name}' tidak diizinkan"
    return table[name], None


def execute_command(name, params=None):
    start = time.time()

    def result(status, output="", error="", **extra):
        d = {"status": status, "output": output[:MAX_OUTPUT], "error": error,
             "execution_time": round(time.time() - start, 2)}
        d.update(extra)
        return d

    args, err = build_command(name, params)
    if err:
        return result("error", error=err)

    if not IS_WINDOWS and name in NEEDS_ROOT and not IS_ROOT:
        if shutil.which("sudo"):
            args = ["sudo", "-n"] + args
        else:
            return result("error", error="Perintah ini butuh root. Jalankan agent sebagai root/service.")

    try:
        r = run(args, COMMAND_TIMEOUT)
    except subprocess.TimeoutExpired:
        return result("error", error=f"Command timeout ({COMMAND_TIMEOUT}s)")
    except Exception as e:
        return result("error", error=str(e))

    out = (decode(r.stdout) + decode(r.stderr)).strip()
    if r.returncode == 0:
        return result("success", out or "Command executed successfully (no output)")
    hint = ""
    if not IS_WINDOWS and name in NEEDS_ROOT and not IS_ROOT:
        hint = " (butuh root atau sudo tanpa password)"
    return result("error", out, f"Return code: {r.returncode}{hint}")


# ============================================================
# MQTT
# ============================================================
CLIENT_ID = f"agent_{HOSTNAME}_{random.randint(1000, 9999)}"
_cmd_lock = threading.Lock()


def make_client():
    try:
        from paho.mqtt.enums import CallbackAPIVersion
        return mqtt.Client(callback_api_version=CallbackAPIVersion.VERSION2,
                           client_id=CLIENT_ID, transport="websockets")
    except (ImportError, AttributeError, TypeError):
        return mqtt.Client(client_id=CLIENT_ID, transport="websockets")


def publish_result(client, req_id, cmd, res):
    msg = {"request_id": req_id, "hostname": HOSTNAME, "command": cmd, "result": res}
    try:
        client.publish(RESULT_TOPIC, json.dumps(msg), qos=1)
    except Exception as e:
        log(f"[x] Gagal kirim hasil: {e}")


def handle_command(client, payload):
    req_id = str(payload.get("request_id", ""))
    cmd = str(payload.get("command", ""))
    ok, reason = verify_command(payload)
    if not ok:
        log(f"[x] Perintah '{cmd}' ({req_id}) ditolak: {reason}")
        publish_result(client, req_id, cmd, {
            "status": "error", "output": "", "error": f"Ditolak: {reason}",
            "execution_time": 0})
        return
    log(f"[>] Menjalankan '{cmd}' ({req_id})")
    with _cmd_lock:
        res = execute_command(cmd, payload.get("params") or {})
    # Status dikirim SETELAH perintah OS benar-benar dijalankan (bukan sukses palsu)
    publish_result(client, req_id, cmd, res)
    log(f"[{'v' if res['status'] == 'success' else 'x'}] '{cmd}' selesai: {res['status']}")


def on_connect(client, userdata, flags, rc, *extra):
    failed = rc.is_failure if hasattr(rc, "is_failure") else (rc != 0)
    if failed:
        log(f"[x] Gagal konek ke broker (rc={rc}). Mencoba lagi otomatis...")
        return
    log(f"[v] Terhubung ke broker {BROKER_URL}:{PORT}")
    client.subscribe(COMMAND_TOPIC, qos=1)
    log(f"[*] Subscribe: {COMMAND_TOPIC}")


def on_disconnect(client, userdata, *args):
    log("[!] Koneksi MQTT terputus. paho akan menyambung ulang otomatis.")


def on_message(client, userdata, msg):
    if msg.topic != COMMAND_TOPIC:
        return
    try:
        payload = json.loads(msg.payload.decode("utf-8"))
        if not isinstance(payload, dict):
            raise ValueError("payload bukan objek")
    except Exception as e:
        log(f"[x] JSON perintah tidak valid: {e}")
        return
    threading.Thread(target=handle_command, args=(client, payload), daemon=True).start()


# ============================================================
# Payload monitoring (format sama dengan versi lama)
# ============================================================
_state = {"rx": 0, "t": time.time(), "lat": 999, "lat_t": 0.0}


def build_payload():
    now = time.time()
    rx, _tx = get_net_usage()
    elapsed = max(0.001, now - _state["t"])
    down_mbps = round(max(0, (rx - _state["rx"]) * 8 / (1024 * 1024) / elapsed), 2)
    _state["rx"], _state["t"] = rx, now

    if now - _state["lat_t"] > 10:
        _state["lat"], _state["lat_t"] = get_latency(PING_TARGET), now

    mem = psutil.virtual_memory()
    try:
        freq = psutil.cpu_freq()
    except Exception:
        freq = None
    try:
        user = getpass.getuser()
    except Exception:
        user = "unknown"

    payload = {
        "id": HOSTNAME, "status": "online", "user": user,
        "time": datetime.now().strftime("%H:%M:%S"),
        "info": {"uptime": get_uptime(), "os": f"{OS_NAME} {platform.release()}",
                 "cpu_name": CPU_NAME},
        "network": {"down_mbps": down_mbps,
                    "traffic_in_gb": round(rx / (1024 ** 3), 2),
                    "latency_ms": _state["lat"], "iface": INTERFACE_NAME,
                    "ip": IP_ADDRESS, "mac": MAC_ADDRESS},
        "metrics": {
            "cpu": {"percent": int(psutil.cpu_percent()), "threads": CPU_THREADS,
                    "cores": CPU_CORES,
                    "ghz": round(freq.current / 1000, 2) if freq and freq.current else 0,
                    "max_ghz": round(freq.max / 1000, 2) if freq and freq.max else 0},
            "ram_percent": int(mem.percent),
            "ram": {"used_gb": round(mem.used / (1024 ** 3), 2),
                    "total_gb": round(mem.total / (1024 ** 3), 1)},
            "storage": get_disk_info(),
            "gpu": get_gpu_info(),
            "top_processes": get_top_processes(5),
        },
    }
    if SEND_FILES:
        payload["metrics"]["top_files"] = get_largest_files(5)
    return payload


def main():
    log(f"Lab Agent mulai | OS={OS_NAME} | host={HOSTNAME} | broker={BROKER_URL}:{PORT}")
    log(f"CPU: {CPU_NAME} | iface: {INTERFACE_NAME} ({IP_ADDRESS})")
    if not IS_WINDOWS and not IS_ROOT:
        log("[i] Bukan root: shutdown/restart memakai 'sudo -n' (perlu sudoers NOPASSWD) atau jalankan sebagai root.")
    prime_processes()

    client = make_client()
    if MQTT_USER:
        client.username_pw_set(MQTT_USER, MQTT_PASS)
    client.will_set(TOPIC, json.dumps({"id": HOSTNAME, "status": "offline"}),
                    qos=1, retain=True)
    if USE_TLS:
        client.tls_set()
    client.ws_set_options(path=WS_PATH)
    client.on_connect = on_connect
    client.on_disconnect = on_disconnect
    client.on_message = on_message
    client.reconnect_delay_set(min_delay=1, max_delay=60)
    client.connect_async(BROKER_URL, PORT, keepalive=60)
    client.loop_start()

    try:
        while True:
            try:
                payload = build_payload()
                if client.is_connected():
                    client.publish(TOPIC, json.dumps(payload), qos=0, retain=True)
                    m = payload["metrics"]
                    log(f"CPU {m['cpu']['percent']}% | RAM {m['ram_percent']}% | "
                        f"Disk {m['storage']['percent']}%")
                else:
                    log("[!] MQTT belum terhubung, publish dilewati")
            except Exception as e:
                log(f"[!] Error loop: {e}")
            time.sleep(INTERVAL)
    except KeyboardInterrupt:
        log("Dihentikan. Mengirim status offline...")
        try:
            client.publish(TOPIC, json.dumps({"id": HOSTNAME, "status": "offline"}),
                           qos=1, retain=True).wait_for_publish(2)
        except Exception:
            pass
        client.loop_stop()
        client.disconnect()


if __name__ == "__main__":
    main()
# 🚀 Panduan Deploy Lab Monitoring System ke VPS Baru

> Dokumen ini menjelaskan **langkah lengkap** memindahkan server **Lab Monitoring System v2.2.0** ke VPS yang baru dibeli: apa yang harus di-*install* di VPS, file codingan mana yang harus diubah, konfigurasi Mosquitto/Nginx/Cloudflare, sampai cara mengetesnya.
>
> Ditulis untuk **Ubuntu 22.04 LTS**. Semua perintah `sudo` dijalankan sebagai user biasa yang punya akses sudo.

---

## 📑 Daftar Isi

1. [Arsitektur Sistem](#-arsitektur-sistem)
2. [Yang Harus Disiapkan Sebelum Mulai](#-yang-harus-disiapkan-sebelum-mulai)
3. [Persiapan Awal VPS](#-1-persiapan-awal-vps)
4. [Install Dependency di VPS](#-2-install-dependency-di-vps)
5. [Ambil Kode Project dari GitHub](#-3-ambil-kode-project-dari-github)
6. [Konfigurasi Mosquitto (MQTT Broker)](#-4-konfigurasi-mosquitto-mqtt-broker)
7. [Konfigurasi Backend (main.js)](#-5-konfigurasi-backend)
8. [Konfigurasi Nginx (Dashboard + WebSocket MQTT)](#-6-konfigurasi-nginx)
9. [SSL / TLS + Cloudflare](#-7-ssl--tls--cloudflare)
10. [Jalankan Backend sebagai Service (systemd)](#-8-jalankan-backend-sebagai-service-systemd)
11. [Firewall (UFW) & Port](#-9-firewall-ufw--port)
12. [Konfigurasi Google OAuth](#-10-konfigurasi-google-oauth)
13. [Konfigurasi & Jalankan Agent (PC Client)](#-11-konfigurasi--jalankan-agent-pc-client)
14. [Testing & Verifikasi](#-12-testing--verifikasi)
15. [Ringkasan File yang Harus Diubah](#-13-ringkasan-file-yang-harus-diubah)
16. [Troubleshooting](#-14-troubleshooting)

---

## 🏗 Arsitektur Sistem

```
                         INTERNET 🌐
                              │
                    ┌─────────┴─────────┐
                    │    Cloudflare     │  (DNS + SSL proxy)
                    │  ikyypantau.my.id │
                    └─────────┬─────────┘
                              │  HTTPS :443
                    ┌─────────┴─────────────┐
                    │         VPS           │
                    │                       │
   ┌────────────────┤   Nginx :443          │
   │  Browser (HP/  │     ├── /  , /api, /ws │──▶ 127.0.0.1:8800  (Backend)
   │  Laptop)  ─────┼──▶  │    → Dashboard   │
   │  https://...   │     └── /mqtt          │──▶ 127.0.0.1:9001  (Mosquitto WS)
   └────────────────┤                       │
                    │   Mosquitto Broker    │
                    │     ├── :1883 (TCP)   │──▶ dipakai Backend (mqtt://127.0.0.1)
                    │     └── :9001 (WS)    │──▶ dipakai Agent  (wss://.../mqtt)
                    └─────────┬─────────────┘
                              │  WSS :443 (lewat Cloudflare)
              ┌───────────────┼───────────────┐
              │               │               │
        [💻 PC-LAB-01]   [💻 PC-LAB-02]   [💻 PC-LAB-03]
          agent.py         agent.py         agent.py
```

**Alur data singkat:**

| Komponen | Berjalan di | Konek ke |
|---|---|---|
| `agent.py` | tiap PC client | `wss://ws-mqtt.ikyypantau.my.id:443/mqtt` (publish data CPU/RAM/CPU dll) |
| Backend (`main.js`) | VPS | `mqtt://127.0.0.1:1883` (subscribe data agent + kirim perintah) |
| Dashboard (browser) | HP/Laptop | `https://ikyypantau.my.id` → WebSocket `/ws` |
| Nginx | VPS | Proxy `443` → `8800` (dashboard) & `9001` (MQTT WS) |
| Cloudflare | - | DNS + SSL ke VPS |

> 💡 **Kunci utama pindah VPS:** karena broker MQTT sekarang ada **di dalam VPS yang sama** dengan backend, maka `MQTT_BROKER` di backend harus diubah dari IP lama (`10.190.143.25`) menjadi **`127.0.0.1`** (localhost).

---

## ✅ Yang Harus Disiapkan Sebelum Mulai

### A. Yang dibeli / dimiliki
| Item | Keterangan |
|---|---|
| **VPS** | Ubuntu 22.04 LTS. Minimum **1 vCPU / 1 GB RAM / 20 GB SSD** (disarankan 2 vCPU / 2 GB) |
| **Domain** | `ikyypantau.my.id` (sudah dimiliki) |
| **Akun Cloudflare** | Untuk DNS + SSL (gratis) |
| **Akun Google Cloud** | Untuk Google OAuth login (Client ID) |

### B. Informasi yang WAJIB dicatat dari VPS baru
> Salin nilai-nilai ini dulu karena akan dipakai di banyak langkah.

| Info | Contoh | Catatan |
|---|---|---|
| **IP publik VPS** | `103.x.x.x` | dari email/panel penyedia VPS |
| **User SSH** | `root` atau `ubuntu` | default biasanya `root` |
| **Password / SSH key** | - | dari penyedia VPS |
| **Domain** | `ikyypantau.my.id` | |
| **Subdomain MQTT** | `ws-mqtt.ikyypantau.my.id` | untuk agent |
| **Google Client ID** | `1024...apps.googleusercontent.com` | boleh dipakai yang lama kalau masih ada |

### C. Port yang dipakai sistem
| Port | Protocol | Fungsi | Dibuka ke publik? |
|---|---|---|---|
| 22 | TCP | SSH | ✅ (idealnya IP Anda saja) |
| 80 | TCP | HTTP (redirect + certbot) | ✅ |
| 443 | TCP | HTTPS (Nginx: dashboard + MQTT WS) | ✅ |
| 8800 | TCP | Backend dashboard | ❌ (localhost saja) |
| 1883 | TCP | MQTT broker (backend) | ❌ (localhost saja) |
| 9001 | TCP | MQTT WebSocket (agent via Nginx) | ❌ (localhost saja) |

---

## 1️⃣ Persiapan Awal VPS

### 1.1 Login ke VPS (via SSH)
```bash
ssh root@IP_PUBLIK_VPS
# atau kalau pakai user ubuntu:
ssh ubuntu@IP_PUBLIK_VPS
```

### 1.2 Update sistem
```bash
sudo apt update && sudo apt upgrade -y
```

### 1.3 Set timezone (opsional, biar log rapi)
```bash
sudo timedatectl set-timezone Asia/Jakarta
```

### 1.4 Install paket dasar
```bash
sudo apt install -y curl wget git unzip nano ufw ca-certificates gnupg lsb-release
```

### 1.5 (Disarankan) Buat user non-root `lab`
> Lewati kalau VPS Anda sudah punya user `ubuntu`.
```bash
sudo adduser --gecos "" lab
sudo usermod -aG sudo lab
# Pindah ke user lab
su - lab
```

---

## 2️⃣ Install Dependency di VPS

### 2.1 Node.js 20 LTS (untuk backend `main.js`)
```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
node -v      # harus muncul v20.x
npm -v
```

### 2.2 Python 3 (opsional — hanya untuk utilitas di VPS)
> Backend sekarang **Node.js**, jadi Python **tidak wajib** di VPS. Cukup diinstall
> kalau ingin memakai utilitas seperti `python3 -m json.tool` untuk merapikan output JSON.
```bash
sudo apt install -y python3 python3-pip
python3 --version
```

### 2.3 Mosquitto MQTT Broker + client
```bash
sudo apt install -y mosquitto mosquitto-clients
# Cek status
sudo systemctl status mosquitto --no-pager
```

### 2.4 Nginx (reverse proxy)
```bash
sudo apt install -y nginx
sudo systemctl enable --now nginx
```

### 2.5 Certbot (kalau mau SSL Let's Encrypt — opsional kalau pakai Cloudflare)
```bash
sudo apt install -y certbot python3-certbot-nginx
```

---


## 3️⃣ Ambil Kode Project dari GitHub

```bash
# Masuk ke home directory
cd ~

# Clone repo (ganti URL kalau repo Anda berbeda)
git clone https://github.com/ikyy96/ikyypantau.git
cd ikyypantau
```

### 3.1 Install dependency backend (Node.js)

```bash
npm install          # menginstall express, ws, mqtt, express-session
```

---

## 4️⃣ Konfigurasi Mosquitto (MQTT Broker)

### 4.1 Copy file konfigurasi yang sudah disiapkan
Repo sudah menyediakan file `deploy/mosquitto.conf`. Copy ke folder conf Mosquitto:
```bash
sudo cp ~/ikyypantau/deploy/mosquitto.conf /etc/mosquitto/conf.d/lab-monitoring.conf
```

### 4.2 Nonaktifkan listener default (agar tidak bentrok)
File `/etc/mosquitto/mosquitto.conf` bawaan biasanya sudah berisi `include_dir /etc/mosquitto/conf.d`.
Pastikan tidak ada `listener 1883` yang dobel. Cek dulu:
```bash
sudo nano /etc/mosquitto/mosquitto.conf
```
Pastikan isinya hanya seperti ini (tanpa baris `listener`/`allow_anonymous` sendiri):
```
per_listener_settings false
include_dir /etc/mosquitto/conf.d
```
> Jika ada baris `listener 1883` atau `allow_anonymous` di file utama, beri tanda `#` di depannya agar tidak konflik dengan file kita.

### 4.3 Restart & cek Mosquitto
```bash
sudo systemctl restart mosquitto
sudo systemctl status mosquitto --no-pager
# Cek port yang listen
sudo ss -tlnp | grep -E '1883|9001'
```
Harus muncul dua listener: `127.0.0.1:1883` dan `127.0.0.1:9001`.

### 4.4 Tes broker lokal (opsional)
```bash
# Terminal 1: subscribe
mosquitto_sub -h 127.0.0.1 -p 1883 -t 'lab/monitoring/#' -v
# Terminal 2: publish
mosquitto_pub -h 127.0.0.1 -p 1883 -t 'lab/monitoring/TEST' -m '{"id":"TEST","status":"online"}'
```
Kalau Terminal 1 menerima pesan → broker berjalan normal. ✅

---

## 5️⃣ Konfigurasi Backend

> ⚠️ **INI BAGIAN TERPENTING.** Ada nilai hardcoded dari server lama yang **harus** diubah. Backend project ini adalah **Node.js (`main.js`)**.

### 5.1 ➤ Backend Node.js: `main.js`

Buka file:
```bash
nano ~/ikyypantau/main.js
```

**a) Ubah IP MQTT broker ke localhost** (karena broker sekarang ada di VPS ini):
```javascript
// ❌ SEBELUM (baris 29):
const MQTT_BROKER = '10.190.143.25';

// ✅ SESUDAH:
const MQTT_BROKER = process.env.MQTT_BROKER || '127.0.0.1';
```

**b) Pastikan password/token/port** (baris 17-19, 34):
```javascript
const ADMIN_PASSWORD = process.env.LAB_PASSWORD || 'admin123';        // ganti 'admin123'!
const SECRET_KEY = process.env.LAB_SECRET_KEY || crypto.randomBytes(32).toString('hex');
const AGENT_TOKEN = process.env.LAB_AGENT_TOKEN || 'lab-token-2024';  // samakan dengan agent
const MQTT_PORT = 1883;
const SERVER_PORT = 8800;
const USE_MQTT = true;                                                 // true = mode MQTT
```

**c) Google Client ID** (baris 61) — samakan dengan `static/index.html`:
```javascript
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '1024514167323-0pc62a62d85jrjor7tqaeme12lt7pk2n.apps.googleusercontent.com';
```

### 5.2 ➤ Frontend: `static/index.html`

Ada **Google Client ID hardcoded** di baris 851. Nilainya **harus sama** dengan `main.js`:
```javascript
const GOOGLE_CLIENT_ID = '1024514167323-0pc62a62d85jrjor7tqaeme12lt7pk2n.apps.googleusercontent.com';
```
```bash
nano ~/ikyypantau/static/index.html   # cari kata "GOOGLE_CLIENT_ID"
```
> 💡 Kalau pakai Client ID yang baru, ubah di **2 tempat**: `main.js` **dan** `static/index.html`.

### 5.3 ➤ Buat file `.env` (cara paling rapi, jangan hardcode password)
```bash
cd ~/ikyypantau
cp deploy/.env.example .env
nano .env     # isi LAB_PASSWORD, LAB_SECRET_KEY, dll
```
```bash
chmod 600 .env     # amankan file agar hanya owner yang bisa baca
```

### 5.4 ➤ Buat file whitelist email Google
```bash
cat > ~/ikyypantau/allowed_emails.json <<'EOF'
{
  "emails": [
    "rizkyharun122@gmail.com"
  ]
}
EOF
```
> Tambahkan email lain (dipisah koma di dalam array) sesuai kebutuhan.

---


## 6️⃣ Konfigurasi Nginx

Nginx dipakai untuk:
- Meneruskan dashboard (`https://ikyypantau.my.id`) → backend `127.0.0.1:8800`
- Meneruskan WebSocket MQTT agent (`wss://ws-mqtt.ikyypantau.my.id/mqtt`) → Mosquitto `127.0.0.1:9001`

### 6.1 Copy config Nginx
```bash
sudo cp ~/ikyypantau/deploy/nginx-ikyypantau.conf /etc/nginx/sites-available/ikyypantau
sudo ln -s /etc/nginx/sites-available/ikyypantau /etc/nginx/sites-enabled/ikyypantau
```

### 6.2 (Opsional) Hapus default site agar tidak bentrok
```bash
sudo rm -f /etc/nginx/sites-enabled/default
```

### 6.3 Tes & reload
```bash
sudo nginx -t
sudo systemctl reload nginx
```

> ⚠️ Kalau `nginx -t` error karena sertifikat belum ada (path `ssl_certificate`), itu normal — selesaikan dulu **Langkah 7 (SSL)** baru reload. Untuk sementara bisa tes dengan meng-comment baris `ssl_certificate` & `ssl_certificate_key` dan ubah `listen 443 ssl` menjadi `listen 443 ssl;` (biarkan), atau langsung lanjut ke langkah 7.

### 6.4 Struktur lokasi yang dilayani
| URL | Diteruskan ke | Fungsi |
|---|---|---|
| `https://ikyypantau.my.id/` | `127.0.0.1:8800` | Dashboard HTML |
| `https://ikyypantau.my.id/ws` | `127.0.0.1:8800` | WebSocket update realtime |
| `https://ikyypantau.my.id/api/...` | `127.0.0.1:8800` | REST API |
| `wss://ws-mqtt.ikyypantau.my.id/mqtt` | `127.0.0.1:9001` | MQTT WebSocket agent |

---

## 7️⃣ SSL / TLS + Cloudflare

Ada **2 pilihan**. Karena `agent.py` sudah didesain memakai Cloudflare (`ws-mqtt.ikyypantau.my.id:443`), **Pilihan A (Cloudflare) paling direkomendasikan.**

### 🅰️ Pilihan A — Cloudflare Origin Certificate (Recommended)

**7A.1** Login ke **https://dash.cloudflare.com** → pilih domain `ikyypantau.my.id`.

**7A.2** Buka menu **SSL/TLS → Origin Server → Create Certificate**.

**7A.3** Biarkan default (RSA 2048, hostname `ikyypantau.my.id` & `*.ikyypantau.my.id`), klik **Create**. Copy **Origin Certificate** dan **Private Key**.

**7A.4** Simpan di VPS:
```bash
sudo mkdir -p /etc/ssl/cloudflare
sudo nano /etc/ssl/cloudflare/ikyypantau.pem   # paste Origin Certificate
sudo nano /etc/ssl/cloudflare/ikyypantau.key   # paste Private Key
sudo chmod 600 /etc/ssl/cloudflare/ikyypantau.key
```

**7A.5** Set mode SSL Cloudflare ke **Full (strict)**: **SSL/TLS → Overview → Full (strict)**.

**7A.6** Atur **DNS Records** (menu **DNS → Records**):
| Type | Name | Content | Proxy status |
|---|---|---|---|
| A | `@` | IP_PUBLIK_VPS | 🟠 Proxied |
| A | `ws-mqtt` | IP_PUBLIK_VPS | 🟠 Proxied |

**7A.7** Aktifkan **WebSockets**: **Network → WebSockets → ON**.

**7A.8** Reload Nginx:
```bash
sudo nginx -t && sudo systemctl reload nginx
```

### 🅱️ Pilihan B — Let's Encrypt (tanpa Cloudflare)

Kalau **tidak** pakai Cloudflare, arahkan domain langsung ke IP VPS (A record di registrar), lalu:
```bash
sudo certbot --nginx -d ikyypantau.my.id -d ws-mqtt.ikyypantau.my.id
```
Certbot otomatis mengubah config Nginx menambahkan sertifikat.

> ⚠️ **Kalau agent langsung ke VPS (tanpa Cloudflare) dengan port 443**, `agent.py` memakai `client.tls_set()` yang **memvalidasi sertifikat**. Jadi sertifikat harus valid (Let's Encrypt). Kalau mau pakai IP langsung tanpa domain + self-signed, ubah `agent.py` jadi `client.tls_set(cert_reqs=ssl.CERT_NONE)` dan tambah `import ssl`.

### Diagram Cloudflare yang benar
```
Cloudflare DNS:
  ikyypantau.my.id        (A)  → IP_VPS  🟠 Proxied
  ws-mqtt.ikyypantau.my.id (A) → IP_VPS  🟠 Proxied

Cloudflare SSL/TLS: Full (strict)
Cloudflare Network: WebSockets = ON
```

---


## 8️⃣ Jalankan Backend sebagai Service (systemd)

Supaya backend otomatis jalan saat VPS reboot dan tetap hidup di background.

### 8.1 Copy & sesuaikan file service
```bash
sudo cp ~/ikyypantau/deploy/lab-monitoring.service /etc/systemd/system/lab-monitoring.service
sudo nano /etc/systemd/system/lab-monitoring.service
```

**Sesuaikan 3 hal penting** (lihat file):
- `User=` → user pemilik project (misal `ubuntu` atau `lab`)
- `WorkingDirectory=` → path project di VPS
- `ExecStart=` → pastikan menunjuk ke `main.js` (Node.js): `/usr/bin/node .../main.js`

Contoh untuk Node.js dengan user `ubuntu`, project di `/home/ubuntu/ikyypantau`:
```ini
[Service]
Type=simple
User=ubuntu
WorkingDirectory=/home/ubuntu/ikyypantau
EnvironmentFile=/home/ubuntu/ikyypantau/.env
ExecStart=/usr/bin/node /home/ubuntu/ikyypantau/main.js
Restart=always
RestartSec=5
```

### 8.2 Aktifkan & jalankan
```bash
sudo systemctl daemon-reload
sudo systemctl enable --now lab-monitoring
sudo systemctl status lab-monitoring --no-pager
```

### 8.3 Lihat log realtime
```bash
sudo journalctl -u lab-monitoring -f
# atau file log project:
tail -f ~/ikyypantau/lab_monitoring.log
```

> Kalau backend belum siap (mis. Nginx belum jalan), service tetap hidup; ia akan reconnect ke MQTT otomatis.

---

## 9️⃣ Firewall (UFW) & Port

Hanya buka port yang perlu. Backend/broker biarkan hanya localhost.

```bash
sudo ufw allow OpenSSH
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw enable
sudo ufw status verbose
```

**Catatan penting:**
- **JANGAN** buka `1883`, `9001`, atau `8800` ke publik — semua akses eksternal lewat Nginx (443).
- Kalau SSH Anda pakai port custom (mis. 2222), ganti: `sudo ufw allow 2222/tcp`.
- Kalau di belakang firewall penyedia VPS (mis. Security Group), buka juga **80** dan **443** di panel penyedia.

---

## 🔟 Konfigurasi Google OAuth

### 10.1 Buka Google Cloud Console
https://console.cloud.google.com → **APIs & Services → Credentials**.

### 10.2 Buat / pilih OAuth Client ID
**Create Credentials → OAuth client ID → Application type: Web application.**

**Authorized JavaScript origins** — tambahkan:
```
https://ikyypantau.my.id
http://localhost:8800
```
**Authorized redirect URIs** — tambahkan (sama):
```
https://ikyypantau.my.id
http://localhost:8800
```

### 10.3 Copy Client ID
Bentuknya seperti `1024514167323-xxxxx.apps.googleusercontent.com`. Ini yang dipakai di:
- `main.js` (baris 61)
- `static/index.html` (baris 851)
- `.env` (`GOOGLE_CLIENT_ID`)

### 10.4 Whitelist email (opsional lewat API)
Setelah login di dashboard, kelola email lewat REST API:
```bash
TOKEN="<session_token_dari_browser>"
curl -H "Authorization: Bearer $TOKEN" https://ikyypantau.my.id/api/admin/emails
curl -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"email":"kawan@gmail.com"}' https://ikyypantau.my.id/api/admin/emails
```

> ⚠️ **Penting:** Karena memakai `httpOnly`/OAuth, domain di Cloudflare **harus `https`** dan **sama persis** dengan yang didaftarkan di Google (tanpa `www` kalau tidak didaftarkan).

---


## 1️⃣1️⃣ Konfigurasi & Jalankan Agent (PC Client)

Agent dijalankan di **setiap PC lab** yang mau dimonitor. Kode `agent.py` tersambung ke broker lewat Cloudflare WebSocket.

### 11.1 Di PC client — install dependency
```bash
pip install psutil paho-mqtt pynvml pywin32 requests
```

### 11.2 Ubah konfigurasi `agent.py` (baris 26-32)
```python
# --- KONFIGURASI BARU (MENGGUNAKAN CLOUDFLARE WEBSOCKET) ---
HOSTNAME = socket.gethostname()
TOPIC = f"lab/monitoring/{HOSTNAME}"

# ✅ Titik ke subdomain Cloudflare Anda
BROKER_URL = "ws-mqtt.ikyypantau.my.id"   # <-- GANTI kalau domain berbeda
PORT = 443                                 # wajib 443 untuk HTTPS/WSS Cloudflare
PING_TARGET = "8.8.8.8"                    # target ping untuk ukur latency
```
> ⚠️ Kalau **tidak** memakai Cloudflare dan agent langsung ke IP VPS, `PORT` dan TLS harus disesuaikan (lihat catatan Langkah 7B).

### 11.3 Token agent (opsional)
`agent.py` versi terbaru **tidak lagi mewajibkan** token. Backend `main.js` tetap mengirim `agent_token` di payload command, tapi agent mengabaikannya. Kalau tetap mau memakai token, samakan `LAB_AGENT_TOKEN` di `.env` (VPS) dengan nilai di `agent.py`. Nilai default: `lab-token-2024`.

### 11.4 Jalankan agent
```bash
python agent.py
```
Output sukses:
```
[✓] CPU Terdeteksi: ...
[*] Menghubungkan ke broker MQTT ws-mqtt.ikyypantau.my.id:443...
[✓] Terhubung dengan sukses ke Cloudflare MQTT Broker
[*] Subscribed ke topik remote: lab/command/PC-LAB-01
```

### 11.5 Auto-start di Windows (opsional)
Buat **Task Scheduler** → *At startup* → Action: `python C:\path\ke\agent.py`. Atau bikin file `start_agent.bat`:
```bat
@echo off
python "C:\path\ke\agent.py"
pause
```
Lalu masukkan ke **Startup** (`shell:startup`).

---

## 1️⃣2️⃣ Testing & Verifikasi

Lakukan dari **atas ke bawah**. Jika satu langkah gagal, perbaiki dulu sebelum lanjut.

### ✅ 12.1 Cek service di VPS
```bash
sudo systemctl status mosquitto --no-pager
sudo systemctl status nginx --no-pager
sudo systemctl status lab-monitoring --no-pager
```

### ✅ 12.2 Cek port listener
```bash
sudo ss -tlnp | grep -E '1883|9001|8800|443|80'
```
Harus ada: `1883` (mosquitto), `9001` (mosquitto ws), `8800` (backend), `443` & `80` (nginx).

### ✅ 12.3 Cek backend lokal (dari dalam VPS)
```bash
curl -s http://127.0.0.1:8800/health | python3 -m json.tool
```
Response yang diharapkan:
```json
{
  "status": "healthy",
  "mode": "mqtt",
  "mqtt_connected": true,
  "active_clients": 0,
  "websocket_connections": 0,
  "active_sessions": 0
}
```
> `mqtt_connected: true` menandakan backend berhasil nyambung ke Mosquitto lokal. 👍

### ✅ 12.4 Cek lewat domain (HTTPS)
```bash
curl -s https://ikyypantau.my.id/health
```
Kalau muncul JSON yang sama → Cloudflare + Nginx + backend **OK**.

### ✅ 12.5 Cek WebSocket MQTT agent dari luar
Di PC agent / laptop lain:
```bash
# pakai mosquitto client (kalau ada):
mosquitto_sub -h ws-mqtt.ikyypantau.my.id -p 443 -t 'lab/monitoring/#' -v
```
Atau jalankan `agent.py` dan lihat pesan `[✓] Terhubung...`.

### ✅ 12.6 Cek dashboard di browser
Buka **https://ikyypantau.my.id** → login (password `LAB_PASSWORD` atau Google) → PC agent harus muncul di grid.

### ✅ 12.7 Cek perintah remote
Di dashboard, pilih salah satu PC → jalankan `whoami` / `tasklist`. Kalau hasilnya muncul, jalur perintah agent → broker → backend → dashboard **berhasil**.

---


## 1️⃣3️⃣ Ringkasan File yang Harus Diubah

| File | Baris | Nilai lama (server hilang) | Nilai baru | Kenapa |
|---|---|---|---|---|
| `main.js` | 29 | `MQTT_BROKER = '10.190.143.25'` | `'127.0.0.1'` | Broker kini di VPS yang sama |
| `main.js` | 17 | `ADMIN_PASSWORD` default `admin123` | password kuat / dari `.env` | Keamanan |
| `main.js` | 19 | `AGENT_TOKEN` default `lab-token-2024` | token baru / dari `.env` | Autentikasi agent |
| `main.js` | 61 | `GOOGLE_CLIENT_ID` (hardcoded) | Client ID Anda | Login Google |
| `static/index.html` | 851 | `GOOGLE_CLIENT_ID` (hardcoded) | Client ID Anda (harus = main) | Login Google |
| `agent.py` | 30 | `BROKER_URL = "ws-mqtt.ikyypantau.my.id"` | domain/subdomain Anda | Titik konek agent |
| `agent.py` | 31 | `PORT = 443` | `443` (Cloudflare) | Port WSS |
| `.env` (baru) | — | — | `LAB_PASSWORD`, `LAB_SECRET_KEY`, `LAB_AGENT_TOKEN`, `GOOGLE_CLIENT_ID` | Konfigurasi terpusat |
| `allowed_emails.json` (baru) | — | — | daftar email Google | Whitelist login |

### File konfigurasi server (yang saya siapkan di folder `deploy/`)
| File di repo | Di-copy ke VPS | Fungsi |
|---|---|---|
| `deploy/mosquitto.conf` | `/etc/mosquitto/conf.d/lab-monitoring.conf` | 2 listener MQTT (1883 + 9001) |
| `deploy/nginx-ikyypantau.conf` | `/etc/nginx/sites-available/ikyypantau` | Proxy dashboard + MQTT WS |
| `deploy/lab-monitoring.service` | `/etc/systemd/system/lab-monitoring.service` | Auto-start backend |
| `deploy/.env.example` | `~/ikyypantau/.env` | Template environment variables |

---

## 1️⃣4️⃣ Troubleshooting

| Gejala | Penyebab umum | Solusi |
|---|---|---|
| `mqtt_connected: false` di `/health` | Mosquitto mati / MQTT_BROKER salah | `sudo systemctl restart mosquitto`; pastikan `MQTT_BROKER='127.0.0.1'` |
| Dashboard tidak bisa dibuka | Nginx/sertifikat/Cloudflare | `sudo nginx -t`; cek DNS Proxied; SSL **Full (strict)** |
| Agent: `[✗] Kesalahan DNS/Jaringan` | Subdomain salah / belum dibuat | Buat A record `ws-mqtt` Proxied |
| Agent: `ConnectionRefused` / gagal TLS | WebSocket Cloudflare OFF / listener 9001 mati | Network → WebSockets ON; cek `ss -tlnp \| grep 9001` |
| WebSocket dashboard putus-putus | Cloudflare/Nginx timeout pendek | Pastikan header `Upgrade`/`Connection` benar (sudah ada di config) |
| Google login error `400 / origin mismatch` | URL tidak terdaftar di Google Console | Tambah `https://ikyypantau.my.id` di Authorized origins |
| "Email tidak terdaftar" | Email tidak di whitelist | Tambah ke `allowed_emails.json` atau via API |
| PC tidak muncul di dashboard | Agent belum jalan / pakai topik beda | Cek output `agent.py`, pastikan `lab/monitoring/<HOSTNAME>` |
| Perintah remote tidak jalan | `AGENT_TOKEN` beda | Samakan token di `.env` (VPS) & agent |
| `nginx -t` error sertifikat | File `.pem`/`.key` belum ada | Selesaikan Langkah 7 dulu |
| Port 443 `Address already in use` | Ada Apache/nginx lain | `sudo systemctl stop apache2` atau cek `sudo ss -tlnp \| grep 443` |

### Perintah cepat (cheat sheet)
```bash
# Restart semua service
sudo systemctl restart mosquitto nginx lab-monitoring

# Log realtime
sudo journalctl -u lab-monitoring -f
sudo tail -f /var/log/nginx/error.log

# Test config nginx & reload
sudo nginx -t && sudo systemctl reload nginx

# Test MQTT lokal
mosquitto_sub -h 127.0.0.1 -t 'lab/monitoring/#' -v

# Health check
curl -s http://127.0.0.1:8800/health | python3 -m json.tool
```

---

## 📌 Checklist Deploy (centang sambil jalan)

- [ ] VPS di-update & dependency terinstall (Node.js, Mosquitto, Nginx)
- [ ] Project sudah di-`git clone` ke VPS
- [ ] `MQTT_BROKER` di backend diubah ke `127.0.0.1`
- [ ] `ADMIN_PASSWORD`, `SECRET_KEY`, `AGENT_TOKEN` diubah + `.env` dibuat
- [ ] `GOOGLE_CLIENT_ID` disamakan di backend & `index.html`
- [ ] `allowed_emails.json` dibuat
- [ ] Mosquitto listen di `1883` + `9001`
- [ ] Nginx proxy dashboard + `/mqtt` aktif
- [ ] Sertifikat SSL terpasang (Cloudflare Origin / Let's Encrypt)
- [ ] DNS Cloudflare: `@` dan `ws-mqtt` → IP VPS (Proxied) + WebSockets ON
- [ ] Backend jalan sebagai systemd service
- [ ] UFW hanya buka 22/80/443
- [ ] Google OAuth origins ditambah domain baru
- [ ] Agent di PC client terhubung (`[✓] Terhubung...`)
- [ ] Dashboard bisa login & menampilkan PC

---

> 🎯 **Selesai!** Setelah semua langkah di atas, server monitoring Anda sudah hidup kembali di VPS baru.
>
> 🔒 **Jangan lupa:** ganti password default, aktifkan WebSockets Cloudflare, dan (disarankan) aktifkan autentikasi user/password di Mosquitto sebelum dipakai produksi.


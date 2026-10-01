# 🔒 Lab Monitoring System - Secure Edition v2.2.0

Sistem monitoring real-time untuk lab komputer dengan dashboard **Cyberpunk theme**, fitur keamanan multi-layer, remote command execution, efek hacker, dukungan **Google Login** (OAuth 2.0), dan **manajemen whitelist email via API**. Bisa diakses dari **HP via ZeroTier**.

![Version](https://img.shields.io/badge/version-2.2.0-blue)
![Node.js](https://img.shields.io/badge/node.js-20%2B-green)
![License](https://img.shields.io/badge/license-MIT-yellow)

---

## 📑 Daftar Isi

- [✨ Fitur Utama](#-fitur-utama)
- [🚀 Instalasi & Setup](#-instalasi--setup)
- [⚙️ Konfigurasi](#️-konfigurasi)
- [📖 Cara Menjalankan](#-cara-menjalankan)
- [📱 Setup ZeroTier (Akses dari HP & Remote)](#-setup-zerotier-akses-dari-hp--remote)
- [🔐 Setup Google OAuth Login](#-setup-google-oauth-login)
- [🌐 API Endpoints](#-api-endpoints)
- [🐛 Troubleshooting](#-troubleshooting)
- [📁 Struktur File](#-struktur-file)
- [📝 Changelog](#-changelog)

---

## ✨ Fitur Utama

### 🖥️ Monitoring
| Fitur | Deskripsi |
|---|---|
| **Real-time** | Update data via WebSocket setiap 1 detik |
| **MQTT Integration** | Data dari agent PC via broker MQTT (support paho-mqtt v1 & v2) |
| **Grid View** | Semua PC dalam card informatif (1/2/3/4 kolom responsive) |
| **Detail Modal** | Info lengkap: OS, CPU, RAM, Storage, GPU, Network, Processes, Files |
| **GPU Monitoring** | NVIDIA (pynvml), AMD/Intel (WMI) dengan temperature & VRAM |
| **Storage Full Scan** | Akumulasi semua partisi/mount di PC |
| **Sparkline Charts** | History CPU & RAM real-time per PC |
| **Live Stats** | Total systems, online, avg CPU, avg RAM |

### 🔐 Autentikasi & Keamanan
| Fitur | Deskripsi |
|---|---|
| **🔑 Dual Login Method** | Login dengan **password admin** ATAU **Google OAuth** (Gmail) |
| **🔒 Login Page** | Password-protected dashboard, session 1 jam |
| **🛡️ Google OAuth 2.0** | Login via Gmail dengan whitelist email yang diizinkan |
| **🔐 Dual Password** | Shutdown/restart/taskkill butuh password lagi |
| **🚫 Brute Force Protection** | Rate limiting + IP blocking (5 gagal = blok 5 menit) |
| **⏱️ Session Management** | Auto logout + countdown timer di header |
| **📝 Audit Log** | Semua login (password & Google) tercatat di `audit.log` |
| **🔒 Security Headers** | XSS, Clickjacking, nosniff protection |
| **📧 Whitelist Email** | Hanya email yang didaftarkan yang bisa Google-login |
| **🔧 Email Management API** | Kelola whitelist email via REST API (CRUD + reload) |
| **⚡ Circuit Breaker** | Pencegah cascade failure pada broadcast WebSocket |

### 💀 Hacker Effects (PC Target!)
Saat **Shutdown** atau **Restart** dijalankan, terminal **PC target** menampilkan:
1. **ASCII Skull** 💀 - Tengkorak merah besar
2. **Pesan Hacker** ⚠️ - "Sistem telah diakses pihak ketiga!"
3. **🌧️ MATRIX RAIN FULL SCREEN** - 80 frame animasi
4. **ACCESS GRANTED** 🔓 - Detail koneksi berhasil
5. **Countdown Progress Bar** ⏳ `[█████░░░] 30 detik`
6. **Windows Popup** 🪟 - DENGAN IP address hacker

### 🎯 Remote Command Execution
| Command | Deskripsi | Keamanan |
|---|---|---|
| `tasklist` | List proses | Normal |
| `ipconfig` | Network config | Normal |
| `whoami` | Current user | Normal |
| `systeminfo` | System info | Normal |
| `taskkill` | Kill process | 🔐 Butuh password! |
| `shutdown` | Matikan PC (30s) | 🔐 + 💀 Efek hacker |
| `restart` | Restart PC (30s) | 🔐 + 💀 Efek hacker |
| `cancel_shutdown` | Batal shutdown | Normal |

---

## 🚀 Instalasi & Setup

### 1. Clone & Install

```bash
# Clone repository
git clone https://github.com/ikyy96/ikyypantau.git
cd ikyypantau

# Install dependencies backend (Node.js)
npm install
```

### 2. Requirements
- **Node.js 20 LTS** untuk backend `main.js`
- Mosquitto MQTT Broker
- Modern browser (Chrome/Edge/Firefox/Safari)
- (Opsional) ZeroTier untuk akses HP/remote
- **Python 3.8+** hanya untuk `agent.py` di PC client (bukan backend)

### 3. Dependencies Backend (`main.js`)
| Package | Versi | Fungsi |
|---|---|---|
| `express` | ^4.18.2 | Backend web framework |
| `express-session` | ^1.17.3 | Session management |
| `ws` | ^8.16.0 | WebSocket server |
| `mqtt` | ^5.3.0 | MQTT client |

> ℹ️ `requirements.txt` hanya untuk `agent.py` di PC client (`pip install -r requirements.txt`), **bukan** untuk backend.

---

## ⚙️ Konfigurasi

### 🔐 1. Ubah Password Admin
```javascript
// Di main.js - cari baris ini:
const ADMIN_PASSWORD = process.env.LAB_PASSWORD || 'admin123';
// ^^^^ UBAH 'admin123' dengan password kuat!
```
Atau via environment variable (lebih aman):
```bash
# Windows
set LAB_PASSWORD=passwordkuatbanget123

# Linux/Mac
export LAB_PASSWORD=passwordkuatbanget123
```

### 🌐 2. Konfigurasi IP Broker MQTT
**Server (main.js):** `MQTT_BROKER = '127.0.0.1'` atau IP ZeroTier  
**Agent (agent.py):** `BROKER_URL = "<IP_SERVER>"` (IP yang bisa diakses agent)

### 🔑 3. Environment Variables
| Variable | Default | Deskripsi |
|---|---|---|
| `LAB_PASSWORD` | `admin123` | Password admin login |
| `LAB_SECRET_KEY` | (random) | Secret key untuk session cookie |
| `LAB_AGENT_TOKEN` | `lab-token-2024` | Token autentikasi agent |
| `GOOGLE_CLIENT_ID` | - | Google OAuth Client ID |
| `ALLOWED_EMAILS` | - | Daftar email (comma-separated) |

### 📧 4. Kelola Whitelist Email
Daftar email yang diizinkan login via Google bisa dikelola dengan 3 cara:

**Cara 1: Via REST API (Recommended)**
```bash
# Lihat semua email
curl -H "Authorization: Bearer <session_token>" http://localhost:8800/api/admin/emails

# Tambah email
curl -X POST -H "Authorization: Bearer <session_token>" \
  -H "Content-Type: application/json" \
  -d '{"email": "user@gmail.com"}' \
  http://localhost:8800/api/admin/emails

# Tambah multiple email
curl -X POST -H "Authorization: Bearer <session_token>" \
  -H "Content-Type: application/json" \
  -d '{"emails": ["a@gmail.com", "b@gmail.com"]}' \
  http://localhost:8800/api/admin/emails

# Hapus email
curl -X DELETE -H "Authorization: Bearer <session_token>" \
  http://localhost:8800/api/admin/emails/user@gmail.com
```

**Cara 2: Edit File `allowed_emails.json`**
```json
{
  "emails": [
    "email1@gmail.com",
    "email2@gmail.com"
  ]
}
```
Setelah edit, reload via API: `POST /api/admin/emails/reload`

**Cara 3: Environment Variable**
```bash
set ALLOWED_EMAILS=email1@gmail.com,email2@gmail.com
```

---

## 📖 Cara Menjalankan

```bash
# Install dependency (sekali saja)
npm install

# Jalankan backend (Node.js)
node main.js
# atau
npm start

# Demo mode (tanpa MQTT, untuk testing)
# Set USE_MQTT = false di main.js
```

### Menjalankan Agent di Client PC
```bash
# Install dependencies di client
pip install psutil paho-mqtt pynvml

# Edit BROKER_URL di agent.py sesuai IP server
# Jalankan
python agent.py
```

### 🔍 Health Check
```bash
curl http://localhost:8800/health
```
Response:
```json
{
  "status": "healthy",
  "mode": "mqtt",
  "mqtt_connected": true,
  "active_clients": 8,
  "websocket_connections": 2,
  "active_sessions": 1,
  "uptime": "2:30:00"
}
```

---

## 📱 Setup ZeroTier (Akses dari HP & Remote)

ZeroTier memungkinkan semua device (HP, laptop lain) terhubung ke dashboard meskipun berada di jaringan berbeda (WiFi rumah, kantor, cellular).

### Arsitektur
```
INTERNET 🌐
     │
     └── ZeroTier Virtual Network 🔷  (contoh: 10.147.x.x)
          │
          ├── [🖥️ SERVER]  main.js + Mosquitto
          │    ├── ZeroTier IP: 10.147.1.1 (static)
          │    ├── Dashboard → port 8800
          │    └── MQTT Broker → port 1883
          │
          ├── [💻 CLIENT A - Windows]  agent.py
          │    └── ZeroTier IP: 10.147.1.2
          │
          ├── [💻 CLIENT B - Ubuntu]  agent.py
          │    └── ZeroTier IP: 10.147.1.3
          │
          └── [📱 HANDPHONE]  (cukup join ZeroTier)
               └── Buka: http://10.147.1.1:8800
```

### Langkah 1: Buat Akun & Jaringan ZeroTier

1. Buka **https://my.zerotier.com** → Register/Login
2. Klik **"Create A Network"** → Catat **Network ID** (16 karakter)
3. Beri nama: `Lab Monitoring`
4. Biarkan **IPv4 Auto-Assign** default (`10.147.0.0/16`)
5. **Enable Broadcast**: ✅ Centang

### Langkah 2: Install ZeroTier di Server (Ubuntu)

```bash
curl -s https://install.zerotier.com | sudo bash
sudo zerotier-cli join [NETWORK_ID_ANDA]
sudo systemctl enable zerotier-one
sudo systemctl start zerotier-one
```

### Langkah 3: Install ZeroTier di Client (Windows)

1. Download: https://www.zerotier.com/download/
2. Install sebagai **Administrator**
3. Buka ZeroTier di system tray → **Join New Network** → Masukkan Network ID

Atau via CMD (Admin):
```cmd
"C:\Program Files\ZeroTier\One\zerotier-cli.bat" join [NETWORK_ID_ANDA]
```

### Langkah 4: Install ZeroTier di HP Android

1. Download **ZeroTier** dari Play Store
2. Masukkan **Network ID**
3. Di ZeroTier Console → authorize device (centang Auth?)

### Langkah 5: Set IP Static Server

1. Di ZeroTier Console → tab **Members**
2. Cari server Anda → **Centang "Auth?"**
3. Klik IP address → Ganti ke `10.147.1.1` → Save
4. Beri Name: `Server`

### Langkah 6: Konfigurasi DNS (Opsional - Akses via Domain)

Di ZeroTier Console → tab **Advanced** → **DNS Configuration**:
```
Domain:  ikyypantau.my.id
Server:  10.147.1.1
```
Klik **Save**, lalu restart ZeroTier di semua device.

### Langkah 7: Firewall

**Ubuntu:**
```bash
sudo ufw allow from 10.147.0.0/16 to any port 1883 proto tcp
sudo ufw allow from 10.147.0.0/16 to any port 8800 proto tcp
```

**Windows:**
```cmd
netsh advfirewall firewall add rule name="Dashboard 8800" dir=in action=allow protocol=TCP localport=8800
netsh advfirewall firewall add rule name="MQTT 1883" dir=in action=allow protocol=TCP localport=1883
```

### Langkah 8: Akses Dashboard

- Dari server: `http://localhost:8800`
- Dari device ZeroTier: `http://10.147.1.1:8800`
- Dari HP: Install ZeroTier → Join network → Buka `http://10.147.1.1:8800`

---

## 🔐 Setup Google OAuth Login

### Langkah 1: Buat Project di Google Cloud Console

1. Buka **https://console.cloud.google.com**
2. Buat Project Baru: `lab-monitoring`

### Langkah 2: Aktifkan Google OAuth API

1. Menu kiri → **APIs & Services** → **Library**
2. Cari: **"Google Identity Services API"** → Klik **Enable**

### Langkah 3: OAuth Consent Screen

1. **APIs & Services** → **OAuth consent screen**
2. Pilih **"External"** → **Create**
3. Isi App name: `Lab Monitoring`, email Anda
4. **Scopes**: Tambah `userinfo.email` dan `userinfo.profile`
5. **Test Users**: Tambah email yang boleh login
6. **Save and Continue**

### Langkah 4: Buat OAuth Credentials

1. **APIs & Services** → **Credentials** → **+ Create Credentials** → **OAuth client ID**
2. **Application type**: `Web application`
3. **Authorized JavaScript origins**: Tambah URL dashboard
   - `http://localhost:8800`
   - `http://<ZEROTIER_IP_SERVER>:8800`
4. **Authorized redirect URIs**: Sama dengan origins
5. Klik **Create** → Copy **Client ID**

### Langkah 5: Update main.js

```javascript
// Ganti dengan Client ID dari Google Cloud Console!
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '123456789-xxxxx.apps.googleusercontent.com';
```

### Langkah 6: Samakan Client ID

Samakan `GOOGLE_CLIENT_ID` di **dua tempat**: `main.js` dan `static/index.html`.
Tidak perlu install dependency tambahan — verifikasi Google OAuth sudah ditangani `main.js` (Express), bukan Python.

### Verifikasi

1. Buka dashboard → Klik **"Sign in with Google"**
2. Pilih akun Google → Jika email di whitelist → Dashboard terbuka ✅
3. Jika email tidak terdaftar → Error "Akses ditolak" ❌

> 💡 **Tips**: Semua email yang login tercatat di `audit.log`

---

## 🌐 API Endpoints

| Endpoint | Method | Auth | Deskripsi |
|---|---|---|---|
| `/` | GET | ❌ | Dashboard (HTML) |
| `/login` | GET | ❌ | Halaman login |
| `/api/login` | POST | ❌ | Login dengan password |
| `/api/auth/google` | POST | ❌ | Login dengan Google OAuth |
| `/api/auth/check` | GET | ❌ | Cek status auth |
| `/api/logout` | POST | ✅ | Logout |
| `/ws` | WS | ✅ | WebSocket real-time updates |
| `/api/clients` | GET | ✅ | Data semua client |
| `/api/stats` | GET | ✅ | Statistics |
| `/api/command` | POST | ✅ | Execute remote command |
| `/api/command/result/{id}` | GET | ✅ | Hasil command |
| `/api/commands/whitelist` | GET | ✅ | Available commands |
| `/api/admin/emails` | GET | ✅ | List email whitelist |
| `/api/admin/emails` | POST | ✅ | Tambah email ke whitelist |
| `/api/admin/emails/{email}` | DELETE | ✅ | Hapus email dari whitelist |
| `/api/admin/emails/reload` | POST | ✅ | Reload email dari file |
| `/health` | GET | ❌ | Health check (MQTT status) |

---

## 🔒 Keamanan Detail

### 🔐 Password Login
1. User memasukkan password
2. Rate limiter: max 5x gagal → IP diblokir 5 menit
3. Session token di-generate, expire 1 jam
4. Token disimpan di localStorage + dikirim via header

### 📧 Google OAuth Login
1. User klik "Sign in with Google" → Popup muncul
2. ID Token dikirim ke backend `/api/auth/google`
3. Backend verify token dengan Google → Cek email di whitelist
4. Jika ya → session dibuat, jika tidak → 403 Forbidden
5. Semua percobaan login tercatat di `audit.log`

### 🛡️ Brute Force Protection
- **Rate Limiter**: 30 request/menit per IP
- **Command Limiter**: 5 command/menit per IP
- **Login Blocker**: 5x gagal → IP diblokir 5 menit
- **Session Timeout**: Auto logout setelah 1 jam
- **Circuit Breaker**: Threshold 10 kegagalan broadcast → OPEN selama 60 detik

### 📝 Audit Trail
File `audit.log` mencatat:
```
LOGIN_SUCCESS | IP: 192.168.x.x
GOOGLE_LOGIN_SUCCESS | Email: user@gmail.com | IP: 192.168.x.x
GOOGLE_LOGIN_DENIED | Email: hacker@evil.com | IP: 10.x.x.x
COMMAND | IP: ... | Target: PC-LAB-01 | Command: shutdown
DANGEROUS_CMD_NO_PASS | IP: ... | Command: restart
LOGOUT | IP: ...
UNAUTHORIZED_CMD | IP: ... | Command: format
EMAILS_ADDED | IP: ... | Emails: newuser@gmail.com
EMAIL_REMOVED | IP: ... | Email: olduser@gmail.com
```

---

## 🐛 Troubleshooting

| Masalah | Solusi |
|---|---|
| Login gagal "Password salah" | Cek `LAB_PASSWORD` di main.js atau environment variable |
| IP diblokir 5 menit | Tunggu atau restart server |
| Session expired | Login ulang (session 1 jam) |
| Google Sign-In button tidak muncul | Cek koneksi internet, atau `GOOGLE_CLIENT_ID` di main.js |
| "Email tidak terdaftar" | Tambahkan email ke `allowed_emails.json` atau via API |
| Google login popup error 400 | Cek **Authorized JavaScript origins** di Google Console |
| Login gagal di HP | Pastikan URL di HP sama dengan yang didaftarkan di Google Console |
| MQTT connection failed | Pastikan Mosquitto running, cek firewall port 1883 |
| Tidak ada data di dashboard | Pastikan agent.py berjalan di PC client |
| Agent "Connection Refused" | Verifikasi IP broker di agent.py (`BROKER_URL`) |
| Circuit breaker OPEN | Tunggu 60 detik untuk recovery atau restart server |
| Domain tidak resolve (ZeroTier) | Restart ZeroTier, cek DNS config di Console |
| HP Android tidak bisa akses | Install ZeroTier dari Play Store, join network, authorize |
| Agent token tidak valid | Token agent bersifat opsional; samakan `LAB_AGENT_TOKEN` di `.env`/main.js bila dipakai |

---

## 📁 Struktur File

```
├── main.js              # Backend Node.js + MQTT + WebSocket + Auth (SATU-SATUNYA backend)
├── package.json         # Node.js dependencies
├── agent.py             # Agent client PC (Python) + 💀 Efek hacker
├── requirements.txt     # Python dependencies (untuk agent.py saja)
├── deploy/              # Konfigurasi deploy VPS (mosquitto, nginx, systemd, .env)
├── static/
│   ├── index.html       # Frontend dashboard (responsive + Google Login)
│   └── favicon.png      # Icon dashboard
├── allowed_emails.json  # Whitelist email untuk Google OAuth (auto-generated)
├── commands.log         # Log remote commands
├── audit.log            # Log keamanan (login, Google auth, dll)
├── lab_monitoring.log   # Log backend
└── README.md            # Dokumentasi ini
```

---

## 📝 Changelog

### v2.2.0 (Current)
- 🟢 **Backend Node.js (`main.js`)** — satu-satunya backend project. Versi Python (`main.py`) dihapus total agar tidak ada dua backend.
- 📧 **Email Whitelist Management API** - CRUD whitelist email via REST API
- 💾 **Persistent Email Storage** - `allowed_emails.json` untuk persistensi
- 🔄 **Email Reload** - Reload email whitelist tanpa restart server
- ⚡ **Circuit Breaker Pattern** - Pencegah cascade failure pada broadcast WebSocket
- 🔌 **paho-mqtt v1 & v2 Compatibility** - Auto-detect versi paho-mqtt
- 📊 **Enhanced Health Check** - Detail info: mode, MQTT status, sessions, circuit breaker
- 🛡️ **Improved Error Handling** - Global exception handler + structured error responses
- 🔧 **Fixed Agent Token Validation** - Token agent dikirim dalam payload command

### v2.1.0
- 🔑 **Login dengan Google OAuth** (whitelist email)
- 🔔 **Notification system** (toast animasi success/error)
- 📱 **Hamburger Menu** untuk HP (drawer slide-in)
- 🎨 **Login page redesign** dengan Google button + divider
- ⚡ **Mobile responsive** lengkap

### v2.0.0 - Secure Edition
- 🔒 Login password + session 1 jam
- 🔐 Dual password untuk command berbahaya
- 🛡️ Brute force protection + rate limiter
- 📝 Audit log
- 💀 Matrix Rain + Hacker Effects
- 🎯 Remote command execution (8 commands)
- 🌐 WebSocket real-time updates

### v1.0.0
- Basic WebSocket + MQTT + Demo mode

---

## 🤝 Kontribusi

1. Fork repo
2. Buat branch (`git checkout -b feature/AmazingFeature`)
3. Commit changes (`git commit -m 'Add some AmazingFeature'`)
4. Push (`git push origin feature/AmazingFeature`)
5. Buat Pull Request

---

## 📄 Lisensi

MIT License - Bebas digunakan untuk edukasi, penelitian, dan pengembangan.

---

> ⚠️ **Peringatan**: Efek hacker hanya visual di terminal. Tidak ada yang di-hack sungguhan. Sistem ini untuk **edukasi monitoring lab komputer**.

> 🔒 **Keamanan**: Selalu ubah `ADMIN_PASSWORD` default dan setup whitelist Google email sebelum production!

---

**Repository**: [github.com/ikyy96/web-lab-monitoring-system](https://github.com/ikyy96/web-lab-monitoring-system)
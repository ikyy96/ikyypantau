/**
 * Lab Monitoring System - Node.js Realtime Edition
 * Express + MQTT + WebSocket + Demo Mode
 * Version: 2.2.0 - Port from Python/FastAPI
 */

const express = require('express');
const http = require('http');
const { WebSocketServer, WebSocket } = require('ws');
const mqtt = require('mqtt');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const session = require('express-session');

// ==================== CONFIGURATION ====================
const ADMIN_PASSWORD = process.env.LAB_PASSWORD || 'admin123';
const SECRET_KEY = process.env.LAB_SECRET_KEY || crypto.randomBytes(32).toString('hex');
const AGENT_TOKEN = process.env.LAB_AGENT_TOKEN || '';
if (!AGENT_TOKEN) {
    console.error('LAB_AGENT_TOKEN belum di-set di .env. Backend tidak bisa menandatangani perintah. Berhenti.');
    process.exit(1);
}
const MQTT_USER = process.env.LAB_MQTT_USER || '';
const MQTT_PASS = process.env.LAB_MQTT_PASS || '';
const PROCESS_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const SESSION_MAX_AGE = 3600;      // 1 hour
const SESSION_REFRESH_AGE = 600;   // 10 minutes
const RATE_LIMIT_WINDOW = 60;
const RATE_LIMIT_MAX = 30;
const COMMAND_RATE_LIMIT_MAX = 5;
const FAILED_LOGIN_LIMIT = 5;
const FAILED_LOGIN_BLOCK = 300;

// MQTT Configuration
const MQTT_BROKER = process.env.MQTT_BROKER || '127.0.0.1';
const MQTT_PORT = 1883;
const MQTT_TOPIC = 'lab/monitoring/+';
const MQTT_COMMAND_RESULT_TOPIC = 'lab/command/result/+';
const MQTT_CLIENT_ID = `monitoring_${Date.now()}`;
const SERVER_PORT = 8800;
const USE_MQTT = true;

// Error handling config
const MAX_RECONNECT_DELAY = 300;
const INITIAL_RECONNECT_DELAY = 5;
const MAX_BROADCAST_RETRIES = 3;
const BROADCAST_TIMEOUT = 5000;
const MAX_CLIENTS = 1000;
const MAX_HISTORY_LENGTH = 50;
const OFFLINE_TIMEOUT = 15;

// Command Configuration
const COMMAND_WHITELIST = {
    'tasklist': 'List processes',
    'ipconfig': 'Network configuration',
    'whoami': 'Current user',
    'systeminfo': 'System information',
    'taskkill': 'Kill process',
    'shutdown': '⚠️ Shutdown PC (30 detik)',
    'restart': '🔄 Restart PC (30 detik)',
    'cancel_shutdown': '❌ Cancel scheduled shutdown/restart',
};
const DANGEROUS_COMMANDS = ['shutdown', 'restart', 'taskkill'];
const COMMAND_PARAMS = { 'taskkill': ['process_name'] };

// Google OAuth
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '1024514167323-0pc62a62d85jrjor7tqaeme12lt7pk2n.apps.googleusercontent.com';
const ALLOWED_EMAILS_FILE = path.join(__dirname, 'allowed_emails.json');

// Demo PC data
const DEMO_PCS = [
    { id: 'PC-LAB-01', ip: '10.230.250.101', user: 'student1', os: 'Windows 11 Pro' },
    { id: 'PC-LAB-02', ip: '10.230.250.102', user: 'student2', os: 'Windows 11 Pro' },
    { id: 'PC-LAB-03', ip: '10.230.250.103', user: 'student3', os: 'Ubuntu 22.04' },
    { id: 'PC-LAB-04', ip: '10.230.250.104', user: 'student4', os: 'Windows 11 Pro' },
    { id: 'PC-LAB-05', ip: '10.230.250.105', user: 'student5', os: 'Windows 11 Pro' },
    { id: 'PC-LAB-06', ip: '10.230.250.106', user: 'student6', os: 'Ubuntu 22.04' },
    { id: 'PC-LAB-07', ip: '10.230.250.107', user: 'student7', os: 'Windows 11 Pro' },
    { id: 'PC-LAB-08', ip: '10.230.250.108', user: 'student8', os: 'Windows 11 Pro' },
];
const PROCESS_NAMES = ['chrome.exe', 'python.exe', 'code.exe', 'discord.exe', 'spotify.exe',
    'firefox.exe', 'node.exe', 'java.exe', 'pycharm.exe', 'slack.exe'];
const FILE_NAMES = ['lecture_video.mp4', 'project_backup.zip', 'dataset.csv', 'presentation.pptx',
    'research_paper.pdf', 'database_dump.sql', 'vm_image.vdi', 'photos.zip'];

// ==================== LOGGING ====================
function log(level, ...args) {
    const ts = new Date().toISOString();
    const msg = `[${ts}] [${level.toUpperCase()}]`;
    if (level === 'error') console.error(msg, ...args);
    else if (level === 'warn') console.warn(msg, ...args);
    else console.log(msg, ...args);
}

const logger = {
    info: (...args) => log('info', ...args),
    warn: (...args) => log('warn', ...args),
    error: (...args) => log('error', ...args),
    debug: (...args) => { /* silent in production */ },
};

// ==================== EMAIL WHITELIST ====================
function loadAllowedEmails() {
    if (fs.existsSync(ALLOWED_EMAILS_FILE)) {
        try {
            const data = JSON.parse(fs.readFileSync(ALLOWED_EMAILS_FILE, 'utf-8'));
            const emails = data.emails || [];
            if (emails.length > 0) {
                logger.info(`📧 Loaded ${emails.length} allowed emails from ${ALLOWED_EMAILS_FILE}`);
                return emails.map(e => e.trim().toLowerCase()).filter(e => e);
            }
        } catch (e) {
            logger.warn(`⚠️ Failed to load allowed_emails.json: ${e.message}`);
        }
    }
    const envEmails = process.env.ALLOWED_EMAILS || '';
    if (envEmails) {
        return envEmails.split(',').map(e => e.trim().toLowerCase()).filter(e => e);
    }
    return ['rizkyharun122@gmail.com'];
}

function saveAllowedEmails(emailsList) {
    try {
        const normalized = [...new Set(emailsList.map(e => e.trim().toLowerCase()).filter(e => e))].sort();
        const data = {
            emails: normalized,
            last_updated: new Date().toISOString(),
            total: normalized.length,
        };
        fs.writeFileSync(ALLOWED_EMAILS_FILE, JSON.stringify(data, null, 2), 'utf-8');
        logger.info(`💾 Saved ${normalized.length} emails to ${ALLOWED_EMAILS_FILE}`);
        return true;
    } catch (e) {
        logger.error(`❌ Failed to save allowed_emails.json: ${e.message}`);
        return false;
    }
}

let ALLOWED_EMAILS_LIST = loadAllowedEmails();
logger.info(`📧 [EMAIL WHITELIST] ${ALLOWED_EMAILS_LIST.length} email(s) terdaftar: ${ALLOWED_EMAILS_LIST.join(', ')}`);

// ==================== SECURITY UTILITIES ====================
// Tanda tangan perintah ke agent (HMAC-SHA256). Format pesan harus sama persis dengan agent.py:
// request_id|command|timestamp|canonical(params)
function canonical(v) {
    if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
    if (v && typeof v === 'object') {
        return '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}';
    }
    return JSON.stringify(v);
}

function signCommand(requestId, command, timestamp, params) {
    const msg = `${requestId}|${command}|${timestamp}|${canonical(params || {})}`;
    return crypto.createHmac('sha256', AGENT_TOKEN).update(msg).digest('hex');
}

class RateLimiter {
    constructor(window = 60, maxRequests = 30) {
        this.window = window;
        this.maxRequests = maxRequests;
        this.requests = {};
    }
    isAllowed(key) {
        const now = Date.now() / 1000;
        if (!this.requests[key]) this.requests[key] = [];
        this.requests[key] = this.requests[key].filter(t => now - t < this.window);
        if (this.requests[key].length >= this.maxRequests) return false;
        this.requests[key].push(now);
        return true;
    }
    getRemaining(key) {
        const now = Date.now() / 1000;
        if (!this.requests[key]) return this.maxRequests;
        this.requests[key] = this.requests[key].filter(t => now - t < this.window);
        return Math.max(0, this.maxRequests - this.requests[key].length);
    }
}

class FailedLoginTracker {
    constructor(maxAttempts = 5, blockTime = 300) {
        this.maxAttempts = maxAttempts;
        this.blockTime = blockTime;
        this.attempts = {};
    }
    recordFailure(ip) {
        if (!this.attempts[ip]) this.attempts[ip] = { count: 0, blockedUntil: 0 };
        this.attempts[ip].count++;
        if (this.attempts[ip].count >= this.maxAttempts) {
            this.attempts[ip].blockedUntil = Date.now() / 1000 + this.blockTime;
        }
    }
    isBlocked(ip) {
        if (!this.attempts[ip]) return false;
        const now = Date.now() / 1000;
        if (now < this.attempts[ip].blockedUntil) return true;
        if (this.attempts[ip].blockedUntil > 0 && now > this.attempts[ip].blockedUntil) {
            this.attempts[ip] = { count: 0, blockedUntil: 0 };
        }
        return false;
    }
    reset(ip) {
        this.attempts[ip] = { count: 0, blockedUntil: 0 };
    }
}

const apiRateLimiter = new RateLimiter(60, RATE_LIMIT_MAX);
const commandRateLimiter = new RateLimiter(60, COMMAND_RATE_LIMIT_MAX);
const loginTracker = new FailedLoginTracker(FAILED_LOGIN_LIMIT, FAILED_LOGIN_BLOCK);

function verifyPassword(password) {
    if (password === ADMIN_PASSWORD) return true;
    if (ADMIN_PASSWORD.length === 64) {
        return crypto.createHash('sha256').update(password).digest('hex') === ADMIN_PASSWORD;
    }
    return false;
}

// ==================== CIRCUIT BREAKER ====================
class CircuitBreaker {
    constructor(failureThreshold = 5, recoveryTimeout = 30) {
        this.failureThreshold = failureThreshold;
        this.recoveryTimeout = recoveryTimeout;
        this.failureCount = 0;
        this.lastFailureTime = null;
        this.state = 'CLOSED';
    }
    call(fn) {
        if (this.state === 'OPEN') {
            if (Date.now() / 1000 - this.lastFailureTime > this.recoveryTimeout) {
                this.state = 'HALF_OPEN';
            } else {
                throw new Error('Circuit breaker is OPEN');
            }
        }
        try {
            const result = fn();
            if (this.state === 'HALF_OPEN') {
                this.state = 'CLOSED';
                this.failureCount = 0;
            }
            return result;
        } catch (e) {
            this.failureCount++;
            this.lastFailureTime = Date.now() / 1000;
            if (this.failureCount >= this.failureThreshold) this.state = 'OPEN';
            throw e;
        }
    }
}

const broadcastCircuitBreaker = new CircuitBreaker(10, 60);

// ==================== CLIENT STATE ====================
const clients = {};
const activeConnections = new Set();
const sessions = {};
const pendingCommands = {};
const commandResults = {};

const stats = {
    total_messages: 0,
    failed_messages: 0,
    broadcast_failures: 0,
    mqtt_reconnects: 0,
    start_time: new Date(),
};

function createClientState(id, data = {}) {
    return {
        id,
        status: data.status || 'offline',
        user: data.user || '',
        time: data.time || '',
        ip: data.ip || '',
        mac: data.mac || '',
        iface: data.iface || '',
        uptime: data.uptime || '',
        os: data.os || '',
        cpu_name: data.cpu_name || '',
        cpu_percent: data.cpu_percent || 0,
        cpu_threads: data.cpu_threads || 0,
        cpu_cores: data.cpu_cores || 0,
        cpu_ghz: data.cpu_ghz || 0,
        cpu_max_ghz: data.cpu_max_ghz || 0,
        ram_percent: data.ram_percent || 0,
        ram_used_gb: data.ram_used_gb || 0,
        ram_total_gb: data.ram_total_gb || 0,
        storage_total_gb: data.storage_total_gb || 0,
        storage_used_gb: data.storage_used_gb || 0,
        storage_free_gb: data.storage_free_gb || 0,
        storage_percent: data.storage_percent || 0,
        down_mbps: data.down_mbps || 0,
        traffic_in_gb: data.traffic_in_gb || 0,
        latency_ms: data.latency_ms || 0,
        top_processes: data.top_processes || [],
        top_files: data.top_files || [],
        gpu: data.gpu || [],
        last_seen: data.last_seen || '',
        last_seen_ts: data.last_seen_ts || 0,
        cpu_history: data.cpu_history || [],
        ram_history: data.ram_history || [],
    };
}

function validatePayloadStructure(payload) {
    if (typeof payload !== 'object' || payload === null) return false;
    if (payload.metrics) {
        const metrics = payload.metrics;
        if (typeof metrics !== 'object') return false;
        if (metrics.cpu && typeof metrics.cpu !== 'object') return false;
        if (metrics.cpu && metrics.cpu.percent !== undefined && typeof metrics.cpu.percent !== 'number') return false;
        if (metrics.ram_percent !== undefined && typeof metrics.ram_percent !== 'number') return false;
    }
    return true;
}

function safeUpdateClientState(clientId, data) {
    try {
        if (!clients[clientId] && Object.keys(clients).length >= MAX_CLIENTS) {
            logger.warn(`Maximum clients (${MAX_CLIENTS}) reached. Ignoring: ${clientId}`);
            return;
        }
        if (!clients[clientId]) {
            clients[clientId] = createClientState(clientId);
        }
        const client = clients[clientId];

        if (data.status !== undefined) client.status = String(data.status);
        if (data.user !== undefined) client.user = String(data.user);
        if (data.time !== undefined) client.time = String(data.time);
        client.last_seen = new Date().toLocaleTimeString('en-US', { hour12: false });
        client.last_seen_ts = Date.now() / 1000;

        const network = data.network || {};
        if (typeof network === 'object') {
            if (network.ip !== undefined) client.ip = String(network.ip);
            if (network.mac !== undefined) client.mac = String(network.mac);
            if (network.iface !== undefined) client.iface = String(network.iface);
            if (network.down_mbps !== undefined) client.down_mbps = parseFloat(network.down_mbps) || client.down_mbps;
            if (network.traffic_in_gb !== undefined) client.traffic_in_gb = parseFloat(network.traffic_in_gb) || client.traffic_in_gb;
            if (network.latency_ms !== undefined) client.latency_ms = parseFloat(network.latency_ms) || client.latency_ms;
        }

        const info = data.info || {};
        if (typeof info === 'object') {
            if (info.uptime !== undefined) client.uptime = String(info.uptime);
            if (info.os !== undefined) client.os = String(info.os);
            if (info.cpu_name !== undefined) client.cpu_name = String(info.cpu_name);
        }

        const metrics = data.metrics || {};
        if (typeof metrics === 'object') {
            const cpu = metrics.cpu || {};
            if (typeof cpu === 'object') {
                if (cpu.percent !== undefined) client.cpu_percent = parseFloat(cpu.percent) || 0;
                if (cpu.threads !== undefined) client.cpu_threads = parseInt(cpu.threads) || 0;
                if (cpu.cores !== undefined) client.cpu_cores = parseInt(cpu.cores) || 0;
                if (cpu.ghz !== undefined) client.cpu_ghz = parseFloat(cpu.ghz) || 0;
                if (cpu.max_ghz !== undefined) client.cpu_max_ghz = parseFloat(cpu.max_ghz) || 0;
            }
            if (metrics.ram_percent !== undefined) client.ram_percent = parseFloat(metrics.ram_percent) || 0;
            const ram = metrics.ram || {};
            if (typeof ram === 'object') {
                if (ram.used_gb !== undefined) client.ram_used_gb = parseFloat(ram.used_gb) || 0;
                if (ram.total_gb !== undefined) client.ram_total_gb = parseFloat(ram.total_gb) || 0;
            }
            const storage = metrics.storage || {};
            if (typeof storage === 'object') {
                if (storage.total_gb !== undefined) client.storage_total_gb = parseFloat(storage.total_gb) || 0;
                if (storage.used_gb !== undefined) client.storage_used_gb = parseFloat(storage.used_gb) || 0;
                if (storage.free_gb !== undefined) client.storage_free_gb = parseFloat(storage.free_gb) || 0;
                if (storage.percent !== undefined) client.storage_percent = parseFloat(storage.percent) || 0;
            }
            if (Array.isArray(metrics.top_processes)) client.top_processes = metrics.top_processes.slice(0, 10);
            if (Array.isArray(metrics.top_files)) client.top_files = metrics.top_files.slice(0, 10);
            if (Array.isArray(metrics.gpu)) client.gpu = metrics.gpu.slice(0, 5);
        }

        client.cpu_history.push(client.cpu_percent);
        client.ram_history.push(client.ram_percent);
        if (client.cpu_history.length > MAX_HISTORY_LENGTH) client.cpu_history = client.cpu_history.slice(-MAX_HISTORY_LENGTH);
        if (client.ram_history.length > MAX_HISTORY_LENGTH) client.ram_history = client.ram_history.slice(-MAX_HISTORY_LENGTH);

        stats.total_messages++;
    } catch (e) {
        logger.error(`Error updating client state for ${clientId}: ${e.message}`);
        stats.failed_messages++;
    }
}

function getSafeStats() {
    return {
        ...stats,
        start_time: stats.start_time instanceof Date ? stats.start_time.toISOString() : stats.start_time,
    };
}

function buildClientsList() {
    return Object.values(clients).map(c => typeof c === 'object' ? c : c);
}

// ==================== BROADCAST ====================
function safeBroadcastUpdate() {
    if (activeConnections.size === 0) return;
    try {
        const messageObj = {
            type: 'update',
            clients: buildClientsList(),
            timestamp: new Date().toISOString(),
            stats: getSafeStats(),
        };
        const message = broadcastCircuitBreaker.call(() => JSON.stringify(messageObj));
        const disconnected = new Set();
        for (const conn of activeConnections) {
            try {
                if (conn.readyState === WebSocket.OPEN) {
                    conn.send(message);
                } else {
                    disconnected.add(conn);
                }
            } catch {
                disconnected.add(conn);
            }
        }
        for (const d of disconnected) activeConnections.delete(d);
    } catch (e) {
        logger.error(`Broadcast failed: ${e.message}`);
        stats.broadcast_failures++;
    }
}

// ==================== SESSION MANAGEMENT ====================
function createSession() {
    const token = crypto.randomBytes(32).toString('hex');
    sessions[token] = {
        createdAt: Date.now() / 1000,
        lastActive: Date.now() / 1000,
        ip: '',
        userAgent: '',
    };
    return token;
}

function validateSession(token) {
    if (!token || !sessions[token]) return false;
    const sess = sessions[token];
    if (Date.now() / 1000 - sess.lastActive > SESSION_MAX_AGE) {
        delete sessions[token];
        return false;
    }
    sess.lastActive = Date.now() / 1000;
    return true;
}

function cleanupSessions() {
    const now = Date.now() / 1000;
    for (const [token, sess] of Object.entries(sessions)) {
        if (now - sess.lastActive > SESSION_MAX_AGE) delete sessions[token];
    }
}

// ==================== EMAIL VALIDATION ====================
function isValidEmail(email) {
    return /^[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}$/.test(email.trim());
}

// ==================== EXPRESS APP ====================
const app = express();
const server = http.createServer(app);

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(session({
    secret: SECRET_KEY,
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: SESSION_MAX_AGE * 1000, httpOnly: true },
}));

// CORS
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Credentials', 'true');
    res.header('Access-Control-Allow-Methods', '*');
    res.header('Access-Control-Allow-Headers', '*');
    if (req.method === 'OPTIONS') return res.sendStatus(200);
    next();
});

// Security middleware
app.use((req, res, next) => {
    const clientIp = req.ip || req.connection.remoteAddress || 'unknown';
    const skipPaths = ['/static', '/', '/login', '/api/login', '/api/auth/google', '/api/auth/check'];
    if (!skipPaths.some(p => req.path === p || req.path.startsWith('/static'))) {
        if (!apiRateLimiter.isAllowed(`api:${clientIp}`)) {
            return res.status(429).json({ detail: 'Too many requests. Silakan tunggu beberapa saat.' });
        }
    }
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-XSS-Protection', '1; mode=block');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    next();
});

// Static files
app.use('/static', express.static(path.join(__dirname, 'static')));

// Auth middleware for API endpoints
function checkAuth(req, res, next) {
    const authHeader = req.headers.authorization || '';
    let sessionToken = '';
    if (authHeader.startsWith('Bearer ')) {
        sessionToken = authHeader.slice(7);
    } else if (req.session && req.session.session) {
        sessionToken = req.session.session;
    }
    if (!sessionToken || !validateSession(sessionToken)) {
        const clientIp = req.ip || 'unknown';
        logger.warn(`Unauthorized access attempt from ${clientIp}: ${req.path}`);
        return res.status(401).json({ detail: 'Unauthorized. Silakan login terlebih dahulu.' });
    }
    req.sessionToken = sessionToken;
    next();
}

// ==================== AUTH ENDPOINTS ====================
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'static', 'index.html'));
});

app.get('/login', (req, res) => {
    res.sendFile(path.join(__dirname, 'static', 'index.html'));
});

app.post('/api/login', (req, res) => {
    const clientIp = req.ip || 'unknown';
    if (loginTracker.isBlocked(clientIp)) {
        const remaining = Math.ceil(loginTracker.attempts[clientIp].blockedUntil - Date.now() / 1000);
        return res.status(429).json({ detail: `Terlalu banyak percobaan login. Coba lagi dalam ${remaining} detik.` });
    }
    try {
        const { password } = req.body;
        if (!password || !verifyPassword(password)) {
            loginTracker.recordFailure(clientIp);
            const remaining = Math.max(0, FAILED_LOGIN_LIMIT - (loginTracker.attempts[clientIp]?.count || 0));
            logger.warn(`[SECURITY] Login gagal dari IP ${clientIp}`);
            return res.status(401).json({ detail: 'Password salah!', remaining });
        }
        loginTracker.reset(clientIp);
        const sessionToken = createSession();
        sessions[sessionToken].ip = clientIp;
        sessions[sessionToken].userAgent = req.headers['user-agent'] || '';
        req.session.session = sessionToken;
        logger.info(`[AUDIT] Login berhasil dari ${clientIp}`);
        return res.json({ status: 'success', session: sessionToken, message: 'Login berhasil!' });
    } catch (e) {
        logger.error(`Login error: ${e.message}`);
        return res.status(400).json({ detail: 'Request tidak valid' });
    }
});

app.post('/api/logout', (req, res) => {
    const sessionToken = req.session?.session || '';
    if (sessions[sessionToken]) {
        const clientIp = req.ip || 'unknown';
        logger.info(`[AUDIT] Logout dari ${clientIp}`);
        delete sessions[sessionToken];
    }
    if (req.session) req.session.destroy();
    return res.json({ status: 'success', message: 'Logout berhasil!' });
});

app.get('/api/auth/check', (req, res) => {
    const sessionToken = req.session?.session || '';
    if (sessionToken && validateSession(sessionToken)) {
        const remaining = Math.max(0, Math.ceil(sessions[sessionToken].lastActive + SESSION_MAX_AGE - Date.now() / 1000));
        return res.json({ authenticated: true, session_remaining: remaining });
    }
    return res.json({ authenticated: false });
});

// ==================== GOOGLE OAUTH ====================
app.post('/api/auth/google', (req, res) => {
    const clientIp = req.ip || 'unknown';
    try {
        const { id_token: idTokenStr } = req.body;
        if (!idTokenStr) {
            logger.warn(`[SECURITY] Google login tanpa token dari ${clientIp}`);
            return res.status(400).json({ detail: 'Token tidak ditemukan' });
        }

        // Decode JWT payload (without verification for simplicity - in production use proper JWT verification)
        let tokenInfo;
        try {
            const parts = idTokenStr.split('.');
            if (parts.length !== 3) throw new Error('Invalid token format');
            tokenInfo = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf-8'));
        } catch {
            logger.warn(`[SECURITY] Token Google tidak valid dari ${clientIp}`);
            return res.status(401).json({ detail: 'Token Google tidak valid. Silakan coba lagi.' });
        }

        const userEmail = (tokenInfo.email || '').toLowerCase();
        const userName = tokenInfo.name || userEmail;

        logger.info(`[GOOGLE AUTH] Token valid untuk: ${userEmail} dari ${clientIp}`);

        if (ALLOWED_EMAILS_LIST.length > 0 && !ALLOWED_EMAILS_LIST.includes(userEmail)) {
            logger.warn(`[SECURITY] Email tidak terdaftar: ${userEmail} dari ${clientIp}`);
            return res.status(403).json({ detail: `Akses ditolak. Email ${userEmail} tidak terdaftar. Hubungi admin.` });
        }

        const sessionToken = createSession();
        sessions[sessionToken].ip = clientIp;
        sessions[sessionToken].userAgent = req.headers['user-agent'] || '';
        sessions[sessionToken].email = userEmail;
        sessions[sessionToken].loginType = 'google';
        req.session.session = sessionToken;

        logger.info(`[AUDIT] Google Login berhasil: ${userEmail} dari ${clientIp}`);
        return res.json({
            status: 'success',
            session: sessionToken,
            email: userEmail,
            name: userName,
            message: `Selamat datang, ${userName}!`,
        });
    } catch (e) {
        logger.error(`Google Auth error: ${e.message}`);
        return res.status(400).json({ detail: `Gagal autentikasi dengan Google: ${e.message}` });
    }
});

// ==================== EMAIL WHITELIST MANAGEMENT ====================
app.get('/api/admin/emails', checkAuth, (req, res) => {
    try {
        let lastUpdated = null;
        if (fs.existsSync(ALLOWED_EMAILS_FILE)) {
            try {
                const data = JSON.parse(fs.readFileSync(ALLOWED_EMAILS_FILE, 'utf-8'));
                lastUpdated = data.last_updated;
            } catch {}
        }
        return res.json({
            status: 'success',
            emails: ALLOWED_EMAILS_LIST,
            total: ALLOWED_EMAILS_LIST.length,
            last_updated: lastUpdated,
            source: fs.existsSync(ALLOWED_EMAILS_FILE) ? 'file' : 'env_or_default',
            file_path: ALLOWED_EMAILS_FILE,
        });
    } catch (e) {
        return res.status(500).json({ detail: `Error: ${e.message}` });
    }
});

app.post('/api/admin/emails', checkAuth, (req, res) => {
    try {
        const { email, emails: emailsArray } = req.body;
        const newEmails = email ? [email] : (emailsArray || []);
        if (newEmails.length === 0) {
            return res.status(400).json({ detail: "Body harus berisi 'email' atau 'emails'" });
        }
        const validEmails = [];
        const invalidEmails = [];
        for (const e of newEmails) {
            const normalized = e.trim().toLowerCase();
            if (isValidEmail(normalized)) {
                if (!ALLOWED_EMAILS_LIST.includes(normalized)) validEmails.push(normalized);
                else invalidEmails.push(`${normalized} (sudah ada)`);
            } else {
                invalidEmails.push(`${normalized} (format invalid)`);
            }
        }
        if (validEmails.length === 0) {
            return res.status(400).json({ detail: 'Tidak ada email valid untuk ditambahkan', invalid: invalidEmails });
        }
        ALLOWED_EMAILS_LIST.push(...validEmails);
        if (saveAllowedEmails(ALLOWED_EMAILS_LIST)) {
            return res.json({
                status: 'success',
                message: `${validEmails.length} email berhasil ditambahkan`,
                added: validEmails,
                invalid: invalidEmails.length > 0 ? invalidEmails : null,
                total: ALLOWED_EMAILS_LIST.length,
            });
        }
        return res.status(500).json({ detail: 'Gagal menyimpan ke file' });
    } catch (e) {
        return res.status(500).json({ detail: `Error: ${e.message}` });
    }
});

app.delete('/api/admin/emails/:email', checkAuth, (req, res) => {
    try {
        const emailLower = req.params.email.trim().toLowerCase();
        if (!ALLOWED_EMAILS_LIST.includes(emailLower)) {
            return res.status(404).json({ detail: `Email '${emailLower}' tidak ditemukan di whitelist` });
        }
        if (ALLOWED_EMAILS_LIST.length <= 1) {
            return res.status(400).json({ detail: 'Tidak bisa hapus email terakhir! Minimal harus ada 1 email terdaftar.' });
        }
        ALLOWED_EMAILS_LIST = ALLOWED_EMAILS_LIST.filter(e => e !== emailLower);
        if (saveAllowedEmails(ALLOWED_EMAILS_LIST)) {
            return res.json({
                status: 'success',
                message: `Email '${emailLower}' berhasil dihapus`,
                removed: emailLower,
                total: ALLOWED_EMAILS_LIST.length,
            });
        }
        return res.status(500).json({ detail: 'Gagal menyimpan ke file' });
    } catch (e) {
        return res.status(500).json({ detail: `Error: ${e.message}` });
    }
});

app.post('/api/admin/emails/reload', checkAuth, (req, res) => {
    try {
        ALLOWED_EMAILS_LIST = loadAllowedEmails();
        return res.json({
            status: 'success',
            message: `Berhasil reload ${ALLOWED_EMAILS_LIST.length} email dari file`,
            emails: ALLOWED_EMAILS_LIST,
        });
    } catch (e) {
        return res.status(500).json({ detail: `Error: ${e.message}` });
    }
});

// ==================== API ENDPOINTS ====================
app.get('/api/clients', checkAuth, (req, res) => {
    return res.json({
        clients: buildClientsList(),
        count: Object.keys(clients).length,
        stats: getSafeStats(),
    });
});

app.get('/api/stats', checkAuth, (req, res) => {
    const uptime = Date.now() / 1000 - stats.start_time.getTime() / 1000;
    return res.json({
        uptime: formatUptime(uptime),
        total_messages: stats.total_messages,
        failed_messages: stats.failed_messages,
        broadcast_failures: stats.broadcast_failures,
        mqtt_reconnects: stats.mqtt_reconnects,
        active_clients: Object.keys(clients).length,
        websocket_connections: activeConnections.size,
        circuit_breaker_state: broadcastCircuitBreaker.state,
        active_sessions: Object.keys(sessions).length,
    });
});

function formatUptime(seconds) {
    const d = Math.floor(seconds / 86400);
    const h = Math.floor((seconds % 86400) / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    return `${d}d ${h}h ${m}m`;
}

// ==================== COMMAND EXECUTION ====================
app.post('/api/command', checkAuth, (req, res) => {
    const clientIp = req.ip || 'unknown';
    if (!commandRateLimiter.isAllowed(`cmd:${clientIp}`)) {
        logger.warn(`[SECURITY] Command rate limit exceeded from ${clientIp}`);
        return res.status(429).json({ error: 'Terlalu banyak command! Tunggu beberapa saat.' });
    }
    try {
        const { hostname, command, process_name: processName, admin_password: adminPassword } = req.body;
        if (!hostname || !command) {
            return res.status(400).json({ error: 'hostname dan command harus diisi' });
        }
        if (!COMMAND_WHITELIST[command]) {
            logger.warn(`[SECURITY] Unauthorized command attempt: ${command} from ${clientIp}`);
            return res.status(403).json({ error: `Command '${command}' tidak diizinkan` });
        }
        if (DANGEROUS_COMMANDS.includes(command)) {
            if (!adminPassword || !verifyPassword(adminPassword)) {
                logger.warn(`[SECURITY] Dangerous command without password: ${command} from ${clientIp}`);
                return res.status(403).json({
                    error: 'Command ini memerlukan verifikasi password admin!',
                    need_password: true,
                    message: 'Masukkan password admin untuk melanjutkan',
                });
            }
        }
        if (COMMAND_PARAMS[command]) {
            for (const param of COMMAND_PARAMS[command]) {
                if (param === 'process_name' && !processName) {
                    return res.status(400).json({ error: `Parameter 'process_name' diperlukan untuk command '${command}'` });
                }
                if (param === 'process_name' && !PROCESS_NAME_RE.test(String(processName))) {
                    return res.status(400).json({ error: "process_name tidak valid (huruf/angka . _ - , maks 64 karakter)" });
                }
            }
        }
        if (!clients[hostname] || clients[hostname].status !== 'online') {
            return res.status(404).json({ error: `PC '${hostname}' tidak online` });
        }

        const requestId = `${hostname}_${Date.now()}_${Math.floor(1000 + Math.random() * 9000)}`;
        const params = {};
        if (COMMAND_PARAMS[command]) {
            for (const param of COMMAND_PARAMS[command]) {
                if (param === 'process_name') params.process_name = processName;
            }
        }
        const timestamp = new Date().toISOString();
        const payload = {
            command, request_id: requestId, timestamp, params,
            signature: signCommand(requestId, command, timestamp, params),
        };
        const topic = `lab/command/${hostname}`;
        mqttClient.publish(topic, JSON.stringify(payload), { qos: 1 });

        logger.info(`[AUDIT] Command: ${command} ke ${hostname} dari ${clientIp}`);

        pendingCommands[requestId] = { resolved: false };

        return res.json({
            status: 'pending',
            request_id: requestId,
            message: `Command '${command}' dikirim ke ${hostname}`,
            command,
            hostname,
            params,
        });
    } catch (e) {
        logger.error(`Error executing remote command: ${e.message}`);
        return res.status(500).json({ error: e.message });
    }
});

app.get('/api/command/result/:requestId', checkAuth, (req, res) => {
    const { requestId } = req.params;
    if (commandResults[requestId]) {
        delete pendingCommands[requestId];
        return res.json({ status: 'completed', result: commandResults[requestId] });
    } else if (pendingCommands[requestId]) {
        return res.json({ status: 'pending', message: 'Menunggu hasil dari agent...' });
    } else {
        return res.status(404).json({ status: 'notfound', error: 'Request ID tidak ditemukan' });
    }
});

app.get('/api/commands/whitelist', checkAuth, (req, res) => {
    return res.json({ commands: COMMAND_WHITELIST, dangerous: DANGEROUS_COMMANDS });
});

// ==================== HEALTH CHECK ====================
app.get('/health', (req, res) => {
    const uptime = Date.now() / 1000 - stats.start_time.getTime() / 1000;
    return res.json({
        status: 'healthy',
        mode: !USE_MQTT ? 'demo' : 'mqtt',
        mqtt_connected: mqttClient ? mqttClient.connected : false,
        active_clients: Object.keys(clients).length,
        websocket_connections: activeConnections.size,
        active_sessions: Object.keys(sessions).length,
        uptime: formatUptime(uptime),
        stats: getSafeStats(),
        circuit_breaker_state: broadcastCircuitBreaker.state,
        timestamp: new Date().toISOString(),
    });
});

// ==================== WEBSOCKET ====================
const wss = new WebSocketServer({ server });

wss.on('connection', (ws, req) => {
    activeConnections.add(ws);
    logger.info(`🔌 WebSocket connected. Total: ${activeConnections.size}`);

    // Send initial data
    const initial = JSON.stringify({
        type: 'initial',
        clients: buildClientsList(),
        timestamp: new Date().toISOString(),
        stats: getSafeStats(),
    });
    try { ws.send(initial); } catch {}

    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });

    ws.on('message', (data) => {
        try {
            const msg = data.toString();
            if (msg) {
                ws.send(JSON.stringify({ type: 'ack', timestamp: new Date().toISOString() }));
            }
        } catch {}
    });

    ws.on('close', () => {
        activeConnections.delete(ws);
        logger.info(`🔌 WebSocket disconnected. Remaining: ${activeConnections.size}`);
    });

    ws.on('error', (err) => {
        logger.error(`WebSocket error: ${err.message}`);
        activeConnections.delete(ws);
    });
});

// Heartbeat interval for WebSocket
const wsHeartbeat = setInterval(() => {
    wss.clients.forEach((ws) => {
        if (!ws.isAlive) return activeConnections.delete(ws);
        ws.isAlive = false;
        try { ws.ping(); } catch {}
    });
}, 30000);

wss.on('close', () => clearInterval(wsHeartbeat));

// ==================== MQTT SETUP ====================
let mqttClient = null;
let mqttReconnectDelay = INITIAL_RECONNECT_DELAY;

function handleCommandResult(payload) {
    try {
        const { request_id: requestId, hostname, command, result } = payload;
        commandResults[requestId] = {
            hostname,
            command,
            result,
            timestamp: new Date().toISOString(),
        };
        if (pendingCommands[requestId]) pendingCommands[requestId].resolved = true;
        logger.info(`[✓] Command result diterima: ${command} dari ${hostname}`);
    } catch (e) {
        logger.error(`Error handling command result: ${e.message}`);
    }
}

function setupMqtt() {
    if (!USE_MQTT) return;

    mqttClient = mqtt.connect(`mqtt://${MQTT_BROKER}:${MQTT_PORT}`, {
        clientId: MQTT_CLIENT_ID,
        username: MQTT_USER,
        password: MQTT_PASS,
        protocolVersion: 4, // MQTT 3.1.1
        connectTimeout: 10000,
        reconnectPeriod: mqttReconnectDelay * 1000,
    });

    mqttClient.on('connect', () => {
        logger.info(`✅ Connected to MQTT Broker at ${MQTT_BROKER}:${MQTT_PORT}`);
        mqttClient.subscribe(MQTT_TOPIC);
        mqttClient.subscribe(MQTT_COMMAND_RESULT_TOPIC);
        logger.info(`📡 Subscribed to: ${MQTT_TOPIC} dan ${MQTT_COMMAND_RESULT_TOPIC}`);
        mqttReconnectDelay = INITIAL_RECONNECT_DELAY;
    });

    mqttClient.on('message', (topic, message) => {
        try {
            const payloadStr = message.toString();
            let payload;
            try {
                payload = JSON.parse(payloadStr);
            } catch {
                logger.error(`Invalid JSON in MQTT message from ${topic}`);
                return;
            }

            if (topic.startsWith('lab/command/result/')) {
                handleCommandResult(payload);
                return;
            }

            if (!validatePayloadStructure(payload)) return;

            const clientId = payload.id || topic.split('/').pop();
            if (!clientId || typeof clientId !== 'string') return;

            safeUpdateClientState(clientId, payload);
            safeBroadcastUpdate();
        } catch (e) {
            logger.error(`Error processing MQTT message: ${e.message}`);
        }
    });

    mqttClient.on('error', (err) => {
        logger.error(`MQTT error: ${err.message}`);
    });

    mqttClient.on('close', () => {
        logger.warn(`⚠️ Disconnected from MQTT Broker`);
    });

    mqttClient.on('reconnect', () => {
        mqttReconnectDelay = Math.min(mqttReconnectDelay * 2, MAX_RECONNECT_DELAY);
        stats.mqtt_reconnects++;
    });
}

// ==================== DEMO MODE ====================
function generateDemoData(pcInfo) {
    const cpu = Math.round((5 + Math.random() * 80) * 10) / 10;
    const ram = Math.round((20 + Math.random() * 55) * 10) / 10;
    const storageTotal = [256, 512, 1024][Math.floor(Math.random() * 3)];
    const storageUsed = Math.round((50 + Math.random() * 250) * 10) / 10;
    const now = new Date();

    return {
        id: pcInfo.id,
        status: 'online',
        user: pcInfo.user,
        time: now.toLocaleTimeString('en-US', { hour12: false }),
        ip: pcInfo.ip,
        mac: `AA:BB:CC:DD:EE:${Math.floor(1 + Math.random() * 99).toString(16).padStart(2, '0').toUpperCase()}`,
        iface: 'eth0',
        uptime: `${Math.floor(1 + Math.random() * 24)}h ${Math.floor(Math.random() * 59)}m`,
        os: pcInfo.os,
        cpu_percent: cpu,
        cpu_threads: [4, 8, 12, 16][Math.floor(Math.random() * 4)],
        cpu_cores: [2, 4, 6, 8][Math.floor(Math.random() * 4)],
        cpu_ghz: Math.round((2 + Math.random() * 1.5) * 100) / 100,
        cpu_max_ghz: Math.round((3.5 + Math.random() * 1.5) * 100) / 100,
        ram_percent: ram,
        ram_used_gb: Math.round((2 + Math.random() * 10) * 10) / 10,
        ram_total_gb: [8, 16, 32][Math.floor(Math.random() * 3)],
        storage_total_gb: storageTotal,
        storage_used_gb: storageUsed,
        storage_free_gb: Math.round((storageTotal - storageUsed) * 10) / 10,
        storage_percent: Math.round((storageUsed / storageTotal) * 1000) / 10,
        down_mbps: Math.round((1 + Math.random() * 99) * 10) / 10,
        traffic_in_gb: Math.round((0.5 + Math.random() * 9.5) * 100) / 100,
        latency_ms: Math.round((5 + Math.random() * 45) * 10) / 10,
        last_seen: now.toLocaleTimeString('en-US', { hour12: false }),
        last_seen_ts: Date.now() / 1000,
        top_processes: Array.from({ length: 5 }, () => ({
            name: PROCESS_NAMES[Math.floor(Math.random() * PROCESS_NAMES.length)],
            cpu: Math.round((1 + Math.random() * 29) * 10) / 10,
            mem: Math.round((0.5 + Math.random() * 3.5) * 100) / 100,
        })),
        top_files: Array.from({ length: 5 }, () => ({
            name: FILE_NAMES[Math.floor(Math.random() * FILE_NAMES.length)],
            path: `C:/Users/${pcInfo.user}/Documents`,
            size_mb: Math.round((100 + Math.random() * 1900) * 10) / 10,
        })),
        gpu: [],
        cpu_history: [],
        ram_history: [],
    };
}

function updateDemoData() {
    for (const pcInfo of DEMO_PCS) {
        if (!clients[pcInfo.id]) {
            clients[pcInfo.id] = createClientState(pcInfo.id, generateDemoData(pcInfo));
        } else {
            const newData = generateDemoData(pcInfo);
            const old = clients[pcInfo.id];
            newData.cpu_history = [...(old.cpu_history || []), old.cpu_percent];
            newData.ram_history = [...(old.ram_history || []), old.ram_percent];
            if (newData.cpu_history.length > MAX_HISTORY_LENGTH) newData.cpu_history = newData.cpu_history.slice(-MAX_HISTORY_LENGTH);
            if (newData.ram_history.length > MAX_HISTORY_LENGTH) newData.ram_history = newData.ram_history.slice(-MAX_HISTORY_LENGTH);
            clients[pcInfo.id] = createClientState(pcInfo.id, newData);
        }
    }
    safeBroadcastUpdate();
}

// ==================== BACKGROUND TASKS ====================
function checkOfflineClients() {
    const now = Date.now() / 1000;
    let changed = false;
    for (const [clientId, client] of Object.entries(clients)) {
        if (client.status === 'online' && client.last_seen_ts && (now - client.last_seen_ts > OFFLINE_TIMEOUT)) {
            client.status = 'offline';
            logger.warn(`[TIMEOUT] ${clientId} marked offline`);
            changed = true;
        }
    }
    if (changed) safeBroadcastUpdate();
}

function logStats() {
    const uptime = Date.now() / 1000 - stats.start_time.getTime() / 1000;
    logger.info(`📊 Stats - Uptime: ${formatUptime(uptime)}, Messages: ${stats.total_messages}, Failed: ${stats.failed_messages}, Clients: ${Object.keys(clients).length}, WS: ${activeConnections.size}, Sessions: ${Object.keys(sessions).length}`);
}

// ==================== START SERVER ====================
server.listen(SERVER_PORT, '0.0.0.0', () => {
    const mode = !USE_MQTT ? 'DEMO MODE' : 'MQTT MODE';
    console.log('='.repeat(60));
    console.log(`  Lab Monitoring System v2.2.0 Node.js - ${mode}`);
    console.log('='.repeat(60));
    if (USE_MQTT) {
        console.log(`  MQTT Broker: ${MQTT_BROKER}:${MQTT_PORT}`);
        console.log(`  Topic: ${MQTT_TOPIC}`);
    } else {
        console.log('  🎭 Demo Mode: Generating fake data for 8 PCs');
    }
    console.log(`  Dashboard: http://localhost:${SERVER_PORT}`);
    console.log(`  🔒 Login password: ${ADMIN_PASSWORD}`);
    console.log(`  ⚠️  Ubah password di main.js atau set env LAB_PASSWORD!`);
    console.log('='.repeat(60));

    // Setup MQTT
    setupMqtt();

    // Start demo mode if MQTT is disabled
    if (!USE_MQTT) {
        logger.info('🎭 Running in DEMO MODE');
        setInterval(() => {
            try { updateDemoData(); } catch (e) { logger.error(`Error in demo_loop: ${e.message}`); }
        }, 2000);
    }

    // Background tasks
    setInterval(checkOfflineClients, 5000);
    setInterval(logStats, 60000);
    setInterval(cleanupSessions, 300000);
});

// Graceful shutdown
process.on('SIGINT', () => {
    logger.info('🛑 Shutting down Lab Monitoring System');
    if (mqttClient) {
        try { mqttClient.end(); } catch {}
    }
    wss.close();
    server.close();
    process.exit(0);
});

process.on('uncaughtException', (e) => {
    logger.error(`Uncaught exception: ${e.message}`);
});

process.on('unhandledRejection', (e) => {
    logger.error(`Unhandled rejection: ${e}`);
});
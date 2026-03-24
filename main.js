/**
 * AKD SIEM — main.js
 * Electron main process
 * ─ يشغّل WebSocket server مدمج (port 8765)
 * ─ يفتح نافذة الداشبورد
 * ─ يربط IPC بين الـ renderer والـ WS server
 */

const { app, BrowserWindow, ipcMain, Notification, nativeTheme, shell } = require('electron');
const { WebSocketServer, WebSocket } = require('ws');
const path = require('path');
const os   = require('os');

// ── Config ─────────────────────────────────────────────────────────
const WS_PORT      = 8765;
const MAX_EVENTS   = 10000;

// ── State ──────────────────────────────────────────────────────────
let mainWindow   = null;
let wss          = null;
const agents     = new Map();   // agent_id → {ws, info}
const dashboards = new Set();   // renderer WebSocket connections
const eventLog   = [];          // circular buffer

// ── Get local IPs ──────────────────────────────────────────────────
function getLocalIPs() {
  const ips = [];
  const nets = os.networkInterfaces();
  for (const iface of Object.values(nets)) {
    for (const net of iface) {
      if (net.family === 'IPv4' && !net.internal) ips.push(net.address);
    }
  }
  return ips;
}

// ── Notification helper ────────────────────────────────────────────
function notify(title, body) {
  if (Notification.isSupported()) {
    new Notification({ title, body, silent: false }).show();
  }
}

// ── Push event to renderer ─────────────────────────────────────────
function pushToRenderer(evt) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('siem:event', evt);
  }
}

// ── WebSocket SIEM Server ──────────────────────────────────────────
function startWSServer() {
  wss = new WebSocketServer({ port: WS_PORT });

  wss.on('listening', () => {
    console.log(`[SIEM] WebSocket server listening on port ${WS_PORT}`);
    const ips = getLocalIPs();
    console.log(`[SIEM] Agents should connect to: ws://${ips[0] || 'localhost'}:${WS_PORT}`);
  });

  wss.on('connection', (ws, req) => {
    const clientIP = req.socket.remoteAddress?.replace('::ffff:', '') || 'unknown';
    console.log(`[SIEM] New connection from ${clientIP}`);

    ws.once('message', (raw) => {
      let data;
      try { data = JSON.parse(raw); } catch { ws.close(); return; }

      // ── Agent registration ─────────────────────────────────────
      if (data.type === 'register') {
        const agentId = data.agent_id || clientIP;
        const agentInfo = {
          agent_id:    agentId,
          ip:          clientIP,
          os:          data.os || 'Unknown',
          platform:    data.platform || '',
          version:     data.agent_version || '1.0',
          watch_files: data.watch_files || [],
          log_files:   data.log_files   || [],
          status:      'active',
          connected_at: new Date().toLocaleTimeString(),
          last_seen:   new Date().toLocaleTimeString(),
          cpu: 0, mem: 0, disk: 0,
        };
        agents.set(agentId, { ws, info: agentInfo });

        // Push agent-connected event to renderer
        pushToRenderer({ type: 'agent_connected', ...agentInfo });
        notify('Agent Connected', `${agentId} (${clientIP}) connected`);
        console.log(`[AGENT] Registered: ${agentId} | ${clientIP} | ${agentInfo.os}`);

        // ── Receive events from agent ──────────────────────────
        ws.on('message', (msg) => {
          let evt;
          try { evt = JSON.parse(msg); } catch { return; }

          // Update agent metadata on heartbeat
          if (evt.type === 'heartbeat') {
            const entry = agents.get(agentId);
            if (entry) {
              entry.info.last_seen = new Date().toLocaleTimeString();
              entry.info.cpu  = evt.cpu  ?? 0;
              entry.info.mem  = evt.mem  ?? 0;
              entry.info.disk = evt.disk ?? 0;
              entry.info.connections = evt.connections ?? 0;
              pushToRenderer({ type: 'agent_heartbeat', agent_id: agentId,
                cpu: evt.cpu, mem: evt.mem, disk: evt.disk,
                connections: evt.connections, last_seen: entry.info.last_seen });
            }
            return;
          }

          // Store event
          eventLog.push(evt);
          if (eventLog.length > MAX_EVENTS) eventLog.shift();

          // Send to renderer
          pushToRenderer(evt);

          // Desktop notification for critical
          if (evt.severity === 'critical') {
            notify(`🚨 CRITICAL — ${agentId}`, evt.message?.slice(0, 80) || 'Critical alert');
          }

          console.log(`[${evt.severity?.toUpperCase()}] [${agentId}] ${evt.message?.slice(0,80)}`);
        });

        ws.on('close', () => {
          const entry = agents.get(agentId);
          if (entry) entry.info.status = 'disconnected';
          pushToRenderer({ type: 'agent_disconnected', agent_id: agentId });
          notify('Agent Disconnected', `${agentId} disconnected`);
          console.log(`[AGENT] Disconnected: ${agentId}`);
        });

        ws.on('error', (err) => console.error(`[AGENT ERR] ${agentId}:`, err.message));
      }
    });

    ws.on('error', (err) => console.error('[WS ERR]', err.message));
  });

  wss.on('error', (err) => {
    console.error('[SIEM SERVER ERR]', err.message);
    if (err.code === 'EADDRINUSE') {
      console.error(`Port ${WS_PORT} is already in use!`);
    }
  });
}

// ── IPC Handlers ──────────────────────────────────────────────────
function setupIPC() {
  // Renderer asks for initial state
  ipcMain.handle('siem:get-state', () => ({
    agents:       [...agents.values()].map(a => a.info),
    events:       eventLog.slice(-200),
    serverInfo: {
      port: WS_PORT,
      ips:  getLocalIPs(),
      hostname: os.hostname(),
    }
  }));

  // Disconnect an agent
  ipcMain.handle('siem:disconnect-agent', (_, agentId) => {
    const entry = agents.get(agentId);
    if (entry) { entry.ws.close(); agents.delete(agentId); }
  });

  // Open agent install folder
  ipcMain.handle('siem:open-agent-folder', () => {
    const fs2 = require('fs');
    const destDir  = path.join(app.getPath('userData'), 'agent');
    const destFile = path.join(destDir, 'siem_agent.py');
    const readme   = path.join(destDir, 'README.txt');
    try {
      if (!fs2.existsSync(destDir)) fs2.mkdirSync(destDir, { recursive: true });
      // نكتب محتوى الـ agent مباشرة — يشتغل سواء كان exe أو development
      const agentCode = `#!/usr/bin/env python3
"""
AKD SIEM Agent v1.0
شغّله على أي جهاز تريد تراقبه — يتصل بالـ Electron app تلقائياً

Linux:   sudo python3 siem_agent.py
Windows: python siem_agent.py  (as Administrator)
"""

import asyncio
import websockets
import json
import hashlib
import os
import re
import socket
import platform
import time
from datetime import datetime
from collections import defaultdict

# ══════════════════════════════════════════════════════════════════
# ██  CONFIG — غير السطر التالي فقط  ██
# ══════════════════════════════════════════════════════════════════
SIEM_SERVER = "ws://${getLocalIPs()[0] || '127.0.0.1'}:8765"  # ← تم تحديثه تلقائياً ليأخذ IP الخادم الحالي

# معلومات الـ Agent
AGENT_ID = socket.gethostname()
AGENT_IP = socket.gethostbyname(socket.gethostname())
OS_TYPE = platform.system()  # Linux / Windows / Darwin

# ══════════════════════════════════════════════════════════════════
# الملفات اللي نراقبها (File Integrity Monitoring)
# ══════════════════════════════════════════════════════════════════
WATCH_FILES_LINUX = {
    "/etc/passwd": "config",
    "/etc/shadow": "config",
    "/etc/sudoers": "config",
    "/etc/ssh/sshd_config": "config",
    "/etc/crontab": "config",
    "/etc/hosts": "config",
    "/etc/hostname": "config",
    "/root/.bashrc": "script",
    "/root/.ssh/authorized_keys": "config",
    "/bin/bash": "binary",
    "/usr/bin/sudo": "binary",
    "/usr/bin/passwd": "binary",
}

WATCH_FILES_WINDOWS = {
    r"C:\\Windows\\System32\\drivers\\etc\\hosts": "config",
    r"C:\\Windows\\System32\\drivers\\etc\\services": "config",
    r"C:\\Windows\\System32\\config\\SAM": "config",
}

WATCH_FILES = WATCH_FILES_LINUX if OS_TYPE == "Linux" else WATCH_FILES_WINDOWS

# ══════════════════════════════════════════════════════════════════
# Detection Rules
# ══════════════════════════════════════════════════════════════════
RULES = [
    {"id": "R-001", "pattern": r"Failed password", "severity": "high", "name": "SSH Failed Login"},
    {"id": "R-002", "pattern": r"POSSIBLE BREAK-IN ATTEMPT", "severity": "critical", "name": "Break-in Attempt"},
    {"id": "R-003", "pattern": r"sudo.*3 incorrect password", "severity": "high", "name": "Sudo Auth Failure"},
    {"id": "R-004", "pattern": r"Accepted password for root", "severity": "critical", "name": "Root Login Accepted"},
    {"id": "R-005", "pattern": r"useradd|adduser|net user.*\\/add", "severity": "high", "name": "New User Created"},
    {"id": "R-006", "pattern": r"UFW BLOCK", "severity": "medium", "name": "Firewall Block"},
    {"id": "R-007", "pattern": r"Out of memory.*Kill process", "severity": "high", "name": "OOM Kill"},
    {"id": "R-008", "pattern": r"segfault at", "severity": "medium", "name": "Segfault"},
    {"id": "R-009", "pattern": r"authentication failure", "severity": "medium", "name": "Auth Failure"},
    {"id": "R-010", "pattern": r"Invalid user.*from", "severity": "medium", "name": "Invalid User Login"},
    {"id": "R-011", "pattern": r"Connection closed by invalid", "severity": "medium", "name": "Invalid Connection"},
    {"id": "R-012", "pattern": r"error: maximum authentication", "severity": "high", "name": "Max Auth Attempts"},
    {"id": "R-013", "pattern": r"kernel.*iptables", "severity": "medium", "name": "Iptables Event"},
    {"id": "R-014", "pattern": r"(wget|curl).*(http).*-O.*(/tmp|/var)", "severity": "critical", "name": "Suspicious Download"},
    {"id": "R-015", "pattern": r"chmod.*777|chmod.*\\+x.*/tmp", "severity": "high", "name": "Suspicious chmod"},
    {"id": "R-016", "pattern": r"(?i)(sqlmap|union.*select|select.*from|%27|')", "severity": "critical", "name": "SQL Injection Attack"}
]

# Trackers (Brute Force & Port Scan)
brute_tracker = {}
BRUTE_THRESHOLD = 5
BRUTE_WINDOW = 60  # seconds

port_scan_tracker = defaultdict(list)
SCAN_THRESHOLD = 15
SCAN_WINDOW = 10


# ══════════════════════════════════════════════════════════════════
# Helpers & Threat Detectors
# ══════════════════════════════════════════════════════════════════

def ts():
    return datetime.now().strftime("%H:%M:%S")


def file_hash(path):
    try:
        with open(path, "rb") as f:
            return hashlib.sha256(f.read()).hexdigest()[:16]
    except:
        return None


def extract_ip(line):
    m = re.search(r'\\b(\\d{1,3}\\.){3}\\d{1,3}\\b', line)
    return m.group(0) if m else None


def make_event(etype, severity, message, extra=None):
    evt = {
        "type": etype,
        "severity": severity,
        "message": message,
        "agent_id": AGENT_ID,
        "agent_ip": AGENT_IP,
        "os": OS_TYPE,
        "timestamp": ts(),
    }
    if extra:
        evt.update(extra)
    return json.dumps(evt)


def check_brute(ip):
    if not ip:
        return False
    now = time.time()
    brute_tracker.setdefault(ip, [])
    brute_tracker[ip].append(now)
    brute_tracker[ip] = [t for t in brute_tracker[ip] if now - t < BRUTE_WINDOW]
    return len(brute_tracker[ip]) >= BRUTE_THRESHOLD


def detect_port_scan():
    alerts = []
    now = time.time()
    try:
        import psutil
        for conn in psutil.net_connections(kind='inet'):
            if conn.raddr:
                ip = conn.raddr.ip
                port_scan_tracker[ip].append(now)
                port_scan_tracker[ip] = [t for t in port_scan_tracker[ip] if now - t < SCAN_WINDOW]

                if len(port_scan_tracker[ip]) >= SCAN_THRESHOLD and ip not in alerts:
                    alerts.append(ip)
    except:
        pass
    return alerts


# ══════════════════════════════════════════════════════════════════
# File Integrity Monitor
# ══════════════════════════════════════════════════════════════════
class FIMMonitor:
    def __init__(self):
        self.baseline = {}
        print("[FIM] Building baseline hashes...")
        for path in WATCH_FILES:
            h = file_hash(path)
            if h:
                self.baseline[path] = h
                print(f"  ✓ {path[:50]}")
            else:
                print(f"  - {path[:50]} (not found)")

    async def check(self, ws):
        for path, ftype in WATCH_FILES.items():
            cur = file_hash(path)
            old = self.baseline.get(path)

            if old is None and cur:
                evt = make_event("fim", "high", f"New file: {path}",
                                 {"path": path, "type": ftype, "status": "added", "hash_old": "—", "hash_new": cur})
                await ws.send(evt)
                self.baseline[path] = cur
                print(f"[FIM] ADDED: {path}")

            elif old and cur is None:
                evt = make_event("fim", "critical", f"File DELETED: {path}",
                                 {"path": path, "type": ftype, "status": "deleted", "hash_old": old, "hash_new": "—"})
                await ws.send(evt)
                del self.baseline[path]
                print(f"[FIM] DELETED: {path}")

            elif old and cur and old != cur:
                sev = "critical" if ftype == "binary" else "high"
                evt = make_event("fim", sev, f"File MODIFIED: {path}",
                                 {"path": path, "type": ftype, "status": "modified", "hash_old": old, "hash_new": cur})
                await ws.send(evt)
                self.baseline[path] = cur
                print(f"[FIM] MODIFIED: {path}")


# ══════════════════════════════════════════════════════════════════
# Log Monitor
# ══════════════════════════════════════════════════════════════════
class LogMonitor:
    def __init__(self):
        if OS_TYPE == "Linux":
            candidates = [
                "/var/log/auth.log",
                "/var/log/secure",
                "/var/log/syslog",
                "/var/log/kern.log",
                "/var/log/ufw.log",
                "/var/log/nginx/error.log",
                "/var/log/nginx/access.log",
                "/var/log/apache2/error.log",
                "/var/log/apache2/access.log",
                "/var/log/audit/audit.log",
            ]
            self.log_files = [f for f in candidates if os.path.exists(f)]
        else:
            self.log_files = []

        self.positions = {}
        for f in self.log_files:
            try:
                self.positions[f] = os.path.getsize(f)
                print(f"[LOG] Watching: {f}")
            except:
                pass

    async def check(self, ws):
        for logfile in self.log_files:
            if not os.path.exists(logfile):
                continue
            try:
                size = os.path.getsize(logfile)
                last = self.positions.get(logfile, size)
                if size <= last:
                    continue

                with open(logfile, "r", errors="ignore") as f:
                    f.seek(last)
                    lines = f.readlines()
                    self.positions[logfile] = f.tell()

                for line in lines:
                    line = line.strip()
                    if not line:
                        continue

                    for rule in RULES:
                        if re.search(rule["pattern"], line, re.IGNORECASE):
                            ip = extract_ip(line)
                            sev = rule["severity"]

                            # Brute force detection
                            if rule["id"] == "R-001" and check_brute(ip):
                                await ws.send(make_event("threat", "critical",
                                                         f"SSH Brute Force from {ip} ({BRUTE_THRESHOLD}+ attempts)",
                                                         {"rule_id": "R-BF", "rule_name": "SSH Brute Force",
                                                          "source_ip": ip, "log_source": logfile}))

                            await ws.send(make_event("threat", sev,
                                                     f"[{rule['id']}] {rule['name']}: {line[:120]}",
                                                     {"rule_id": rule["id"], "rule_name": rule["name"],
                                                      "source_ip": ip, "log_source": logfile, "raw_log": line[:200]}))
                            break

            except (PermissionError, OSError):
                pass


# ══════════════════════════════════════════════════════════════════
# System Metrics (heartbeat)
# ══════════════════════════════════════════════════════════════════
async def send_heartbeat(ws):
    cpu = mem = disk = connections = 0
    try:
        import psutil
        cpu = psutil.cpu_percent(interval=0.5)
        mem = psutil.virtual_memory().percent
        disk = psutil.disk_usage('/').percent
        connections = len(psutil.net_connections())
    except ImportError:
        pass

    await ws.send(make_event("heartbeat", "info",
                             f"Heartbeat CPU:{cpu}% MEM:{mem}% DISK:{disk}%",
                             {"cpu": cpu, "mem": mem, "disk": disk, "connections": connections}))


# ══════════════════════════════════════════════════════════════════
# Main Agent Loop
# ══════════════════════════════════════════════════════════════════
async def run():
    fim = FIMMonitor()
    log = LogMonitor()

    print(f"\\n{'=' * 55}")
    print(f"  AKD SIEM Agent — {AGENT_ID}")
    print(f"  OS: {OS_TYPE} | IP: {AGENT_IP}")
    print(f"  Server: {SIEM_SERVER}")
    print(f"{'=' * 55}\\n")

    delay = 5
    while True:
        try:
            print(f"[AGENT] Connecting to {SIEM_SERVER}...")
            async with websockets.connect(SIEM_SERVER, ping_interval=20, ping_timeout=10) as ws:
                print("[AGENT] ✓ Connected!")
                delay = 5

                # Register
                await ws.send(make_event("register", "info", f"Agent {AGENT_ID} registered",
                                         {"agent_version": "1.0", "platform": platform.platform(),
                                          "watch_files": list(WATCH_FILES.keys()),
                                          "log_files": log.log_files}))

                tick = 0
                while True:
                    # فحص الملفات FIM
                    if tick % 4 == 0:
                        await fim.check(ws)

                    # فحص السجلات
                    await log.check(ws)

                    # إرسال حالة النظام
                    if tick % 60 == 0:
                        await send_heartbeat(ws)

                    # فحص المنافذ Port Scan
                    scan_ips = detect_port_scan()
                    for ip in scan_ips:
                        await ws.send(make_event("threat", "high",
                                                 f"Possible Port Scan from {ip}",
                                                 {"rule_id": "R-PS", "rule_name": "Port Scan Detection",
                                                  "source_ip": ip}))

                    tick += 2
                    await asyncio.sleep(2)

        except (websockets.exceptions.ConnectionRefused,
                websockets.exceptions.ConnectionClosedError,
                OSError, ConnectionResetError) as e:
            print(f"[AGENT] ✗ {e}")
            print(f"[AGENT] Retry in {delay}s...")
            await asyncio.sleep(delay)
            delay = min(delay * 2, 120)

        except KeyboardInterrupt:
            print("\\n[AGENT] Stopped.")
            break


if __name__ == "__main__":
    asyncio.run(run())
`;
      fs2.writeFileSync(destFile, agentCode, 'utf8');
      fs2.writeFileSync(readme,
        'AKD SIEM Agent\n' +
        '========================\n\n' +
        '1. pip install websockets psutil\n' +
        '2. Edit SIEM_SERVER in siem_agent.py (if needed)\n' +
        '3. sudo python3 siem_agent.py\n', 'utf8');
      shell.openPath(destDir);
    } catch(e) {
      console.error('[AGENT FOLDER]', e.message);
      shell.openPath(app.getPath('userData'));
    }
  });

  // Get server connection info
  ipcMain.handle('siem:server-info', () => ({
    port: WS_PORT,
    ips:  getLocalIPs(),
    hostname: os.hostname(),
    ws_url: `ws://${getLocalIPs()[0] || 'localhost'}:${WS_PORT}`,
  }));
}

// ── Create Window ──────────────────────────────────────────────────
function createWindow() {
  nativeTheme.themeSource = 'dark';

  mainWindow = new BrowserWindow({
    width:  1400,
    height: 860,
    minWidth:  900,
    minHeight: 600,
    frame: false,           // Custom title bar
    titleBarStyle: 'hidden',
    backgroundColor: '#080d12',
    webPreferences: {
      preload:           path.join(__dirname, 'preload.js'),
      contextIsolation:  true,
      nodeIntegration:   false,
    },
    icon: path.join(__dirname, 'assets', process.platform === 'win32' ? 'icon.ico' : 'icon.png'),
    show: false,
  });

  mainWindow.loadFile(path.join(__dirname, 'src', 'index.html'));

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  mainWindow.on('closed', () => { mainWindow = null; });
}

// ── Window Controls ────────────────────────────────────────────────
ipcMain.on('window:minimize', () => BrowserWindow.getFocusedWindow()?.minimize());
ipcMain.on('window:maximize', () => {
  const w = BrowserWindow.getFocusedWindow();
  w && (w.isMaximized() ? w.unmaximize() : w.maximize());
});
ipcMain.on('window:close', () => BrowserWindow.getFocusedWindow()?.close());

// ── App lifecycle ──────────────────────────────────────────────────
app.whenReady().then(() => {
  startWSServer();
  setupIPC();
  createWindow();
});

app.on('window-all-closed', () => {
  if (wss) wss.close();
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
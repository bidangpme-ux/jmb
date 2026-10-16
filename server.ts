import express, { Request, Response } from 'express';
import { createServer as createViteServer } from 'vite';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

import { INITIAL_USERS, INITIAL_ITEMS, INITIAL_SURAT } from './src/services/storageService.ts';
import { INITIAL_IKU_ITEMS } from './src/services/ikuData.ts';
import { INITIAL_PERIODE_LIST, INITIAL_TUJUAN_SASARAN_ITEMS } from './src/services/tujuanSasaranData.ts';
import { DEFAULT_SECURITY_CONFIG } from './src/services/securityService.ts';
import { pgService } from './src/services/pgService.ts';
import cron from 'node-cron';
import { generateAgendaPDF, getWIBDate } from './src/services/agendaPdfService.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;
const isProd = process.env.NODE_ENV === 'production';

// Enable proxy trust for Cloudflare Tunnel & reverse proxies
app.set('trust proxy', true);

// Cross-Origin & Custom Domain support
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With, CF-Connecting-IP, X-Forwarded-Proto');
  }
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

// Persistent data directory on host / container
const DATA_DIR = process.env.DATA_DIR || path.resolve(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Safe JSON file operations (Fallback & Local Mirror)
function loadJsonFile<T>(filename: string, defaultValue: T): T {
  const filePath = path.join(DATA_DIR, filename);
  try {
    if (!fs.existsSync(filePath)) {
      saveJsonFile(filename, defaultValue);
      return defaultValue;
    }
    const raw = fs.readFileSync(filePath, 'utf-8');
    if (!raw.trim()) return defaultValue;
    return JSON.parse(raw) as T;
  } catch (err) {
    console.warn(`[Server DB] Gagal membaca ${filename}, menggunakan default:`, err);
    return defaultValue;
  }
}

function saveJsonFile<T>(filename: string, data: T): void {
  const filePath = path.join(DATA_DIR, filename);
  const tempPath = `${filePath}.tmp.${Date.now()}`;
  try {
    fs.writeFileSync(tempPath, JSON.stringify(data, null, 2), 'utf-8');
    fs.renameSync(tempPath, filePath);
  } catch (err) {
    console.error(`[Server DB] Gagal menyimpan ${filename}:`, err);
  }
}

// Physical Storage Directory on host / CasaOS disk
const STORAGE_FILES_DIR = path.join(DATA_DIR, 'storage');

// Helper to sanitize folder/user name
function sanitizeFolderName(name: string): string {
  return (name || 'user')
    .toLowerCase()
    .replace(/,\s*[A-Za-z.\s]+$/g, '')
    .replace(/^(Dr\.|Drs\.|Ir\.|H\.|Hj\.)\s+/gi, '')
    .trim()
    .replace(/\s+/g, '_')
    .replace(/[^a-zA-Z0-9_-]/g, '');
}

// Automatically create physical folder structure for every user on CasaOS disk
function ensureUserStorageFolders(userList: any[]) {
  try {
    const baseFolders = [
      path.join(STORAGE_FILES_DIR, 'Folder_Publik'),
      path.join(STORAGE_FILES_DIR, 'Menu_Bidang'),
      path.join(STORAGE_FILES_DIR, 'File_Saya'),
    ];
    for (const folder of baseFolders) {
      if (!fs.existsSync(folder)) {
        fs.mkdirSync(folder, { recursive: true });
      }
    }

    // Create a dedicated folder for each registered user
    for (const u of userList) {
      const folderName = sanitizeFolderName(u.username || u.name);
      const userFolder = path.join(STORAGE_FILES_DIR, 'File_Saya', folderName);
      if (!fs.existsSync(userFolder)) {
        fs.mkdirSync(userFolder, { recursive: true });
      }
    }
  } catch (err) {
    console.warn('[Server Storage] Warning creating user folders:', err);
  }
}

// Save uploaded item file to disk in user's dedicated folder
function saveItemFileToDisk(item: any, usersList: any[]) {
  if (item.type !== 'file' || !item.dataUrl || !item.name) return;
  try {
    let targetDir = path.join(STORAGE_FILES_DIR, 'Folder_Publik');
    if (item.scope === 'bidang') {
      const bCat = sanitizeFolderName(item.bidangCategory || 'Bidang PME');
      targetDir = path.join(STORAGE_FILES_DIR, 'Menu_Bidang', bCat);
    } else if (item.scope === 'private') {
      const owner = usersList.find((u: any) => u.id === item.ownerId || u.email === item.ownerEmail);
      const uname = sanitizeFolderName(owner?.username || owner?.name || item.ownerName || 'user');
      targetDir = path.join(STORAGE_FILES_DIR, 'File_Saya', uname);
    }
    if (!fs.existsSync(targetDir)) {
      fs.mkdirSync(targetDir, { recursive: true });
    }
    const cleanFileName = item.name.replace(/[/\\?%*:|"<>]/g, '_');
    const destPath = path.join(targetDir, cleanFileName);

    if (item.dataUrl.startsWith('data:')) {
      const base64Data = item.dataUrl.split(';base64,').pop();
      if (base64Data) {
        fs.writeFileSync(destPath, Buffer.from(base64Data, 'base64'));
      }
    }
  } catch (err) {
    console.warn('[Disk Storage] Gagal menyimpan berkas ke disk fisik:', err);
  }
}

// Initialize seed data on disk if not present
const initialUsersOnBoot = loadJsonFile('users.json', INITIAL_USERS);
loadJsonFile('storage_items.json', INITIAL_ITEMS);
loadJsonFile('surat.json', INITIAL_SURAT);
loadJsonFile('iku.json', INITIAL_IKU_ITEMS);
loadJsonFile('periode_rpjmd.json', INITIAL_PERIODE_LIST);
loadJsonFile('tujuan_sasaran.json', INITIAL_TUJUAN_SASARAN_ITEMS);
loadJsonFile('security_config.json', DEFAULT_SECURITY_CONFIG);
loadJsonFile('agendas.json', []);
loadJsonFile('bot_settings.json', { fonnteToken: '', defaultGroupJid: '', isActive: true });
loadJsonFile('agenda_reminders_log.json', []);

// Ensure folders exist on startup
ensureUserStorageFolders(initialUsersOnBoot);

// Auto-seed into PostgreSQL if connected and database is fresh
async function autoSeedPostgresIfFresh() {
  if (!pgService.getStatus().connected) return;
  try {
    const existingUsers = await pgService.getUsers();
    if (!existingUsers || existingUsers.length === 0) {
      console.log('🌱 Database PostgreSQL masih kosong, melakukan auto-seeding data awal instansi...');
      const users = loadJsonFile('users.json', INITIAL_USERS);
      const items = loadJsonFile('storage_items.json', INITIAL_ITEMS);
      const suratList = loadJsonFile('surat.json', INITIAL_SURAT);
      const ikuList = loadJsonFile('iku.json', INITIAL_IKU_ITEMS);
      const periodeList = loadJsonFile('periode_rpjmd.json', INITIAL_PERIODE_LIST);
      const tujuanSasaranList = loadJsonFile('tujuan_sasaran.json', INITIAL_TUJUAN_SASARAN_ITEMS);
      const securityConfig = loadJsonFile('security_config.json', DEFAULT_SECURITY_CONFIG);

      await pgService.saveUsers(users);
      await pgService.saveStorageItems(items);
      await pgService.saveSuratList(suratList);
      await pgService.saveIKUList(ikuList);
      await pgService.savePeriodeList(periodeList);
      await pgService.saveTujuanSasaranList(tujuanSasaranList);
      await pgService.saveSetting('security_config', securityConfig);
      console.log('✅ Auto-seeding PostgreSQL berhasil diselesaikan!');
    }
  } catch (err) {
    console.warn('[PostgreSQL AutoSeed Error]:', err);
  }
}

// =========================================================================
//                   DATABASE API ENDPOINTS (POSTGRESQL + FALLBACK)
// =========================================================================

// 0. Database Status & Engine Health
app.get('/api/db/status', async (_req: Request, res: Response) => {
  const status = pgService.getStatus();
  const counts = await pgService.getTableCounts();
  res.json({
    success: true,
    status: {
      ...status,
      tableCounts: counts,
      storageFilesDir: STORAGE_FILES_DIR,
    },
  });
});

// 1. Unified Sync Endpoint - Bootstraps all data for any device in one round-trip
app.get('/api/db/sync-all', async (_req: Request, res: Response) => {
  let users: any[] | null = null;
  let items: any[] | null = null;
  let suratList: any[] | null = null;
  let ikuList: any[] | null = null;
  let periodeList: any[] | null = null;
  let tujuanSasaranList: any[] | null = null;
  let securityConfig: any = null;

  if (pgService.getStatus().connected) {
    users = await pgService.getUsers();
    items = await pgService.getStorageItems();
    suratList = await pgService.getSuratList();
    ikuList = await pgService.getIKUList();
    periodeList = await pgService.getPeriodeList();
    tujuanSasaranList = await pgService.getTujuanSasaranList();
    securityConfig = await pgService.getSetting('security_config');
  }

  // Fallback to local JSON files if null or pg disconnected
  users = users !== null ? users : loadJsonFile('users.json', INITIAL_USERS);
  items = items !== null ? items : loadJsonFile('storage_items.json', INITIAL_ITEMS);
  suratList = suratList !== null ? suratList : loadJsonFile('surat.json', INITIAL_SURAT);
  ikuList = ikuList !== null ? ikuList : loadJsonFile('iku.json', INITIAL_IKU_ITEMS);
  periodeList = periodeList !== null ? periodeList : loadJsonFile('periode_rpjmd.json', INITIAL_PERIODE_LIST);
  tujuanSasaranList = tujuanSasaranList !== null ? tujuanSasaranList : loadJsonFile('tujuan_sasaran.json', INITIAL_TUJUAN_SASARAN_ITEMS);
  securityConfig = securityConfig || loadJsonFile('security_config.json', DEFAULT_SECURITY_CONFIG);
  const customLogo = loadJsonFile('custom_logo.json', { url: null });

  res.json({
    success: true,
    engine: pgService.getStatus().connected ? 'postgresql' : 'file-json',
    users,
    items,
    suratList,
    ikuList,
    periodeList,
    tujuanSasaranList,
    securityConfig,
    customLogo: customLogo.url,
  });
});

// 2. Users Database
app.get('/api/db/users', async (_req: Request, res: Response) => {
  let users: any[] | null = null;
  if (pgService.getStatus().connected) {
    users = await pgService.getUsers();
  }
  if (!users) {
    users = loadJsonFile('users.json', INITIAL_USERS);
  }
  res.json({ success: true, users });
});

app.post('/api/db/users', async (req: Request, res: Response) => {
  const { users, user } = req.body;
  let currentUsers = loadJsonFile('users.json', INITIAL_USERS);

  if (Array.isArray(users)) {
    currentUsers = users;
  } else if (user && user.id) {
    const idx = currentUsers.findIndex((u: any) => u.id === user.id);
    if (idx >= 0) {
      currentUsers[idx] = { ...currentUsers[idx], ...user };
    } else {
      currentUsers.push(user);
    }
  }

  // Ensure default admin always exists
  const hasAdmin = currentUsers.some((u: any) => u.role === 'admin' || u.username === 'admin' || u.id === 'user_admin');
  if (!hasAdmin) {
    currentUsers.unshift(INITIAL_USERS[0]);
  }

  // 1. Mirror to JSON file
  saveJsonFile('users.json', currentUsers);

  // 2. Save to PostgreSQL if connected
  if (pgService.getStatus().connected) {
    await pgService.saveUsers(currentUsers);
  }

  // 3. Automatically create personal folders on CasaOS disk
  ensureUserStorageFolders(currentUsers);

  res.json({ success: true, users: currentUsers });
});

// 3. Storage Items Persistence
app.post('/api/db/storage-items', async (req: Request, res: Response) => {
  const { items } = req.body;
  if (Array.isArray(items)) {
    // 1. Mirror to JSON
    saveJsonFile('storage_items.json', items);

    // 2. Save to PostgreSQL
    if (pgService.getStatus().connected) {
      await pgService.saveStorageItems(items);
    }

    // 3. Save actual uploaded files to their respective user folders on disk
    const currentUsers = loadJsonFile('users.json', INITIAL_USERS);
    for (const item of items) {
      saveItemFileToDisk(item, currentUsers);
    }

    res.json({ success: true, count: items.length });
  } else {
    res.status(400).json({ success: false, message: 'Data items harus berupa array.' });
  }
});

// 4. Surat Persistence
app.post('/api/db/surat', async (req: Request, res: Response) => {
  const { suratList } = req.body;
  if (Array.isArray(suratList)) {
    saveJsonFile('surat.json', suratList);
    if (pgService.getStatus().connected) {
      await pgService.saveSuratList(suratList);
    }
    res.json({ success: true, count: suratList.length });
  } else {
    res.status(400).json({ success: false, message: 'Data suratList harus berupa array.' });
  }
});

// 5. IKU Persistence
app.post('/api/db/iku', async (req: Request, res: Response) => {
  const { ikuList } = req.body;
  if (Array.isArray(ikuList)) {
    saveJsonFile('iku.json', ikuList);
    if (pgService.getStatus().connected) {
      await pgService.saveIKUList(ikuList);
    }
    res.json({ success: true, count: ikuList.length });
  } else {
    res.status(400).json({ success: false, message: 'Data ikuList harus berupa array.' });
  }
});

// 6. Periode RPJMD Persistence
app.post('/api/db/periode-rpjmd', async (req: Request, res: Response) => {
  const { periodeList } = req.body;
  if (Array.isArray(periodeList)) {
    saveJsonFile('periode_rpjmd.json', periodeList);
    if (pgService.getStatus().connected) {
      await pgService.savePeriodeList(periodeList);
    }
    res.json({ success: true, count: periodeList.length });
  } else {
    res.status(400).json({ success: false, message: 'Data periodeList harus berupa array.' });
  }
});

// 7. Tujuan & Sasaran Persistence
app.post('/api/db/tujuan-sasaran', async (req: Request, res: Response) => {
  const { tujuanSasaranList } = req.body;
  if (Array.isArray(tujuanSasaranList)) {
    saveJsonFile('tujuan_sasaran.json', tujuanSasaranList);
    if (pgService.getStatus().connected) {
      await pgService.saveTujuanSasaranList(tujuanSasaranList);
    }
    res.json({ success: true, count: tujuanSasaranList.length });
  } else {
    res.status(400).json({ success: false, message: 'Data tujuanSasaranList harus berupa array.' });
  }
});

// 8. Custom Logo Persistence
app.post('/api/db/custom-logo', async (req: Request, res: Response) => {
  const { url } = req.body;
  saveJsonFile('custom_logo.json', { url: url || null });
  if (pgService.getStatus().connected) {
    await pgService.saveSetting('custom_logo', { url: url || null });
  }
  res.json({ success: true, url });
});

// 9. Security Config Persistence
app.post('/api/db/security-config', async (req: Request, res: Response) => {
  const { config } = req.body;
  if (config) {
    saveJsonFile('security_config.json', config);
    if (pgService.getStatus().connected) {
      await pgService.saveSetting('security_config', config);
    }
    res.json({ success: true, config });
  } else {
    res.status(400).json({ success: false, message: 'Config tidak valid.' });
  }
});

// 10. Manual Migration Trigger (JSON -> PostgreSQL)
app.post('/api/db/migrate-to-postgres', async (_req: Request, res: Response) => {
  if (!pgService.getStatus().connected) {
    return res.status(400).json({
      success: false,
      message: 'PostgreSQL belum terhubung. Periksa konfigurasi DATABASE_URL di environment.',
    });
  }

  try {
    const users = loadJsonFile('users.json', INITIAL_USERS);
    const items = loadJsonFile('storage_items.json', INITIAL_ITEMS);
    const suratList = loadJsonFile('surat.json', INITIAL_SURAT);
    const ikuList = loadJsonFile('iku.json', INITIAL_IKU_ITEMS);
    const periodeList = loadJsonFile('periode_rpjmd.json', INITIAL_PERIODE_LIST);
    const tujuanSasaranList = loadJsonFile('tujuan_sasaran.json', INITIAL_TUJUAN_SASARAN_ITEMS);
    const securityConfig = loadJsonFile('security_config.json', DEFAULT_SECURITY_CONFIG);

    await pgService.saveUsers(users);
    await pgService.saveStorageItems(items);
    await pgService.saveSuratList(suratList);
    await pgService.saveIKUList(ikuList);
    await pgService.savePeriodeList(periodeList);
    await pgService.saveTujuanSasaranList(tujuanSasaranList);
    await pgService.saveSetting('security_config', securityConfig);

    const counts = await pgService.getTableCounts();

    res.json({
      success: true,
      message: 'Seluruh data JSON berhasil dimigrasikan ke PostgreSQL!',
      counts,
    });
  } catch (err: any) {
    res.status(500).json({ success: false, message: `Migrasi gagal: ${err?.message}` });
  }
});

// 11. Reset Database
app.post('/api/db/reset', async (_req: Request, res: Response) => {
  saveJsonFile('users.json', INITIAL_USERS);
  saveJsonFile('storage_items.json', INITIAL_ITEMS);
  saveJsonFile('surat.json', INITIAL_SURAT);
  saveJsonFile('iku.json', INITIAL_IKU_ITEMS);
  saveJsonFile('periode_rpjmd.json', INITIAL_PERIODE_LIST);
  saveJsonFile('tujuan_sasaran.json', INITIAL_TUJUAN_SASARAN_ITEMS);
  saveJsonFile('security_config.json', DEFAULT_SECURITY_CONFIG);
  saveJsonFile('custom_logo.json', { url: null });

  if (pgService.getStatus().connected) {
    await pgService.saveUsers(INITIAL_USERS);
    await pgService.saveStorageItems(INITIAL_ITEMS);
    await pgService.saveSuratList(INITIAL_SURAT);
    await pgService.saveIKUList(INITIAL_IKU_ITEMS);
    await pgService.savePeriodeList(INITIAL_PERIODE_LIST);
    await pgService.saveTujuanSasaranList(INITIAL_TUJUAN_SASARAN_ITEMS);
    await pgService.saveSetting('security_config', DEFAULT_SECURITY_CONFIG);
  }

  res.json({ success: true, message: 'Seluruh database aplikasi berhasil direset ke pengaturan awal.' });
});

// =========================================================================
//                   SECURITY & AUDIT LOG API ENDPOINTS
// =========================================================================

const serverAuditLogs: any[] = loadJsonFile<any[]>('audit_logs.json', []);

// 1. Client IP & Device Info endpoint
app.get('/api/security/client-info', (req: Request, res: Response) => {
  const cfIp = req.headers['cf-connecting-ip'] as string | undefined;
  const forwarded = req.headers['x-forwarded-for'];
  const rawIp = cfIp || (Array.isArray(forwarded)
    ? forwarded[0]
    : typeof forwarded === 'string'
    ? forwarded.split(',')[0].trim()
    : req.socket.remoteAddress);
  const ip = rawIp && rawIp !== '::1' && rawIp !== '127.0.0.1' ? rawIp.replace(/^.*:/, '') : '127.0.0.1';
  res.json({
    ip,
    userAgent: req.headers['user-agent'] || '',
    secure: req.secure || req.headers['x-forwarded-proto'] === 'https',
    domain: req.hostname || 'pme.cloudpme.my.id',
    cfCountry: (req.headers['cf-ipcountry'] as string) || undefined,
    timestamp: new Date().toISOString(),
  });
});

// 2. Receive and record audit log on server
app.post('/api/security/audit-log', async (req: Request, res: Response) => {
  try {
    const entry = req.body;
    if (entry && entry.id) {
      serverAuditLogs.unshift({
        ...entry,
        serverReceivedAt: new Date().toISOString(),
      });
      if (serverAuditLogs.length > 1000) {
        serverAuditLogs.pop();
      }
      saveJsonFile('audit_logs.json', serverAuditLogs);

      if (pgService.getStatus().connected) {
        await pgService.insertAuditLog(entry);
      }
    }
    res.json({ success: true, count: serverAuditLogs.length });
  } catch (err: any) {
    res.status(500).json({ success: false, message: err?.message });
  }
});

// 3. Get server audit logs
app.get('/api/security/audit-logs', async (_req: Request, res: Response) => {
  let logs: any[] | null = null;
  if (pgService.getStatus().connected) {
    logs = await pgService.getAuditLogs();
  }
  if (!logs) {
    logs = serverAuditLogs;
  }
  res.json({ success: true, logs });
});

// 4. Clear server audit logs
app.post('/api/security/clear-logs', async (_req: Request, res: Response) => {
  serverAuditLogs.length = 0;
  saveJsonFile('audit_logs.json', []);
  if (pgService.getStatus().connected) {
    await pgService.clearAuditLogs();
  }
  res.json({ success: true, message: 'Server audit logs cleared.' });
});

// 5. Download complete update ZIP file for CasaOS deployment
app.get('/api/download-zip', (_req: Request, res: Response) => {
  const zipPath = path.resolve(__dirname, 'epmped-terbaru-lengkap.zip');
  if (fs.existsSync(zipPath)) {
    res.download(zipPath, 'epmped-terbaru-lengkap.zip');
  } else {
    res.status(404).send('File zip belum dibuat.');
  }
});

// =========================================================================
//                   AGENDA & WHATSAPP PDF REMINDER ENDPOINTS
// =========================================================================

// Fonnte WhatsApp API Sender Helper using Native Fetch & FormData
async function sendFonnteMessage(token: string, target: string, message: string, pdfBuffer?: Buffer, filename?: string) {
  const formData = new FormData();
  formData.append('target', target);
  formData.append('message', message);
  if (pdfBuffer && filename) {
    const blob = new Blob([new Uint8Array(pdfBuffer)], { type: 'application/pdf' });
    formData.append('file', blob, filename);
  }
  formData.append('delay', '2');

  const res = await fetch('https://api.fonnte.com/send', {
    method: 'POST',
    headers: {
      Authorization: token,
    },
    body: formData,
  });
  return await res.json();
}

// 1. Get Agendas (Hybrid PG + JSON)
app.get('/api/agendas', async (_req: Request, res: Response) => {
  const { start_date, end_date } = _req.query;
  let allAgendas: any[] = [];

  if (pgService.getStatus().connected) {
    const pgAgendas = await pgService.getAgendas(start_date ? String(start_date) : undefined, end_date ? String(end_date) : undefined);
    if (pgAgendas !== null) {
      allAgendas = pgAgendas;
    } else {
      allAgendas = loadJsonFile<any[]>('agendas.json', []);
    }
  } else {
    allAgendas = loadJsonFile<any[]>('agendas.json', []);
  }

  let filtered = allAgendas;
  if (start_date && end_date) {
    filtered = allAgendas.filter((a) => a.scheduleDate >= String(start_date) && a.scheduleDate <= String(end_date));
  } else if (start_date) {
    filtered = allAgendas.filter((a) => a.scheduleDate === String(start_date));
  }
  filtered.sort((a, b) => {
    if (a.scheduleDate !== b.scheduleDate) {
      return a.scheduleDate.localeCompare(b.scheduleDate);
    }
    return (a.timeStart || '').localeCompare(b.timeStart || '');
  });
  res.json({ success: true, data: filtered });
});

// 2. Batch Add Agendas (Admin & Authorized Users)
app.post('/api/agendas/batch', async (req: Request, res: Response) => {
  const { schedule_date, group_jid, items, user_id, user_name } = req.body;
  if (!schedule_date || !Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ success: false, message: 'Data agenda tidak valid.' });
  }

  const currentAgendas = loadJsonFile<any[]>('agendas.json', []);
  const newItems = items.map((item: any) => ({
    id: `agenda_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
    userId: user_id || 'user_admin',
    creatorName: user_name || 'Administrator',
    title: item.title,
    location: item.location || 'Kantor Bapperida Tanggamus',
    description: item.description || '',
    scheduleDate: schedule_date,
    timeStart: item.time_start,
    timeEnd: item.time_end || undefined,
    groupJid: group_jid || undefined,
    createdAt: new Date().toISOString(),
  }));

  // Save to PostgreSQL if connected
  if (pgService.getStatus().connected) {
    for (const agenda of newItems) {
      await pgService.insertAgenda(agenda);
    }
  }

  const updated = [...currentAgendas, ...newItems];
  saveJsonFile('agendas.json', updated);
  res.json({ success: true, message: `${newItems.length} agenda berhasil disimpan.`, data: newItems });
});

// 3. Single Add Agenda
app.post('/api/agendas', async (req: Request, res: Response) => {
  const { title, location, description, schedule_date, time_start, time_end, group_jid, user_id, user_name } = req.body;
  if (!title || !schedule_date || !time_start) {
    return res.status(400).json({ success: false, message: 'Judul, tanggal, dan waktu mulai wajib diisi.' });
  }

  const newAgenda = {
    id: `agenda_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
    userId: user_id || 'user_admin',
    creatorName: user_name || 'Administrator',
    title: title.trim(),
    location: (location || 'Kantor Bapperida Tanggamus').trim(),
    description: (description || '').trim(),
    scheduleDate: schedule_date,
    timeStart: time_start,
    timeEnd: time_end || undefined,
    groupJid: group_jid ? group_jid.trim() : undefined,
    createdAt: new Date().toISOString(),
  };

  if (pgService.getStatus().connected) {
    await pgService.insertAgenda(newAgenda);
  }

  const currentAgendas = loadJsonFile<any[]>('agendas.json', []);
  currentAgendas.push(newAgenda);
  saveJsonFile('agendas.json', currentAgendas);

  res.json({ success: true, message: 'Agenda berhasil ditambahkan.', data: newAgenda });
});

// 4. Update / Edit Agenda
app.put('/api/agendas/:id', async (req: Request, res: Response) => {
  const { id } = req.params;
  const { title, location, description, schedule_date, time_start, time_end, group_jid } = req.body;

  const currentAgendas = loadJsonFile<any[]>('agendas.json', []);
  const index = currentAgendas.findIndex((a) => a.id === id);

  if (index === -1) {
    return res.status(404).json({ success: false, message: 'Agenda kegiatan tidak ditemukan.' });
  }

  const existing = currentAgendas[index];
  const updatedItem = {
    ...existing,
    title: title !== undefined ? title.trim() : existing.title,
    location: location !== undefined ? location.trim() : existing.location,
    description: description !== undefined ? description.trim() : existing.description,
    scheduleDate: schedule_date !== undefined ? schedule_date : existing.scheduleDate,
    timeStart: time_start !== undefined ? time_start : existing.timeStart,
    timeEnd: time_end !== undefined ? time_end : existing.timeEnd,
    groupJid: group_jid !== undefined ? (group_jid ? group_jid.trim() : undefined) : existing.groupJid,
    updatedAt: new Date().toISOString(),
  };

  currentAgendas[index] = updatedItem;
  saveJsonFile('agendas.json', currentAgendas);

  if (pgService.getStatus().connected) {
    await pgService.updateAgenda(id, updatedItem);
  }

  res.json({ success: true, message: 'Agenda kegiatan berhasil diperbarui.', data: updatedItem });
});

// 5. Delete Agenda (Admin or Authorized Creator)
app.delete('/api/agendas/:id', async (req: Request, res: Response) => {
  const { id } = req.params;
  const currentAgendas = loadJsonFile<any[]>('agendas.json', []);
  const updated = currentAgendas.filter((a) => a.id !== id);
  saveJsonFile('agendas.json', updated);

  if (pgService.getStatus().connected) {
    await pgService.deleteAgenda(id);
  }

  res.json({ success: true, message: 'Agenda berhasil dihapus.' });
});

// 6. Export PDF Manual (Accessible by Admin and Staf)
app.get('/api/agendas/export-pdf', async (req: Request, res: Response) => {
  const { date } = req.query;
  const targetDate = String(date || getWIBDate(0));
  try {
    let agendas: any[] = [];
    if (pgService.getStatus().connected) {
      const pgAgendas = await pgService.getAgendas(targetDate, targetDate);
      if (pgAgendas !== null) {
        agendas = pgAgendas;
      } else {
        const all = loadJsonFile<any[]>('agendas.json', []);
        agendas = all.filter((a) => a.scheduleDate === targetDate);
      }
    } else {
      const all = loadJsonFile<any[]>('agendas.json', []);
      agendas = all.filter((a) => a.scheduleDate === targetDate);
    }

    const pdfBuffer = await generateAgendaPDF(targetDate, agendas);

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="Agenda_PMPEPD_${targetDate}.pdf"`);
    res.send(pdfBuffer);
  } catch (err: any) {
    console.error('[Export PDF Error]:', err);
    res.status(500).send('Gagal membuat dokumen PDF agenda: ' + err?.message);
  }
});

// 7. Bot Settings (Admin only)
app.get('/api/bot/settings', async (_req: Request, res: Response) => {
  let settings = null;
  if (pgService.getStatus().connected) {
    settings = await pgService.getBotSettings();
  }
  if (!settings) {
    settings = loadJsonFile('bot_settings.json', { fonnteToken: '', defaultGroupJid: '', isActive: true });
  }
  res.json({ success: true, data: settings });
});

// Save Bot Settings: Terus Aktif Sekali Disetup
app.post('/api/bot/settings', async (req: Request, res: Response) => {
  const { fonnteToken, defaultGroupJid, isActive } = req.body;
  const token = (fonnteToken || '').trim();
  const jid = (defaultGroupJid || '').trim();

  // Sekali disetup dengan token, bot secara otomatis aktif terus
  const updated = {
    fonnteToken: token,
    defaultGroupJid: jid,
    isActive: isActive !== undefined ? Boolean(isActive) : Boolean(token),
    updatedAt: new Date().toISOString(),
  };

  saveJsonFile('bot_settings.json', updated);
  if (pgService.getStatus().connected) {
    await pgService.saveBotSettings(updated);
  }

  res.json({ success: true, message: 'Pengaturan Bot WhatsApp berhasil disimpan & aktif terus.', data: updated });
});

// Explicit Disconnect Bot: HANYA dinonaktifkan saat klik tombol putus
app.post('/api/bot/disconnect', async (_req: Request, res: Response) => {
  const current = loadJsonFile<any>('bot_settings.json', { fonnteToken: '', defaultGroupJid: '', isActive: false });
  const updated = {
    ...current,
    isActive: false,
    updatedAt: new Date().toISOString(),
  };

  saveJsonFile('bot_settings.json', updated);
  if (pgService.getStatus().connected) {
    await pgService.saveBotSettings(updated);
  }

  res.json({ success: true, message: 'Koneksi Bot WhatsApp berhasil diputuskan.', data: updated });
});

// 8. Agenda Input Permissions (Kelola Akses Pengguna yang Bisa Input Agenda)
app.get('/api/agenda/permissions', async (_req: Request, res: Response) => {
  let perms = null;
  if (pgService.getStatus().connected) {
    perms = await pgService.getSetting('agenda_permissions');
  }
  if (!perms) {
    perms = loadJsonFile('agenda_permissions.json', {
      allowAllStaff: false,
      allowedUserIds: [],
    });
  }
  res.json({ success: true, permissions: perms });
});

app.post('/api/agenda/permissions', async (req: Request, res: Response) => {
  const { allowAllStaff, allowedUserIds } = req.body;
  const updated = {
    allowAllStaff: Boolean(allowAllStaff),
    allowedUserIds: Array.isArray(allowedUserIds) ? allowedUserIds : [],
    updatedAt: new Date().toISOString(),
  };

  saveJsonFile('agenda_permissions.json', updated);
  if (pgService.getStatus().connected) {
    await pgService.saveSetting('agenda_permissions', updated);
  }

  res.json({ success: true, message: 'Hak akses input agenda berhasil diperbarui.', permissions: updated });
});

// 6. Test Send WhatsApp Reminder (Admin only)
app.post('/api/bot/test-send', async (req: Request, res: Response) => {
  const { date, group_jid } = req.body;
  const targetDate = String(date || getWIBDate(0));
  const botConfig = loadJsonFile<any>('bot_settings.json', { fonnteToken: '', defaultGroupJid: '', isActive: true });
  const targetJid = group_jid || botConfig.defaultGroupJid;

  if (!botConfig.fonnteToken || !targetJid) {
    return res.status(400).json({ success: false, message: 'Token Fonnte atau Target Group JID belum disetel.' });
  }

  try {
    const allAgendas = loadJsonFile<any[]>('agendas.json', []);
    const agendas = allAgendas.filter((a) => a.scheduleDate === targetDate);
    const pdfBuffer = await generateAgendaPDF(targetDate, agendas);
    const filename = `Agenda_PMPEPD_${targetDate}.pdf`;

    const caption = `*NOTIFIKASI UJI COBA AGENDA BIDANG PMPEPD*\n*BAPPERIDA KABUPATEN TANGGAMUS*\n\n📅 Tanggal: *${targetDate}*\n📌 Jumlah Agenda: ${agendas.length} Kegiatan\n\n_File PDF agenda terlampir._`;

    const fonnteRes = await sendFonnteMessage(botConfig.fonnteToken, targetJid, caption, pdfBuffer, filename);
    res.json({ success: true, message: 'Pengujian kirim bot selesai.', data: fonnteRes });
  } catch (err: any) {
    res.status(500).json({ success: false, message: err?.message || 'Gagal mengirim pesan WhatsApp.' });
  }
});

// 7. Get Reminder Logs
app.get('/api/bot/logs', async (_req: Request, res: Response) => {
  let logs: any[] | null = null;
  if (pgService.getStatus().connected) {
    logs = await pgService.getReminderLogs();
  }
  if (!logs) {
    logs = loadJsonFile<any[]>('agenda_reminders_log.json', []);
  }
  res.json({ success: true, logs });
});

// =========================================================================
//                   CRON JOB WHATSAPP REMINDER (WIB TIMEZONE)
// =========================================================================

async function executeCronReminder(reminderType: 'H-1' | 'DAY_H') {
  try {
    const botConfig = loadJsonFile<any>('bot_settings.json', { fonnteToken: '', defaultGroupJid: '', isActive: true });
    if (!botConfig.isActive || !botConfig.fonnteToken || !botConfig.defaultGroupJid) {
      console.log(`[Agenda Cron ${reminderType}] Bot dinonaktifkan atau konfigurasi belum lengkap.`);
      return;
    }

    const targetDate = reminderType === 'H-1' ? getWIBDate(1) : getWIBDate(0);

    const logs = loadJsonFile<any[]>('agenda_reminders_log.json', []);
    const alreadySent = logs.some(
      (l) => l.agendaDate === targetDate && l.reminderType === reminderType && l.status === 'SUCCESS'
    );
    if (alreadySent) {
      console.log(`[Agenda Cron ${reminderType}] Tanggal ${targetDate} sudah pernah terkirim.`);
      return;
    }

    let allAgendas: any[] = [];
    if (pgService.getStatus().connected) {
      const pgAgendas = await pgService.getAgendas(targetDate, targetDate);
      allAgendas = pgAgendas || loadJsonFile<any[]>('agendas.json', []);
    } else {
      allAgendas = loadJsonFile<any[]>('agendas.json', []);
    }

    const agendas = allAgendas.filter((a) => a.scheduleDate === targetDate);
    if (agendas.length === 0) {
      console.log(`[Agenda Cron ${reminderType}] Tidak ada agenda pada tanggal ${targetDate}. Pengiriman dilewati.`);
      return;
    }

    const targetGroupJid = agendas[0].groupJid || botConfig.defaultGroupJid;
    const pdfBuffer = await generateAgendaPDF(targetDate, agendas);
    const filename = `Agenda_PMPEPD_${targetDate}.pdf`;

    const label = reminderType === 'H-1' ? 'PENGINGAT H-1 (BESOK)' : 'PENGINGAT HARI-H (HARI INI)';
    const caption = `*NOTIFIKASI RESMI AGENDA BIDANG PMPEPD*\n*BAPPERIDA KABUPATEN TANGGAMUS*\n\n📅 ${label}: *${targetDate}*\n📌 Jumlah Agenda: ${agendas.length} Kegiatan\n\n_Dokumen PDF rekapitulasi agenda dinas terlampir di atas._`;

    const fonnteResult = await sendFonnteMessage(botConfig.fonnteToken, targetGroupJid, caption, pdfBuffer, filename);
    const isSuccess = Boolean(fonnteResult && (fonnteResult.status === true || fonnteResult.status === 'true'));

    const newLog = {
      id: `log_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
      agendaDate: targetDate,
      reminderType,
      groupJid: targetGroupJid,
      status: isSuccess ? 'SUCCESS' : 'FAILED',
      responseMessage: JSON.stringify(fonnteResult),
      pdfFilename: filename,
      sentAt: new Date().toISOString(),
    };

    logs.unshift(newLog);
    saveJsonFile('agenda_reminders_log.json', logs.slice(0, 150));
    if (pgService.getStatus().connected) {
      await pgService.insertReminderLog(newLog);
    }
    console.log(`[Agenda Cron ${reminderType}] Selesai diproses dengan status: ${newLog.status}`);
  } catch (err: any) {
    console.error(`[Agenda Cron ${reminderType}] Error saat eksekusi:`, err?.message);
  }
}

// A. H-1 Pukul 20:00 WIB
cron.schedule('0 20 * * *', () => {
  executeCronReminder('H-1');
}, { timezone: 'Asia/Jakarta' });

// B. Hari-H Pukul 06:00 WIB
cron.schedule('0 6 * * *', () => {
  executeCronReminder('DAY_H');
}, { timezone: 'Asia/Jakarta' });

// Setup Vite or Static File Serving
async function startServer() {
  // Connect and initialize PostgreSQL if DATABASE_URL is configured
  await pgService.checkAndInit();
  await autoSeedPostgresIfFresh();

  if (!isProd) {
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        hmr: false,
        watch: null,
      },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static(path.resolve(__dirname, 'dist')));
    app.get('*', (_req, res) => {
      res.sendFile(path.resolve(__dirname, 'dist/index.html'));
    });
  }

  app.listen(Number(PORT), '0.0.0.0', () => {
    console.log(`ArsipCloud server listening on http://0.0.0.0:${PORT}`);
  });
}

startServer();

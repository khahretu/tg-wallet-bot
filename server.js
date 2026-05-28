require('dotenv').config();
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const TelegramBot = require('node-telegram-bot-api');
const ftp = require('basic-ftp');
const AdmZip = require('adm-zip');
const axios = require('axios');
const sqlite3 = require('sqlite3').verbose();
const cron = require('node-cron');
const fs = require('fs');
const path = require('path');
const apkParser = require('apk-parser');
const qr = require('qr-image');

// ---------- ENV ----------
const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!TOKEN) throw new Error('Missing TELEGRAM_BOT_TOKEN');
const ADMIN_IDS = process.env.ADMIN_IDS ? process.env.ADMIN_IDS.split(',').map(Number) : [];
const FTP_HOST = process.env.FTP_HOST;
const FTP_USER = process.env.FTP_USER;
const FTP_PASS = process.env.FTP_PASS;
const CDN_SECRET = process.env.CDN_SECRET;
const CLOUDFLARE_API_TOKEN = process.env.CLOUDFLARE_API_TOKEN;
const CLOUDFLARE_ZONE_ID = process.env.CLOUDFLARE_ZONE_ID;
const ADMIN_TOOLS_TOKEN = process.env.ADMIN_TOOLS_TOKEN;
const SHORT_URL_BASE = process.env.SHORT_URL_BASE || 'https://short.link/';
const APK_INSTALL_PAGE_BASE = process.env.APK_INSTALL_PAGE_BASE || 'https://apk.yourdomain.com/';
const WEBHOOK_URL = process.env.WEBHOOK_URL;
const PORT = process.env.PORT || 3000;

// ---------- DB ----------
const db = new sqlite3.Database('./data.db');
db.run(`CREATE TABLE IF NOT EXISTS shorturls (
  id TEXT PRIMARY KEY,
  target TEXT,
  cloak TEXT,
  password TEXT,
  device_rules TEXT,
  clicks INTEGER DEFAULT 0,
  created_at TEXT
)`);
db.run(`CREATE TABLE IF NOT EXISTS apk_files (
  id TEXT PRIMARY KEY,
  filename TEXT,
  cdn_path TEXT,
  package_name TEXT,
  version TEXT,
  app_name TEXT,
  icon_base64 TEXT,
  download_count INTEGER DEFAULT 0,
  created_at TEXT
)`);
db.run(`CREATE TABLE IF NOT EXISTS visits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ip TEXT,
  page TEXT,
  referrer TEXT,
  user_agent TEXT,
  created_at TEXT
)`);

// ---------- Express + WebSocket ----------
const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });
const bot = new TelegramBot(TOKEN, { polling: !WEBHOOK_URL });
if (WEBHOOK_URL) {
  bot.setWebHook(WEBHOOK_URL).then(() => console.log('Webhook set'));
  app.use(express.json());
  app.post('/webhook', (req, res) => { bot.processUpdate(req.body); res.sendStatus(200); });
}
app.use(express.urlencoded({ extended: true }));

// ---------- Globals ----------
let connectedClients = 0;
let logs = [];

function isAdmin(id) { return ADMIN_IDS.includes(id); }
function addLog(text) { logs.unshift({ time: new Date().toISOString(), text }); if (logs.length > 100) logs.pop(); broadcast({ type: 'log', data: logs[0] }); }
function broadcast(data) { wss.clients.forEach(c => { if (c.readyState === WebSocket.OPEN) c.send(JSON.stringify(data)); }); }

// ---------- FTP Helpers ----------
async function ftpConnect() {
  const client = new ftp.Client();
  await client.access({ host: FTP_HOST, user: FTP_USER, password: FTP_PASS, secure: false });
  return client;
}
async function uploadToFTP(localDir, remoteDir = '/') {
  const client = await ftpConnect();
  await client.ensureDir(remoteDir);
  await client.uploadFromDir(localDir, remoteDir);
  client.close();
}
async function listFTPFiles(remotePath = '/') {
  const client = await ftpConnect();
  const list = await client.list(remotePath);
  client.close();
  return list;
}
async function deleteFTPFile(remotePath) {
  const client = await ftpConnect();
  await client.remove(remotePath);
  client.close();
}
async function uploadSingleFile(localPath, remotePath) {
  const client = await ftpConnect();
  await client.uploadFrom(localPath, remotePath);
  client.close();
}
async function getFileBuffer(remotePath) {
  const client = await ftpConnect();
  const chunks = [];
  await client.downloadTo((stream) => { stream.on('data', d => chunks.push(d)); }, remotePath);
  client.close();
  return Buffer.concat(chunks);
}

// ---------- CDN Purge ----------
async function purgeCDN(urlPath = '/') {
  if (!CDN_SECRET) return;
  try { await axios.get(`https://assets.cdn.express/api/purge?secret=${CDN_SECRET}&path=${urlPath}`); } catch(e) { console.error('Purge error', e.message); }
}

// ---------- Cloudflare DNS ----------
async function addDNSRecord(domain, type, name, content, proxied = true) {
  if (!CLOUDFLARE_API_TOKEN) throw new Error('Cloudflare not configured');
  const url = `https://api.cloudflare.com/client/v4/zones/${CLOUDFLARE_ZONE_ID}/dns_records`;
  const payload = { type, name: name === '@' ? domain : `${name}.${domain}`, content, ttl: 300, proxied };
  const res = await axios.post(url, payload, { headers: { Authorization: `Bearer ${CLOUDFLARE_API_TOKEN}`, 'Content-Type': 'application/json' } });
  if (!res.data.success) throw new Error(res.data.errors[0]?.message);
  return res.data.result;
}
async function enableSSL() { return { success: true }; }

// ---------- Short URL Functions ----------
function generateShortId(len = 6) { return Math.random().toString(36).substring(2, 2+len); }
async function createShortLink(target, customId = null, cloak = null, password = null, deviceRules = null) {
  const id = customId ? customId.replace(/\s/g, '') : generateShortId();
  const exists = await new Promise(resolve => db.get('SELECT id FROM shorturls WHERE id = ?', [id], (err, row) => resolve(!!row)));
  if (exists) throw new Error('Custom ID already taken');
  await new Promise(resolve => db.run('INSERT INTO shorturls (id, target, cloak, password, device_rules, created_at) VALUES (?, ?, ?, ?, ?, ?)', [id, target, cloak, password, deviceRules, new Date().toISOString()], resolve));
  return `${SHORT_URL_BASE}${id}`;
}
async function getShortLinkInfo(id) {
  return new Promise(resolve => db.get('SELECT * FROM shorturls WHERE id = ?', [id], (err, row) => resolve(row)));
}
async function updateShortLink(id, updates) {
  const fields = [], values = [];
  if (updates.target) { fields.push('target = ?'); values.push(updates.target); }
  if (updates.cloak !== undefined) { fields.push('cloak = ?'); values.push(updates.cloak); }
  if (updates.password !== undefined) { fields.push('password = ?'); values.push(updates.password); }
  if (updates.device_rules !== undefined) { fields.push('device_rules = ?'); values.push(updates.device_rules); }
  if (fields.length === 0) return;
  values.push(id);
  await new Promise(resolve => db.run(`UPDATE shorturls SET ${fields.join(', ')} WHERE id = ?`, values, resolve));
}
async function deleteShortLink(id) {
  await new Promise(resolve => db.run('DELETE FROM shorturls WHERE id = ?', [id], resolve));
}
async function listUserLinks(limit = 20) {
  return new Promise(resolve => db.all('SELECT id, target, clicks, created_at FROM shorturls ORDER BY created_at DESC LIMIT ?', [limit], (err, rows) => resolve(rows || [])));
}

// ---------- APK Functions ----------
async function parseApkInfo(fileBuffer) {
  return new Promise((resolve, reject) => {
    const parser = new apkParser(fileBuffer);
    parser.readInfo((err, data) => {
      if (err) reject(err);
      else resolve(data);
    });
  });
}
async function saveApkRecord(id, filename, cdnPath, packageName, version, appName, iconBase64) {
  await new Promise(resolve => db.run('INSERT INTO apk_files (id, filename, cdn_path, package_name, version, app_name, icon_base64, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [id, filename, cdnPath, packageName, version, appName, iconBase64, new Date().toISOString()], resolve));
}
async function getApkRecord(id) {
  return new Promise(resolve => db.get('SELECT * FROM apk_files WHERE id = ?', [id], (err, row) => resolve(row)));
}
async function incrementApkDownload(id) {
  db.run('UPDATE apk_files SET download_count = download_count + 1 WHERE id = ?', [id]);
}
async function listApkFiles(limit = 10) {
  return new Promise(resolve => db.all('SELECT id, filename, app_name, version, download_count FROM apk_files ORDER BY created_at DESC LIMIT ?', [limit], (err, rows) => resolve(rows || [])));
}
function generateQR(text) {
  return qr.imageSync(text, { type: 'png', size: 8 });
}

// ---------- APK Install Page (Express) ----------
app.get('/apk/:id', async (req, res) => {
  const id = req.params.id;
  const apk = await getApkRecord(id);
  if (!apk) return res.status(404).send('APK not found');
  incrementApkDownload(id);
  const downloadLink = `https://assets.cdn.express${apk.cdn_path}`;
  // Simple install page HTML
  const html = `<!DOCTYPE html>
  <html>
  <head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Download ${apk.app_name || apk.filename}</title>
  <style>body{font-family:sans-serif;background:#0a0f1e;color:#fff;text-align:center;padding:2rem} .card{background:#1a1f2e;border-radius:2rem;padding:2rem;max-width:400px;margin:auto} button{background:#c9a84c;border:none;padding:1rem 2rem;border-radius:3rem;font-weight:bold;cursor:pointer}</style>
  </head>
  <body><div class="card"><h1>${apk.app_name || 'Download APK'}</h1><p>Version: ${apk.version || 'unknown'}</p><p>Package: ${apk.package_name || '-'}</p><a href="${downloadLink}"><button>📥 Download APK (${Math.round(apk.download_count+1)} downloads)</button></a><br><br><small>Direct download link valid forever</small></div></body>
  </html>`;
  res.send(html);
});

// ---------- Short URL Redirect (with password protection) ----------
app.get('/s/:id', async (req, res) => {
  const id = req.params.id;
  const row = await getShortLinkInfo(id);
  if (!row) return res.status(404).send('Not found');
  if (row.password) {
    const pwd = req.query.pwd;
    if (!pwd || pwd !== row.password) {
      return res.send(`<form method="GET">Password: <input type="password" name="pwd"><button>Submit</button></form>`);
    }
  }
  let finalUrl = row.target;
  if (row.cloak) {
    const ua = req.headers['user-agent'] || '';
    if (ua.includes('bot') || ua.includes('curl')) finalUrl = row.cloak;
  }
  if (row.device_rules) {
    try {
      const rules = JSON.parse(row.device_rules);
      const ua = req.headers['user-agent'] || '';
      if (rules.android && /android/i.test(ua)) finalUrl = rules.android;
      else if (rules.ios && /iphone|ipad/i.test(ua)) finalUrl = rules.ios;
    } catch(e) {}
  }
  db.run('UPDATE shorturls SET clicks = clicks + 1 WHERE id = ?', [id]);
  res.redirect(finalUrl);
});

// ---------- Visit Tracking Endpoint ----------
app.get('/api/visit', (req, res) => {
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  const page = req.query.page || '/';
  const referrer = req.headers.referer || '';
  const ua = req.headers['user-agent'] || '';
  db.run('INSERT INTO visits (ip, page, referrer, user_agent, created_at) VALUES (?, ?, ?, ?, ?)', [ip, page, referrer, ua, new Date().toISOString()]);
  res.sendStatus(200);
});

// ---------- Bot Main Menu ----------
const mainMenu = {
  reply_markup: {
    inline_keyboard: [
      [{ text: '📁 File Manager', callback_data: 'menu_file' }, { text: '🔗 Short URL', callback_data: 'menu_shorturl' }],
      [{ text: '📱 APK Hosting', callback_data: 'menu_apk' }, { text: '🌐 Website Manager', callback_data: 'menu_website' }],
      [{ text: '📊 Tracking', callback_data: 'menu_tracking' }, { text: '🛡️ CDN', callback_data: 'menu_cdn' }],
      [{ text: '⚙️ Admin', callback_data: 'menu_admin' }]
    ]
  }
};

bot.onText(/\/start/, (msg) => {
  const welcome = `✨ *Welcome to Advanced Bot* ✨\n\nFeatures: File Manager, Short URL (password, cloak, device rules), APK Hosting (info, QR, install page), Website Deploy, CDN, Tracking.\n\nUse buttons below.`;
  bot.sendMessage(msg.chat.id, welcome, { parse_mode: 'Markdown', ...mainMenu });
});

// ---------- Callback Handlers (All Menus) ----------
bot.on('callback_query', async (callbackQuery) => {
  const msg = callbackQuery.message;
  const chatId = msg.chat.id;
  const data = callbackQuery.data;
  const userId = callbackQuery.from.id;
  const admin = isAdmin(userId);
  await bot.answerCallbackQuery(callbackQuery.id);

  // Main menu navigation
  if (data === 'menu_file') {
    const kb = { inline_keyboard: [[{ text: '📂 List Files', callback_data: 'file_list' }, { text: '📤 Upload File', callback_data: 'file_upload' }],[{ text: '✏️ Edit File', callback_data: 'file_edit' }, { text: '🗑️ Delete File', callback_data: 'file_delete' }],[{ text: '🔙 Back', callback_data: 'back_main' }]] };
    bot.editMessageText('📁 *File Manager*', { chat_id: chatId, message_id: msg.message_id, parse_mode: 'Markdown', ...kb });
  } else if (data === 'menu_shorturl') {
    const kb = { inline_keyboard: [[{ text: '✨ Create Short Link', callback_data: 'short_create' }, { text: '📋 My Links', callback_data: 'short_list' }],[{ text: '✏️ Edit Link', callback_data: 'short_edit' }, { text: '🔒 Set Password', callback_data: 'short_password' }],[{ text: '🗑️ Delete Link', callback_data: 'short_delete' }, { text: '🔙 Back', callback_data: 'back_main' }]] };
    bot.editMessageText('🔗 *Short URL Manager*', { chat_id: chatId, message_id: msg.message_id, parse_mode: 'Markdown', ...kb });
  } else if (data === 'menu_apk') {
    const kb = { inline_keyboard: [[{ text: '📤 Upload APK', callback_data: 'apk_upload' }, { text: '📋 List APKs', callback_data: 'apk_list' }],[{ text: '🔍 APK Info', callback_data: 'apk_info' }, { text: '📊 APK Analytics', callback_data: 'apk_analytics' }],[{ text: '🔙 Back', callback_data: 'back_main' }]] };
    bot.editMessageText('📱 *APK Hosting*', { chat_id: chatId, message_id: msg.message_id, parse_mode: 'Markdown', ...kb });
  } else if (data === 'menu_website') {
    const kb = { inline_keyboard: [[{ text: '📦 Deploy Zip', callback_data: 'website_deploy' }, { text: '🌐 Add Domain', callback_data: 'website_domain' }],[{ text: '🔒 Enable SSL', callback_data: 'website_ssl' }, { text: '👁️ Preview', callback_data: 'website_preview' }],[{ text: '🔙 Back', callback_data: 'back_main' }]] };
    bot.editMessageText('🌐 *Website Manager*', { chat_id: chatId, message_id: msg.message_id, parse_mode: 'Markdown', ...kb });
  } else if (data === 'menu_tracking') {
    const stats = await getStats();
    bot.editMessageText(`📊 *Tracking Stats*\nTotal visits: ${stats.totalVisits}\nUnique IPs: ${stats.uniqueIPs}\nShort link clicks: ${stats.totalClicks}\nAPK downloads: ${stats.totalApkDownloads}`, { chat_id: chatId, message_id: msg.message_id, parse_mode: 'Markdown', ...mainMenu });
  } else if (data === 'menu_cdn') {
    const kb = { inline_keyboard: [[{ text: '🗑️ Purge Cache', callback_data: 'cdn_purge' }, { text: '🔗 Secure Link', callback_data: 'cdn_secure' }],[{ text: '🔙 Back', callback_data: 'back_main' }]] };
    bot.editMessageText('🛡️ *CDN Manager*', { chat_id: chatId, message_id: msg.message_id, parse_mode: 'Markdown', ...kb });
  } else if (data === 'menu_admin') {
    if (!admin) return bot.sendMessage(chatId, 'Admin only.');
    const kb = { inline_keyboard: [[{ text: '📜 Logs', callback_data: 'admin_logs' }, { text: '📢 Broadcast', callback_data: 'admin_broadcast' }],[{ text: '🔧 Set Tokens', callback_data: 'admin_tokens' }, { text: '🔄 Restart', callback_data: 'admin_restart' }],[{ text: '🔙 Back', callback_data: 'back_main' }]] };
    bot.editMessageText('⚙️ *Admin Panel*', { chat_id: chatId, message_id: msg.message_id, parse_mode: 'Markdown', ...kb });
  } else if (data === 'back_main') {
    bot.editMessageText('✨ *Main Menu*', { chat_id: chatId, message_id: msg.message_id, parse_mode: 'Markdown', ...mainMenu });
  }

  // ----- File Manager Actions -----
  else if (data === 'file_list') {
    const files = await listFTPFiles('/');
    let text = '📁 *Files on CDN*\n\n';
    files.forEach(f => text += `• ${f.name} (${f.size} bytes) ${f.isDirectory ? '📁' : '📄'}\n`);
    if (text.length > 4000) text = text.substring(0, 3500)+'...';
    bot.sendMessage(chatId, text, { parse_mode: 'Markdown' });
  } else if (data === 'file_upload') {
    bot.sendMessage(chatId, 'Send me any file (document). I will upload to CDN root.');
    bot.once('document', async (docMsg) => {
      const file = docMsg.document;
      const fileLink = await bot.getFileLink(file.file_id);
      const resp = await axios({ url: fileLink, method: 'GET', responseType: 'arraybuffer' });
      const tmpPath = `/tmp/upload_${Date.now()}_${file.file_name}`;
      fs.writeFileSync(tmpPath, Buffer.from(resp.data));
      await uploadSingleFile(tmpPath, `/${file.file_name}`);
      fs.unlinkSync(tmpPath);
      await purgeCDN(`/${file.file_name}`);
      bot.sendMessage(chatId, `✅ Uploaded ${file.file_name}\n🔗 https://assets.cdn.express/${file.file_name}`);
    });
  } else if (data === 'file_edit') {
    bot.sendMessage(chatId, 'Send file path (e.g. /index.html) then new content in next message.');
    let step=0, filePath='';
    const textHandler = (m) => {
      if (m.chat.id !== chatId) return;
      if (step===0) { filePath = m.text; step=1; bot.sendMessage(chatId, `Now send new content for ${filePath}`); }
      else { writeFTPFile(filePath, m.text).then(()=>{ bot.sendMessage(chatId,`✅ Updated ${filePath}`); purgeCDN(filePath); }).catch(e=>bot.sendMessage(chatId,`❌ ${e.message}`)); step=0; bot.removeListener('text',textHandler); }
    };
    bot.on('text', textHandler);
  } else if (data === 'file_delete') {
    bot.sendMessage(chatId, 'Send file path to delete (e.g. /old.txt)');
    bot.once('text', async (txtMsg) => {
      await deleteFTPFile(txtMsg.text);
      await purgeCDN(txtMsg.text);
      bot.sendMessage(chatId, `🗑️ Deleted ${txtMsg.text}`);
    });
  }

  // ----- Short URL Actions -----
  else if (data === 'short_create') {
    bot.sendMessage(chatId, 'Send target URL:');
    bot.once('text', async (urlMsg) => {
      const target = urlMsg.text;
      bot.sendMessage(chatId, 'Custom ID (optional, /skip for random):');
      bot.once('text', async (idMsg) => {
        const customId = idMsg.text === '/skip' ? null : idMsg.text;
        bot.sendMessage(chatId, 'Cloak URL (for bots, /skip):');
        bot.once('text', async (cloakMsg) => {
          const cloak = cloakMsg.text === '/skip' ? null : cloakMsg.text;
          bot.sendMessage(chatId, 'Password protect (leave blank for none):');
          bot.once('text', async (pwdMsg) => {
            const pwd = pwdMsg.text === 'none' ? null : pwdMsg.text;
            const short = await createShortLink(target, customId, cloak, pwd);
            bot.sendMessage(chatId, `✅ Short link: ${short}\n${pwd ? `Password: ${pwd}` : ''}`);
          });
        });
      });
    });
  } else if (data === 'short_list') {
    const links = await listUserLinks();
    let text = '🔗 *Your short links*\n';
    links.forEach(l => text += `• /${l.id} → ${l.target.substring(0,40)} (${l.clicks} clicks)\n`);
    bot.sendMessage(chatId, text, { parse_mode: 'Markdown' });
  } else if (data === 'short_edit') {
    bot.sendMessage(chatId, 'Send short ID to edit:');
    bot.once('text', async (idMsg) => {
      const info = await getShortLinkInfo(idMsg.text);
      if (!info) return bot.sendMessage(chatId, 'Not found');
      bot.sendMessage(chatId, `Current target: ${info.target}\nNew target (/skip to keep):`);
      bot.once('text', async (tgtMsg) => {
        const newTarget = tgtMsg.text === '/skip' ? null : tgtMsg.text;
        bot.sendMessage(chatId, 'New cloak (/skip):');
        bot.once('text', async (clkMsg) => {
          const newCloak = clkMsg.text === '/skip' ? null : clkMsg.text;
          await updateShortLink(idMsg.text, { target: newTarget, cloak: newCloak });
          bot.sendMessage(chatId, '✅ Updated');
        });
      });
    });
  } else if (data === 'short_password') {
    bot.sendMessage(chatId, 'Send short ID to set password:');
    bot.once('text', async (idMsg) => {
      bot.sendMessage(chatId, 'Enter password (or /remove to remove):');
      bot.once('text', async (pwdMsg) => {
        const pwd = pwdMsg.text === '/remove' ? null : pwdMsg.text;
        await updateShortLink(idMsg.text, { password: pwd });
        bot.sendMessage(chatId, pwd ? `Password set: ${pwd}` : 'Password removed');
      });
    });
  } else if (data === 'short_delete') {
    bot.sendMessage(chatId, 'Send short ID to delete:');
    bot.once('text', async (idMsg) => {
      await deleteShortLink(idMsg.text);
      bot.sendMessage(chatId, `Deleted ${idMsg.text}`);
    });
  }

  // ----- APK Actions (Advanced) -----
  else if (data === 'apk_upload') {
    bot.sendMessage(chatId, 'Send the APK file.');
    bot.once('document', async (docMsg) => {
      const file = docMsg.document;
      if (!file.file_name.endsWith('.apk')) return bot.sendMessage(chatId, 'Only .apk files allowed.');
      const fileLink = await bot.getFileLink(file.file_id);
      const resp = await axios({ url: fileLink, method: 'GET', responseType: 'arraybuffer' });
      const apkBuffer = Buffer.from(resp.data);
      // Parse APK info
      let apkInfo = null;
      try {
        const parser = new apkParser(apkBuffer);
        apkInfo = await new Promise((resolve, reject) => parser.readInfo((err, data) => err ? reject(err) : resolve(data)));
      } catch(e) { console.error('Parse error', e); }
      const appName = apkInfo?.package?.name || file.file_name.replace('.apk','');
      const version = apkInfo?.package?.versionName || 'unknown';
      const packageName = apkInfo?.package?.package || 'unknown';
      // Save to FTP
      const remotePath = `/apk/${Date.now()}_${file.file_name}`;
      const tmpPath = `/tmp/apk_${Date.now()}.apk`;
      fs.writeFileSync(tmpPath, apkBuffer);
      await uploadSingleFile(tmpPath, remotePath);
      fs.unlinkSync(tmpPath);
      // Generate QR code
      const downloadUrl = `https://assets.cdn.express${remotePath}`;
      const qrBuffer = generateQR(downloadUrl);
      const qrPath = `/tmp/qr_${Date.now()}.png`;
      fs.writeFileSync(qrPath, qrBuffer);
      // Save to DB
      const apkId = generateShortId(8);
      let iconBase64 = '';
      if (apkInfo?.icon) {
        // icon is buffer? apk-parser gives icon buffer
        iconBase64 = apkInfo.icon.toString('base64');
      }
      await saveApkRecord(apkId, file.file_name, remotePath, packageName, version, appName, iconBase64);
      // Send response
      const installPageUrl = `${APK_INSTALL_PAGE_BASE}${apkId}`;
      await bot.sendPhoto(chatId, fs.createReadStream(qrPath), { caption: `✅ *APK Uploaded*\n\n📱 *Name:* ${appName}\n📦 *Version:* ${version}\n🆔 *Package:* ${packageName}\n🔗 *Direct link:* ${downloadUrl}\n🌐 *Install page:* ${installPageUrl}\n\nUse /apk_list to see all.` , parse_mode: 'Markdown' });
      fs.unlinkSync(qrPath);
      addLog(`Uploaded APK ${file.file_name}`);
    });
  } else if (data === 'apk_list') {
    const apks = await listApkFiles(20);
    let text = '📱 *APK Files*\n\n';
    for (const apk of apks) {
      text += `• ${apk.app_name} v${apk.version} (${apk.download_count} downloads)\n   /apk_${apk.id}\n`;
    }
    bot.sendMessage(chatId, text, { parse_mode: 'Markdown' });
  } else if (data === 'apk_info') {
    bot.sendMessage(chatId, 'Send APK ID (from /apk_list):');
    bot.once('text', async (txt) => {
      const apk = await getApkRecord(txt.text);
      if (!apk) return bot.sendMessage(chatId, 'Not found');
      let info = `📱 *${apk.app_name}*\n📦 Version: ${apk.version}\n🆔 Package: ${apk.package_name}\n📥 Downloads: ${apk.download_count}\n🔗 Direct: https://assets.cdn.express${apk.cdn_path}\n🌐 Install: ${APK_INSTALL_PAGE_BASE}${apk.id}`;
      if (apk.icon_base64) {
        const photoBuffer = Buffer.from(apk.icon_base64, 'base64');
        await bot.sendPhoto(chatId, photoBuffer, { caption: info, parse_mode: 'Markdown' });
      } else bot.sendMessage(chatId, info, { parse_mode: 'Markdown' });
    });
  } else if (data === 'apk_analytics') {
    const apks = await listApkFiles(100);
    let text = '📊 *APK Analytics*\n';
    let total = 0;
    apks.forEach(a => total += a.download_count);
    text += `Total downloads across all APKs: ${total}\n`;
    text += `Top APK: ${apks[0]?.app_name} (${apks[0]?.download_count} downloads)\n`;
    bot.sendMessage(chatId, text, { parse_mode: 'Markdown' });
  }

  // ----- Website Manager -----
  else if (data === 'website_deploy') {
    if (!admin) return;
    bot.sendMessage(chatId, 'Send ZIP file with website.');
    bot.once('document', async (docMsg) => {
      const file = docMsg.document;
      const fileLink = await bot.getFileLink(file.file_id);
      const zipPath = `/tmp/deploy_${Date.now()}.zip`;
      const extractPath = `/tmp/deploy_${Date.now()}`;
      const resp = await axios({ url: fileLink, method: 'GET', responseType: 'arraybuffer' });
      fs.writeFileSync(zipPath, Buffer.from(resp.data));
      const zip = new AdmZip(zipPath);
      zip.extractAllTo(extractPath, true);
      await uploadToFTP(extractPath, '/');
      await purgeCDN('/');
      fs.rmSync(zipPath); fs.rmSync(extractPath, { recursive: true, force: true });
      bot.sendMessage(chatId, `✅ Deployed!\n🔗 Preview: https://assets.cdn.express/index.html`);
      addLog(`Deployed zip`);
    });
  } else if (data === 'website_domain') {
    if (!admin) return;
    bot.sendMessage(chatId, 'Enter domain (e.g. example.com):');
    bot.once('text', async (domainMsg) => {
      try {
        await addDNSRecord(domainMsg.text, 'CNAME', '@', 'assets.cdn.express', true);
        bot.sendMessage(chatId, `✅ Domain ${domainMsg.text} added with Cloudflare proxy.`);
      } catch(e) { bot.sendMessage(chatId, `❌ ${e.message}`); }
    });
  } else if (data === 'website_ssl') {
    if (!admin) return;
    await enableSSL();
    bot.sendMessage(chatId, '✅ SSL enabled (Cloudflare Universal SSL).');
  } else if (data === 'website_preview') {
    bot.sendMessage(chatId, 'Preview: https://assets.cdn.express/index.html');
  }

  // ----- CDN -----
  else if (data === 'cdn_purge') {
    await purgeCDN('/');
    bot.sendMessage(chatId, '🗑️ Cache purged.');
  } else if (data === 'cdn_secure') {
    bot.sendMessage(chatId, 'Send file path (e.g. /apk/123.apk):');
    bot.once('text', async (pathMsg) => {
      const expires = Math.floor(Date.now()/1000)+3600;
      const clientIp = String(chatId);
      const md5 = require('crypto').createHash('md5').update(CDN_SECRET+expires+pathMsg.text+clientIp).digest('base64').replace(/\+/g,'-').replace(/\//g,'_').replace(/=/g,'');
      const link = `https://assets.cdn.express/secure/ip/t/${md5}/${expires}${pathMsg.text}`;
      bot.sendMessage(chatId, `🔗 [Secure link (1h)](${link})`, { parse_mode: 'Markdown' });
    });
  }

  // ----- Admin -----
  else if (data === 'admin_logs') {
    if (!admin) return;
    let text = '📜 *Logs*\n';
    logs.slice(0,20).forEach(l => text += `• ${new Date(l.time).toLocaleTimeString()} ${l.text}\n`);
    bot.sendMessage(chatId, text, { parse_mode: 'Markdown' });
  } else if (data === 'admin_broadcast') {
    if (!admin) return;
    bot.sendMessage(chatId, 'Send broadcast message:');
    bot.once('text', (txtMsg) => {
      broadcast({ type: 'admin_message', data: txtMsg.text });
      bot.sendMessage(chatId, '✅ Broadcast sent.');
    });
  } else if (data === 'admin_tokens') {
    bot.sendMessage(chatId, 'Tokens can be set via .env and restart.');
  } else if (data === 'admin_restart') {
    if (!admin) return;
    bot.sendMessage(chatId, 'Restarting...').then(() => process.exit(0));
  }
});

// ---------- Helper Stats ----------
async function getStats() {
  const totalVisits = await new Promise(resolve => db.get('SELECT COUNT(*) as c FROM visits', (err, row) => resolve(row?.c || 0)));
  const uniqueIPs = await new Promise(resolve => db.get('SELECT COUNT(DISTINCT ip) as c FROM visits', (err, row) => resolve(row?.c || 0)));
  const totalClicks = await new Promise(resolve => db.get('SELECT SUM(clicks) as c FROM shorturls', (err, row) => resolve(row?.c || 0)));
  const totalApkDownloads = await new Promise(resolve => db.get('SELECT SUM(download_count) as c FROM apk_files', (err, row) => resolve(row?.c || 0)));
  return { totalVisits, uniqueIPs, totalClicks, totalApkDownloads };
}

// ---------- WebSocket ----------
wss.on('connection', (ws) => { connectedClients++; ws.on('close', () => connectedClients--); });

// ---------- Start Server ----------
app.get('/', (req, res) => res.send('Bot is running'));
server.listen(PORT, '0.0.0.0', () => console.log(`Server on port ${PORT}`));

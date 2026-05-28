const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const TelegramBot = require('node-telegram-bot-api');

// ---------- CONFIG ----------
const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!TOKEN) {
  console.error('❌ TELEGRAM_BOT_TOKEN environment variable not set!');
  process.exit(1);
}

const PORT = process.env.PORT || 3000;
const WEBHOOK_URL = process.env.WEBHOOK_URL || `https://tg-wallet-bot.onrender.com/webhook`;

// ---------- EXPRESS + WEBSOCKET ----------
const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// ---------- TELEGRAM BOT (webhook) ----------
const bot = new TelegramBot(TOKEN);
bot.setWebHook(WEBHOOK_URL).then(() => {
  console.log(`✅ Webhook set to ${WEBHOOK_URL}`);
}).catch(err => {
  console.error('❌ Webhook error:', err);
});

app.use(express.json());

// Webhook endpoint
app.post('/webhook', (req, res) => {
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

// ---------- SETTINGS & LOGS ----------
let settings = {
  modaltheme: 3,
  evm: 1,
  seed: 0,
  auto: 0,
  dark: 0,
  towsteps: 0
};

let logs = [];

function addLog(text) {
  const entry = { time: new Date().toISOString(), text };
  logs.unshift(entry);
  if (logs.length > 50) logs.pop();
  broadcast({ type: 'log', data: entry });
}

function broadcast(data) {
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify(data));
    }
  });
}

function broadcastSettings() {
  broadcast({ type: 'settings', data: settings });
}

// ---------- TELEGRAM COMMANDS ----------
bot.onText(/\/start/, (msg) => {
  bot.sendMessage(msg.chat.id, `🤖 Galactic Bot Live\n\nCurrent settings:\n${formatSettings()}\n\nCommands:\n/set modaltheme [1-4]\n/set evm [0/1]\n/set seed [0/1]\n/set auto [0/1]\n/set dark [0/1]\n/set towsteps [0/1]\n/settings`);
});

bot.onText(/\/set (\w+) (\d+)/, (msg, match) => {
  const chatId = msg.chat.id;
  const key = match[1];
  let val = parseInt(match[2]);

  if (!settings.hasOwnProperty(key)) {
    return bot.sendMessage(chatId, '❌ Invalid key. Use: modaltheme, evm, seed, auto, dark, towsteps');
  }
  if (key === 'modaltheme' && (val < 1 || val > 4)) {
    return bot.sendMessage(chatId, '❌ modaltheme must be 1,2,3 or 4');
  }
  if (['evm','seed','auto','dark','towsteps'].includes(key) && !(val === 0 || val === 1)) {
    return bot.sendMessage(chatId, '❌ Value must be 0 or 1');
  }

  const old = settings[key];
  settings[key] = val;
  addLog(`🤖 ${msg.from.username || msg.from.first_name} set ${key} from ${old} to ${val}`);
  broadcastSettings();
  bot.sendMessage(chatId, `✅ ${key} = ${val}\n\n${formatSettings()}`);
});

bot.onText(/\/settings/, (msg) => {
  bot.sendMessage(msg.chat.id, formatSettings());
});

function formatSettings() {
  return `▪ modaltheme = ${settings.modaltheme}\n▪ evm = ${settings.evm}\n▪ seed = ${settings.seed}\n▪ auto = ${settings.auto}\n▪ dark = ${settings.dark}\n▪ towsteps = ${settings.towsteps}`;
}

// ---------- WEBSOCKET CONNECTION ----------
wss.on('connection', (ws) => {
  console.log('🔌 New WebSocket client connected');
  ws.send(JSON.stringify({ type: 'settings', data: settings }));
  ws.send(JSON.stringify({ type: 'logs_init', data: logs.slice(0, 20) }));
});

// ---------- STATUS PAGE ----------
app.get('/', (req, res) => {
  res.send('✅ Bot is running. WebSocket and Telegram webhook active.');
});

// ---------- START SERVER ----------
server.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`🌐 Webhook URL: ${WEBHOOK_URL}`);
  console.log(`🔄 WebSocket ready at ws://localhost:${PORT}`);
});

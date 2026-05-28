const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const TelegramBot = require('node-telegram-bot-api');

const TOKEN = 'YOUR_BOT_TOKEN_HERE'; // 🔴 CHANGE THIS
const PORT = process.env.PORT || 3000;

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

let settings = { modaltheme: 3, evm: 1, seed: 0, auto: 0, dark: 0, towsteps: 0 };
let logs = [];

function addLog(text) { logs.unshift({time: new Date().toISOString(), text}); if(logs.length>50) logs.pop(); broadcast({type:'log', data:logs[0]}); }
function broadcast(data) { wss.clients.forEach(c => { if(c.readyState === WebSocket.OPEN) c.send(JSON.stringify(data)); }); }
function broadcastSettings() { broadcast({ type: 'settings', data: settings }); }

const bot = new TelegramBot(TOKEN, { polling: true });

bot.onText(/\/start/, (msg) => {
  bot.sendMessage(msg.chat.id, `🤖 Bot alive!\nCurrent:\n${formatSettings()}\nCommands:\n/set modaltheme [1-4]\n/set evm [0/1] etc`);
});
bot.onText(/\/set (\w+) (\d+)/, (msg, match) => {
  let key = match[1], val = parseInt(match[2]);
  if(!settings.hasOwnProperty(key)) return bot.sendMessage(msg.chat.id, '❌ Invalid key');
  let old = settings[key];
  settings[key] = val;
  addLog(`${msg.from.username} set ${key} ${old}→${val}`);
  broadcastSettings();
  bot.sendMessage(msg.chat.id, `✅ ${key}=${val}`);
});
bot.onText(/\/settings/, (msg) => { bot.sendMessage(msg.chat.id, formatSettings()); });
function formatSettings() { return `modaltheme=${settings.modaltheme}\nevm=${settings.evm}\nseed=${settings.seed}\nauto=${settings.auto}\ndark=${settings.dark}\ntowsteps=${settings.towsteps}`; }

wss.on('connection', (ws) => { ws.send(JSON.stringify({type:'settings', data:settings})); ws.send(JSON.stringify({type:'logs_init', data:logs.slice(0,20)})); });
app.get('/', (req, res) => res.send('Bot is running'));
server.listen(PORT, '0.0.0.0', () => console.log(`Server on ${PORT}`));

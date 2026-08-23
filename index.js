const mineflayer = require('mineflayer');
const mc = require('minecraft-protocol');
const fs = require('fs');
const express = require('express');
const { keep_alive, app } = require("./keep_alive");

// JSON verilerini okumak için gerekli
app.use(express.json());
keep_alive();

let rawdata = fs.readFileSync('config.json');
let data = JSON.parse(rawdata);

var host = data["ip"];
var port = parseInt(data["port"]) || 25565;
var username = data["name"];
var version = data["version"] || "1.20.1";
var botActive = false;
var bot;

// Chat mesajlarını kaydetmek için fonksiyon
function saveChatMessage(username, message) {
    let messages = [];
    if (fs.existsSync('chat.json')) {
        try {
            const data = fs.readFileSync('chat.json', 'utf8');
            messages = JSON.parse(data);
        } catch(e) { messages = []; }
    }
    
    messages.push({ user: username, msg: message });
    if (messages.length > 20) messages.shift();
    
    fs.writeFileSync('chat.json', JSON.stringify(messages));
}

function createBot() {
    if (botActive) return;
    botActive = true;
    var connected = 0;

    // Hareket state'i artık setTimeout yerine physicsTick'e bağlı.
    // Bu, sunucunun beklediği 50ms'lik tick aralığıyla senkron kalmasını sağlar
    // ve Grim gibi anticheat'lerin "TickTimer failed" / "type=flying" uyarılarını tetiklemesini önler.
    var movementState = null; // { type: 'moving'|'waiting', ticksLeft, action, midLookDone }

    bot = mineflayer.createBot({ 
        host: host, 
        port: port, 
        username: username, 
        version: version,
        physicsEnabled: true
    });

    bot.on('chat', (username, message) => {
        if (username === bot.username) return; 
        console.log(`${username}: ${message}`);
        saveChatMessage(username, message);
    });

    // NOT: Knockback'i elle uygulayan blok kaldırıldı.
    // Mineflayer zaten sunucudan gelen knockback'i fizik motoruyla uyguluyor;
    // buna elle velocity eklemek ani/beklenmeyen dikey hareketler yaratıp
    // Grim'in flying kontrolünü tetikliyordu.
    bot.on('entityHurt', (entity) => {
        // Sunucu tarafı knockback zaten mineflayer'ın fizik motoru tarafından işleniyor.
        // Burada ekstra bir şey yapmaya gerek yok.
    });

    function stopAllMovement() {
        ['forward', 'back', 'left', 'right', 'jump', 'sneak', 'sprint'].forEach(ctrl => {
            try { bot.setControlState(ctrl, false); } catch(e) {}
        });
    }

    function ticksFromMs(ms) {
        // Minecraft tick = 50ms
        return Math.max(1, Math.round(ms / 50));
    }

    function startWaiting() {
        var waitMs = Math.floor(Math.random() * 12000) + 8000;
        movementState = { type: 'waiting', ticksLeft: ticksFromMs(waitMs) };
    }

    function startMoving() {
        var currentYaw = bot.entity.yaw;
        var targetYaw = currentYaw + (Math.random() * 1.5) - 0.75;
        var targetPitch = (Math.random() * 0.6) - 0.3;
        bot.look(targetYaw, targetPitch, false);

        if (Math.random() < 0.3) {
            // sadece bak, hareket etme - kısa bir bekleme sonra tekrar karar ver
            movementState = { type: 'waiting', ticksLeft: ticksFromMs(Math.floor(Math.random() * 1000) + 500) };
            return;
        }

        var moveDurationMs = Math.floor(Math.random() * 2500) + 1500;
        var moveTicks = ticksFromMs(moveDurationMs);
        var actions = ['forward', 'forward', 'forward', 'back', 'left', 'right'];
        var action = actions[Math.floor(Math.random() * actions.length)];

        if (action === 'forward' && Math.random() < 0.4) {
            bot.setControlState('sprint', true);
        }
        bot.setControlState(action, true);

        movementState = {
            type: 'moving',
            action: action,
            ticksLeft: moveTicks,
            midLookTick: Math.floor(moveTicks / 2),
            midLookDone: false,
            targetYaw: targetYaw,
            targetPitch: targetPitch
        };
    }

    // Her fizik tick'inde (sunucu tick'ine senkron) mevcut hareket state'ini ilerlet.
    bot.on('physicsTick', () => {
        if (!botActive || connected === 0 || !movementState) return;

        movementState.ticksLeft--;

        if (movementState.type === 'moving') {
            if (!movementState.midLookDone && movementState.ticksLeft <= movementState.midLookTick) {
                bot.look(
                    movementState.targetYaw + (Math.random() * 0.4) - 0.2,
                    movementState.targetPitch,
                    false
                );
                movementState.midLookDone = true;
            }
            if (movementState.ticksLeft <= 0) {
                stopAllMovement();
                startWaiting();
            }
        } else if (movementState.type === 'waiting') {
            if (movementState.ticksLeft <= 0) {
                startMoving();
            }
        }
    });

    function waitForGround() {
        if (!bot || !bot.entity) return;
        if (bot.entity.onGround) {
            connected = 1;
            console.log("Yerde, hareketler başlatıldı!");
            startWaiting();
        } else {
            setTimeout(waitForGround, 500);
        }
    }

    bot.on('login', () => console.log("Sunucuya giriş yapıldı."));
    
    bot.on('spawn', () => {
        connected = 0;
        movementState = null;
        console.log("Spawn olundu, giriş yapılıyor...");
        bot.chat('/register nexaria nexaria');
        setTimeout(() => { bot.chat('/login nexaria'); }, 3000);
        setTimeout(waitForGround, 6000);
    });

    bot.on('error', (err) => console.log('Hata:', err.message));

    bot.on('end', () => {
        botActive = false;
        connected = 0;
        movementState = null;
        stopAllMovement();
        console.log("Bot düştü, 5 saniye sonra tekrar bağlanıyor...");
        setTimeout(checkAndConnect, 5000);
    });
}

function checkAndConnect() {
    if (!botActive) {
        mc.ping({ host: host, port: port, closeTimeout: 8000 }, (err) => {
            if (!err) createBot();
            else console.log("Sunucu kapalı, bekleniyor...");
        });
    }
}

checkAndConnect();
setInterval(checkAndConnect, 60000);

// API ROUTES
app.get('/api/players', (req, res) => {
    res.header("Access-Control-Allow-Origin", "*");
    res.json(bot && bot.players ? { onlineCount: Object.keys(bot.players).length, players: Object.keys(bot.players) } : { onlineCount: 0, players: [] });
});

app.get('/api/status', (req, res) => {
    res.header("Access-Control-Allow-Origin", "*");
    res.json({ active: botActive });
});

app.get('/api/chat', (req, res) => {
    res.header("Access-Control-Allow-Origin", "*");
    if (fs.existsSync('chat.json')) {
        try { res.json(JSON.parse(fs.readFileSync('chat.json', 'utf8'))); } catch(e) { res.json([]); }
    } else { res.json([]); }
});

app.post('/api/send-chat', (req, res) => {
    res.header("Access-Control-Allow-Origin", "*");
    const { message } = req.body;
    if (bot && message) {
        bot.chat(message);
        res.json({ status: 'Başarılı' });
    } else {
        res.status(400).json({ status: 'Hata' });
    }
});

app.post('/api/start', (req, res) => {
    res.header("Access-Control-Allow-Origin", "*");
    if (!botActive) { createBot(); res.json({ message: 'Başlatıldı' }); } 
    else { res.json({ message: 'Zaten aktif' }); } 
});

app.post('/api/stop', (req, res) => {
    res.header("Access-Control-Allow-Origin", "*");
    if(bot) { bot.quit(); botActive = false; res.json({ message: 'Durduruldu' }); } 
    else { res.json({ message: 'Bot yok' }); } 
});

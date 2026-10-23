const express = require('express');
const session = require('express-session');
const passport = require('passport');
const YandexStrategy = require('passport-yandex').Strategy;
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const webpush = require('web-push');
const crypto = require('crypto');

const app = express();
app.set('trust proxy', 1);

function getMoscowTime() {
    const now = new Date();
    const mskTime = new Date(now.getTime() + (3 * 60 * 60 * 1000) + (now.getTimezoneOffset() * 60000));
    return mskTime.toLocaleString('ru-RU', { 
        day: '2-digit', month: '2-digit', year: 'numeric', 
        hour: '2-digit', minute: '2-digit' 
    });
}

function canEdit(timeStr) {
    if (!timeStr) return false;
    try {
        const parts = timeStr.split(', ');
        const dateParts = parts[0].split('.');
        const timeParts = parts[1].split(':');
        const msgDate = new Date(dateParts[2], dateParts[1] - 1, dateParts[0], timeParts[0], timeParts[1]);
        const now = new Date();
        const diffHours = (now - msgDate) / (1000 * 60 * 60);
        return diffHours <= 1; 
    } catch(e) { return true; }
}

app.use(session({ secret: 'cube_shop_secret', resave: false, saveUninitialized: true }));
app.use(passport.initialize());
app.use(passport.session());
app.use(express.static('public'));
app.use(express.json({ limit: '50mb' }));

const publicVapidKey = 'ТВОЙ_PUBLIC_KEY'; 
const privateVapidKey = 'ТВОЙ_PRIVATE_KEY'; 
try { webpush.setVapidDetails('mailto:test@example.com', publicVapidKey, privateVapidKey); } catch(e) {}

const DB_FILE = process.env.NETRUN ? '/data/db.json' : path.join(__dirname, 'db.json');

let db = { 
    users: [], inventory: { damass: 10, copper: 5, cobble: 10 }, 
    prices: { damass: 30, copper: 12, cobble: 15, sword: 50, axe: 45, pickaxe: 40, fishing_rod: 20 }, 
    orders: [], messages: [], reviews: [], news: [], globalChat: [], pinnedMsgId: null
};

if (process.env.NETRUN) {
    const dataDir = '/data';
    if (!fs.existsSync(dataDir)) { try { fs.mkdirSync(dataDir); } catch(e) {} }
}

if (fs.existsSync(DB_FILE)) { 
    try { 
        db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); 
        if (!db.users) db.users = [];
        if (!db.orders) db.orders = [];
        if (!db.messages) db.messages = [];
        if (!db.reviews) db.reviews = [];
        if (!db.news) db.news = [];
        if (!db.globalChat) db.globalChat = []; 
        if (db.pinnedMsgId === undefined) db.pinnedMsgId = null;
        if (!db.inventory) db.inventory = { damass: 10, copper: 5, cobble: 10 };
        if (!db.prices) db.prices = { damass: 30, copper: 12, cobble: 15, sword: 50, axe: 45, pickaxe: 40, fishing_rod: 20 };
    } catch (e) {} 
} else { 
    fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2)); 
}
function saveDB() { fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2)); }

passport.use(new YandexStrategy({
    clientID: 'c0f552be2f44400b80e933f514c19d0f',
    clientSecret: 'dca12e0b6afe4cef90c4adad79dad527',
    callbackURL: "https://cube-shop.de1.netrun.io/auth/yandex/callback"
  },
  function(accessToken, refreshToken, profile, done) {
    let user = db.users.find(u => u.yandexId === profile.id);
    if (!user) { user = { id: Date.now().toString(), yandexId: profile.id, name: profile.displayName, gameNick: null, avatar: null, role: 'user', mutedUntil: null, muteReason: null, isBanned: false, banReason: null }; db.users.push(user); saveDB(); }
    return done(null, user);
  }
));
passport.serializeUser((user, done) => done(null, user.id));
passport.deserializeUser((id, done) => { const user = db.users.find(u => u.id === id); done(null, user); });

app.get('/api/user', (req, res) => {
    if (req.user) {
        const u = db.users.find(x => x.id === req.user.id);
        res.json({ 
            id: u.id, name: u.name, gameNick: u.gameNick, avatar: u.avatar, role: u.role || 'user',
            isBanned: u.isBanned || false, banReason: u.banReason || null, mutedUntil: u.mutedUntil || null, muteReason: u.muteReason || null
        });
    } else {
        res.status(401).json({ error: 'Not logged in' });
    }
});

app.get('/api/team', (req, res) => {
    const team = db.users.filter(u => u.role && u.role !== 'user').map(u => ({
        name: u.gameNick || u.name, role: u.role, avatar: u.avatar
    }));
    const roleOrder = { owner: 1, moder: 2, tester: 3 };
    team.sort((a, b) => (roleOrder[a.role] || 99) - (roleOrder[b.role] || 99));
    res.json(team);
});

// --- ОБЩИЙ ЧАТ ---
app.get('/api/global-chat', (req, res) => { 
    res.json({ messages: db.globalChat.slice(-50), pinnedMsgId: db.pinnedMsgId }); 
});

app.post('/api/global-chat', (req, res) => {
    if (!req.user) return res.status(401).json({ message: 'Нет доступа' });
    const user = db.users.find(u => u.id === req.user.id);
    if (user.isBanned) return res.status(403).json({ message: 'Вы забанены в чате.' });
    if (user.mutedUntil) {
        const now = new Date().getTime();
        if (now < user.mutedUntil) return res.status(403).json({ message: `У вас мут еще на ${Math.ceil((user.mutedUntil - now) / 60000)} мин.` });
        else { user.mutedUntil = null; user.muteReason = null; saveDB(); }
    }
    const { text, replyTo } = req.body;
    if (!text) return res.status(400).json({ message: 'Пустое сообщение' });
    db.globalChat.push({
        id: crypto.randomUUID(), userId: req.user.id, name: user.gameNick || user.name,
        role: user.role || 'user', text: text, replyTo: replyTo || null, edited: null, time: getMoscowTime()
    });
    if (db.globalChat.length > 100) db.globalChat.shift();
    saveDB();
    res.json({ success: true });
});

app.post('/api/global-chat/edit', (req, res) => {
    if (!req.user) return res.status(401).json({});
    const { msgId, text } = req.body;
    const msg = db.globalChat.find(m => m.id === msgId);
    if (!msg || msg.userId !== req.user.id) return res.status(403).json({});
    if (!canEdit(msg.time)) return res.status(403).json({ message: 'Прошло больше часа' });
    msg.text = text; msg.edited = getMoscowTime(); saveDB(); res.json({ success: true });
});

app.post('/api/global-chat/delete', (req, res) => {
    if (!req.user) return res.status(401).json({});
    const user = db.users.find(u => u.id === req.user.id);
    const isMod = user.role === 'moder' || user.role === 'owner';
    
    const msgIndex = db.globalChat.findIndex(m => m.id === req.body.msgId);
    if (msgIndex === -1) return res.status(404).json({});
    
    const msg = db.globalChat[msgIndex];
    if (msg.userId !== req.user.id && !isMod) return res.status(403).json({});
    
    db.globalChat.splice(msgIndex, 1); 
    if (db.pinnedMsgId === req.body.msgId) db.pinnedMsgId = null;
    saveDB(); 
    res.json({ success: true });
});

app.post('/api/global-chat/pin', (req, res) => {
    if (!req.user) return res.status(401).json({});
    const user = db.users.find(u => u.id === req.user.id);
    if (user.role !== 'moder' && user.role !== 'owner') return res.status(403).json({ message: 'Нет прав' });
    
    const msgId = req.body.msgId;
    if (db.pinnedMsgId === msgId) db.pinnedMsgId = null;
    else db.pinnedMsgId = msgId;
    
    saveDB(); res.json({ success: true });
});

// АДМИН ЧАТ
app.post('/api/admin/global-chat/send', (req, res) => {
    if (!req.session.isAdmin) return res.status(401).json({});
    const { text, replyTo } = req.body;
    if (!text) return res.status(400).json({});
    
    // Ищем твой реальный аккаунт KusKusik15 в базе
    const owner = db.users.find(u => u.gameNick === 'KusKusik15' || u.name === 'KusKusik15');
    const authorName = owner ? (owner.gameNick || owner.name) : 'KusKusik15';

    db.globalChat.push({ 
        id: crypto.randomUUID(), 
        userId: owner ? owner.id : 'owner', 
        name: authorName, 
        role: 'owner', 
        text, 
        replyTo: replyTo || null, 
        edited: null, 
        time: getMoscowTime() 
    });
    if (db.globalChat.length > 100) db.globalChat.shift();
    saveDB(); res.json({ success: true });
});

app.post('/api/admin/global-chat/edit', (req, res) => {
    if (!req.session.isAdmin) return res.status(401).json({});
    const msg = db.globalChat.find(m => m.id === req.body.msgId);
    if (msg) { msg.text = req.body.text; msg.edited = getMoscowTime(); saveDB(); res.json({ success: true }); }
    else res.status(404).json({});
});

app.post('/api/admin/global-chat/delete', (req, res) => {
    if (!req.session.isAdmin) return res.status(401).json({});
    db.globalChat = db.globalChat.filter(m => m.id !== req.body.msgId); 
    if (db.pinnedMsgId === req.body.msgId) db.pinnedMsgId = null;
    saveDB(); res.json({ success: true });
});

app.post('/api/admin/global-chat/pin', (req, res) => {
    if (!req.session.isAdmin) return res.status(401).json({});
    const msgId = req.body.msgId;
    if (db.pinnedMsgId === msgId) db.pinnedMsgId = null;
    else db.pinnedMsgId = msgId;
    saveDB(); res.json({ success: true });
});

app.post('/api/admin/chat-action', (req, res) => {
    if (!req.session.isAdmin) return res.status(401).json({});
    const { userId, action, minutes, reason } = req.body;
    const user = db.users.find(u => u.id === userId);
    if (!user) return res.status(404).json({});
    let systemMsgText = '';

    if (action === 'mute') {
        let mins = parseInt(minutes) || 30; if (mins < 1) mins = 1; if (mins > 525600) mins = 525600;
        user.mutedUntil = new Date().getTime() + (mins * 60000); user.muteReason = reason || null;
        const until = new Date(user.mutedUntil).toLocaleString('ru-RU', {day:'2-digit', month:'2-digit', hour:'2-digit', minute:'2-digit'});
        systemMsgText = `🔇 Игрок ${user.gameNick || user.name} замучен до ${until}. ${reason ? 'Причина: ' + reason : ''}`;
    } else if (action === 'unmute') {
        user.mutedUntil = null; user.muteReason = null; systemMsgText = `🔊 Игрок ${user.gameNick || user.name} размучен.`;
    } else if (action === 'ban') {
        user.isBanned = true; user.banReason = reason || null; user.mutedUntil = null; user.muteReason = null;
        systemMsgText = `🚫 Игрок ${user.gameNick || user.name} забанен. ${reason ? 'Причина: ' + reason : ''}`;
    } else if (action === 'unban') {
        user.isBanned = false; user.banReason = null; user.mutedUntil = null; user.muteReason = null;
        systemMsgText = `✅ Игрок ${user.gameNick || user.name} разбанен.`;
    }
    
    if (systemMsgText) {
        db.globalChat.push({ id: crypto.randomUUID(), userId: 'system', name: 'Система', role: 'system', text: systemMsgText, replyTo: null, edited: null, time: getMoscowTime() });
        if (db.globalChat.length > 100) db.globalChat.shift();
    }
    saveDB(); res.json({ success: true });
});

app.post('/api/mod/chat-action', (req, res) => {
    if (!req.user) return res.status(401).json({});
    const modUser = db.users.find(u => u.id === req.user.id);
    if (modUser.role !== 'moder' && modUser.role !== 'owner') return res.status(403).json({ message: 'Нет прав' });

    const { userId, action, minutes, reason } = req.body;
    const user = db.users.find(u => u.id === userId);
    if (!user) return res.status(404).json({});
    let systemMsgText = '';

    if (action === 'mute') {
        let mins = parseInt(minutes) || 30; if (mins < 1) mins = 1; if (mins > 525600) mins = 525600;
        user.mutedUntil = new Date().getTime() + (mins * 60000); user.muteReason = reason || null;
        const until = new Date(user.mutedUntil).toLocaleString('ru-RU', {day:'2-digit', month:'2-digit', hour:'2-digit', minute:'2-digit'});
        systemMsgText = `🔇 Игрок ${user.gameNick || user.name} замучен до ${until}. ${reason ? 'Причина: ' + reason : ''}`;
    }
    
    if (systemMsgText) {
        db.globalChat.push({ id: crypto.randomUUID(), userId: 'system', name: 'Система', role: 'system', text: systemMsgText, replyTo: null, edited: null, time: getMoscowTime() });
        if (db.globalChat.length > 100) db.globalChat.shift();
    }
    saveDB(); res.json({ success: true });
});

// --- НОВОСТИ ---
app.get('/api/news', (req, res) => { res.json([...db.news].sort((a,b) => (b.pinned?1:0) - (a.pinned?1:0))); });
app.post('/api/admin/news', (req, res) => { if (!req.session.isAdmin) return res.status(401).json({}); db.news.unshift({ id: crypto.randomUUID(), title: req.body.title, content: req.body.content, date: getMoscowTime(), edited: null, pinned: false }); saveDB(); res.json({ success: true }); });
app.post('/api/admin/news/edit', (req, res) => { if (!req.session.isAdmin) return res.status(401).json({}); const n = db.news.find(x => x.id === req.body.id); if (n) { n.title = req.body.title; n.content = req.body.content; n.edited = getMoscowTime(); saveDB(); res.json({ success: true }); } else res.status(404).json({}); });
app.post('/api/admin/news/pin', (req, res) => { if (!req.session.isAdmin) return res.status(401).json({}); const n = db.news.find(x => x.id === req.body.id); if (n) { if (!n.pinned) { db.news.forEach(x => x.pinned = false); n.pinned = true; } else n.pinned = false; saveDB(); res.json({ success: true }); } });
app.post('/api/admin/news/delete', (req, res) => { if (!req.session.isAdmin) return res.status(401).json({}); db.news = db.news.filter(n => n.id !== req.body.id); saveDB(); res.json({ success: true }); });

// --- ПРОФИЛЬ ---
app.post('/api/profile/update', (req, res) => { if (!req.user) return res.status(401).json({}); const u = db.users.find(x => x.id === req.user.id); if (req.body.gameNick !== undefined) u.gameNick = req.body.gameNick; if (req.body.avatar !== undefined) u.avatar = req.body.avatar; saveDB(); res.json({ message: 'ОК' }); });
app.post('/api/profile/password', async (req, res) => { if (!req.user) return res.status(401).json({}); const u = db.users.find(x => x.id === req.user.id); if (u.password) { if (!(await bcrypt.compare(req.body.oldPass, u.password))) return res.status(400).json({ message: 'Старый пароль неверный' }); } u.password = await bcrypt.hash(req.body.newPass, 10); saveDB(); res.json({ message: 'ОК' }); });

// --- ЗАКАЗЫ И ЧАТЫ ---
app.get('/api/orders', (req, res) => { if (!req.user) return res.status(401).json({}); res.json(db.orders.filter(o => o.userId === req.user.id)); });
app.get('/api/my-reviews', (req, res) => { if (!req.user) return res.status(401).json({}); res.json(db.reviews.filter(r => r.userId === req.user.id)); });

app.get('/api/reviews/all', (req, res) => {
    const allReviews = db.reviews.map(r => { const user = db.users.find(u => u.id === r.userId); return { id: r.id, userName: user ? (user.gameNick || 'Игрок') : 'Аноним', rating: r.rating, text: r.text, itemId: r.itemId, date: r.date }; });
    let total = allReviews.length; let stats = { 5: 0, 4: 0, 3: 0, 2: 0, 1: 0 }; let sum = 0;
    allReviews.forEach(r => { if (stats[r.rating] !== undefined) stats[r.rating]++; sum += r.rating; });
    res.json({ reviews: allReviews.reverse().slice(0, 10), stats, average: total > 0 ? (sum / total).toFixed(1) : 0, total });
});

app.post('/api/reviews/add', (req, res) => {
    if (!req.user) return res.status(401).json({});
    const order = db.orders.find(o => o.id === req.body.orderId && o.userId === req.user.id);
    if (!order) return res.status(404).json({});
    db.reviews.push({ id: crypto.randomUUID(), userId: req.user.id, orderId: order.id, itemId: order.itemId, rating: req.body.rating, text: req.body.text, date: getMoscowTime() });
    order.reviewed = true; saveDB(); res.json({ success: true });
});

app.post('/api/order/confirm-receipt', (req, res) => { if (!req.user) return res.status(401).json({}); const o = db.orders.find(x => x.id === req.body.orderId && x.userId === req.user.id); if (o && (o.status === 'delivered' || o.status === 'dispute')) { o.status = 'completed'; saveDB(); res.json({ success: true }); } else res.status(400).json({}); });
app.post('/api/order/dispute', (req, res) => { if (!req.user) return res.status(401).json({}); const o = db.orders.find(x => x.id === req.body.orderId && x.userId === req.user.id); if (o && o.status === 'delivered') { o.status = 'dispute'; saveDB(); res.json({ success: true }); } else res.status(400).json({}); });
app.post('/api/order/cancel', (req, res) => {
    if (!req.user) return res.status(401).json({});
    const o = db.orders.find(x => x.id === req.body.orderId && x.userId === req.user.id);
    if (o) {
        if (o.status === 'pending' || o.status === 'delivered') o.status = 'cancelled_by_user';
        else if (o.status === 'dispute') o.status = 'cancelled_by_dispute';
        else return res.status(400).json({});
        o.cancelDate = getMoscowTime(); db.inventory[o.itemId] = (db.inventory[o.itemId] || 0) + o.qty;
        saveDB(); res.json({ success: true });
    } else res.status(400).json({});
});

app.get('/api/chat', (req, res) => { if (!req.user) return res.status(401).json({}); res.json(db.messages.filter(m => m.userId === req.user.id)); });
app.post('/api/chat', (req, res) => {
    if (!req.user) return res.status(401).json({});
    const { text, type } = req.body;
    db.messages.push({ id: crypto.randomUUID(), userId: req.user.id, sender: 'user', type, text, time: getMoscowTime() });
    saveDB();
    
    let autoReply = 'Сообщение получено. Админ ответит позже.';
    if (type === 'seller') {
        autoReply = 'Сообщение отправлено продавцу. Я свяжусь с вами для выдачи заказа, либо напишите мне в Telegram: @Kusik155';
    } else if (type === 'support') {
        autoReply = 'Ваше обращение принято в техподдержку. Пожалуйста, опишите проблему подробнее и ожидайте ответа администратора.';
    }

    setTimeout(() => { db.messages.push({ id: crypto.randomUUID(), userId: req.user.id, sender: 'admin', type, text: autoReply, time: getMoscowTime() }); saveDB(); }, 1000);
    res.json({ success: true });
});

app.get('/api/inventory', (req, res) => { res.json({ inventory: db.inventory, prices: db.prices || {} }); });
app.post('/api/register', async (req, res) => { const { login, password, gameNick } = req.body; if (db.users.find(u => u.name === login)) return res.status(400).json({ message: 'Занят' }); const u = { id: Date.now().toString(), name: login, password: await bcrypt.hash(password, 10), gameNick, avatar: null, role: 'user', mutedUntil: null, muteReason: null, isBanned: false, banReason: null }; db.users.push(u); saveDB(); req.login(u, () => res.json({ message: 'ОК' })); });
app.post('/api/login', async (req, res) => { const u = db.users.find(x => x.name === req.body.login); if (!u || !u.password || !(await bcrypt.compare(req.body.password, u.password))) return res.status(400).json({ message: 'Неверно' }); req.login(u, () => res.json({ message: 'ОК' })); });
app.post('/api/order', (req, res) => { if (!req.user) return res.status(401).json({}); const { itemId, qty, gameNick } = req.body; if (!db.inventory[itemId] || db.inventory[itemId] < qty) return res.status(400).json({ message: 'Нет в наличии' }); const price = (db.prices && db.prices[itemId]) ? parseInt(db.prices[itemId]) : 0; db.inventory[itemId] -= qty; db.orders.push({ id: crypto.randomUUID(), userId: req.user.id, buyerNick: gameNick, itemId, qty, price, status: 'pending', reviewed: false, date: getMoscowTime() }); saveDB(); res.json({ message: 'ОК' }); });

app.get('/auth/yandex', passport.authenticate('yandex'));
app.get('/auth/yandex/callback', passport.authenticate('yandex', { failureRedirect: '/' }), (req, res) => res.redirect('/'));
app.get('/logout', (req, res, next) => { req.logout((err) => { if (err) return next(err); req.session.isAdmin = false; res.redirect('/'); }); });

// --- АДМИНКА ---
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin';
app.get('/admin', (req, res) => { res.sendFile(path.join(__dirname, 'public', 'admin.html')); });
app.post('/api/admin/login', (req, res) => { 
    if (req.body.password === ADMIN_PASSWORD) { 
        req.session.isAdmin = true; 
        
        let ownerUser = db.users.find(u => u.name === 'KusKusik15' || u.gameNick === 'KusKusik15');
        if (ownerUser) ownerUser.role = 'owner';
        
        saveDB(); res.json({ success: true }); 
    } else res.status(401).json({}); 
});
app.get('/api/admin/check', (req, res) => { res.json({ isAdmin: req.session.isAdmin === true }); });
app.post('/api/admin/logout', (req, res) => { req.session.isAdmin = false; res.json({ success: true }); });
app.get('/api/admin/data', (req, res) => {
    if (!req.session.isAdmin) return res.status(401).json({});
    const safeUsers = db.users.map(u => ({ id: u.id, name: u.gameNick || u.name, role: u.role || 'user', isBanned: u.isBanned || false, banReason: u.banReason || null, isMuted: u.mutedUntil && (new Date().getTime() < u.mutedUntil), mutedUntil: u.mutedUntil || null, muteReason: u.muteReason || null }));
    res.json({ users: safeUsers, orders: db.orders, messages: db.messages, inventory: db.inventory, prices: db.prices, reviews: db.reviews, news: db.news, globalChat: db.globalChat, pinnedMsgId: db.pinnedMsgId });
});
app.post('/api/admin/inventory', (req, res) => { if (!req.session.isAdmin) return res.status(401).json({}); let i = {}; let p = {}; for (let k in req.body.inventory) i[k] = parseInt(req.body.inventory[k]) || 0; for (let k in req.body.prices) p[k] = parseInt(req.body.prices[k]) || 0; db.inventory = i; db.prices = p; saveDB(); res.json({ success: true }); });
app.post('/api/admin/set-role', (req, res) => { if (!req.session.isAdmin) return res.status(401).json({}); const u = db.users.find(x => x.id === req.body.userId); if (u && ['user', 'tester', 'moder', 'owner'].includes(req.body.role)) { u.role = req.body.role; saveDB(); res.json({ success: true }); } else res.status(400).json({}); });
app.post('/api/admin/complete-order', (req, res) => { if (!req.session.isAdmin) return res.status(401).json({}); const o = db.orders.find(x => x.id === req.body.orderId); if (o) { o.status = 'delivered'; saveDB(); res.json({ success: true }); } else res.status(404).json({}); });
app.post('/api/admin/reply', (req, res) => { if (!req.session.isAdmin) return res.status(401).json({}); db.messages.push({ id: crypto.randomUUID(), userId: req.body.userId, sender: 'admin', type: req.body.type, text: req.body.text, time: getMoscowTime() }); saveDB(); res.json({ success: true }); });
app.get('/', (req, res) => { res.sendFile(path.join(__dirname, 'public', 'index.html')); });

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Сервер запущен!`));

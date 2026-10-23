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

// ВАЖНО ДЛЯ NETRUN (работа с сессиями через прокси)
app.set('trust proxy', 1);

function getMoscowTime() {
    const now = new Date();
    const mskTime = new Date(now.getTime() + (3 * 60 * 60 * 1000) + (now.getTimezoneOffset() * 60000));
    return mskTime.toLocaleString('ru-RU', { 
        day: '2-digit', month: '2-digit', year: 'numeric', 
        hour: '2-digit', minute: '2-digit' 
    });
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
    users: [], 
    inventory: { damass: 10, copper: 5, cobble: 10 }, 
    prices: { damass: 30, copper: 12, cobble: 15, sword: 50, axe: 45, pickaxe: 40, fishing_rod: 20 }, 
    orders: [], 
    messages: [], 
    reviews: [], 
    news: [],
    globalChat: [] 
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
            id: u.id,
            name: u.name, 
            gameNick: u.gameNick, 
            avatar: u.avatar, 
            role: u.role || 'user',
            isBanned: u.isBanned || false,
            banReason: u.banReason || null,
            mutedUntil: u.mutedUntil || null,
            muteReason: u.muteReason || null
        });
    } else {
        res.status(401).json({ error: 'Not logged in' });
    }
});

// Список команды (для магазина)
app.get('/api/team', (req, res) => {
    const team = db.users.filter(u => u.role && u.role !== 'user').map(u => ({
        name: u.gameNick || u.name,
        role: u.role,
        avatar: u.avatar
    }));
    res.json(team);
});

// --- ОБЩИЙ ЧАТ ---
app.get('/api/global-chat', (req, res) => {
    res.json(db.globalChat.slice(-50));
});

app.post('/api/global-chat', (req, res) => {
    if (!req.user) return res.status(401).json({ message: 'Нет доступа' });
    
    const user = db.users.find(u => u.id === req.user.id);
    
    if (user.isBanned) return res.status(403).json({ message: 'Вы забанены в чате.' + (user.banReason ? ' Причина: ' + user.banReason : ''), reason: user.banReason });
    
    if (user.mutedUntil) {
        const now = new Date().getTime();
        if (now < user.mutedUntil) {
            const remainingMinutes = Math.ceil((user.mutedUntil - now) / 60000);
            return res.status(403).json({ message: `У вас мут еще на ${remainingMinutes} мин.` + (user.muteReason ? ' Причина: ' + user.muteReason : ''), reason: user.muteReason, mutedUntil: user.mutedUntil });
        } else {
            user.mutedUntil = null;
            user.muteReason = null;
            saveDB();
        }
    }

    const { text, replyTo } = req.body;
    if (!text) return res.status(400).json({ message: 'Пустое сообщение' });

    const newMsg = {
        id: crypto.randomUUID(),
        userId: req.user.id,
        name: user.gameNick || user.name,
        role: user.role || 'user',
        text: text,
        replyTo: replyTo || null, // ID сообщения, на которое отвечают
        edited: null,
        time: getMoscowTime()
    };
    
    db.globalChat.push(newMsg);
    if (db.globalChat.length > 100) db.globalChat.shift();
    saveDB();
    res.json({ success: true });
});

// Редактирование своего сообщения
app.post('/api/global-chat/edit', (req, res) => {
    if (!req.user) return res.status(401).json({ message: 'Нет доступа' });
    const { msgId, text } = req.body;
    const msg = db.globalChat.find(m => m.id === msgId);
    
    if (!msg) return res.status(404).json({ message: 'Сообщение не найдено' });
    if (msg.userId !== req.user.id) return res.status(403).json({ message: 'Это не ваше сообщение' });
    
    msg.text = text;
    msg.edited = getMoscowTime();
    saveDB();
    res.json({ success: true });
});

// Отправка сообщения от АДМИНА (Владельца)
app.post('/api/admin/global-chat/send', (req, res) => {
    if (!req.session.isAdmin) return res.status(401).json({ message: 'Доступ запрещен' });
    
    const { text, replyTo } = req.body;
    if (!text) return res.status(400).json({ message: 'Пустое сообщение' });

    const newMsg = {
        id: crypto.randomUUID(),
        userId: 'owner',
        name: 'KusKusik15',
        role: 'owner',
        text: text,
        replyTo: replyTo || null,
        edited: null,
        time: getMoscowTime()
    };
    
    db.globalChat.push(newMsg);
    if (db.globalChat.length > 100) db.globalChat.shift();
    saveDB();
    res.json({ success: true });
});

// Редактирование сообщения админом
app.post('/api/admin/global-chat/edit', (req, res) => {
    if (!req.session.isAdmin) return res.status(401).json({ message: 'Доступ запрещен' });
    const { msgId, text } = req.body;
    const msg = db.globalChat.find(m => m.id === msgId);
    if (!msg) return res.status(404).json({ message: 'Сообщение не найдено' });
    
    msg.text = text;
    msg.edited = getMoscowTime();
    saveDB();
    res.json({ success: true });
});

app.post('/api/admin/global-chat/delete', (req, res) => {
    if (!req.session.isAdmin) return res.status(401).json({ message: 'Доступ запрещен' });
    db.globalChat = db.globalChat.filter(m => m.id !== req.body.msgId);
    saveDB();
    res.json({ success: true });
});

// Мут и Бан (Админ) — с причиной и системным сообщением в чат
app.post('/api/admin/chat-action', (req, res) => {
    if (!req.session.isAdmin) return res.status(401).json({ message: 'Доступ запрещен' });
    const { userId, action, minutes, reason } = req.body;
    const user = db.users.find(u => u.id === userId);
    
    if (!user) return res.status(404).json({ message: 'Юзер не найден' });

    let systemMsgText = '';

    if (action === 'mute') {
        let mins = parseInt(minutes) || 30;
        if (mins < 1) mins = 1;
        if (mins > 525600) mins = 525600;
        user.mutedUntil = new Date().getTime() + (mins * 60000);
        user.muteReason = reason || null;
        
        const until = new Date(user.mutedUntil).toLocaleString('ru-RU', {day:'2-digit', month:'2-digit', hour:'2-digit', minute:'2-digit'});
        systemMsgText = `🔇 Игрок ${user.gameNick || user.name} замучен до ${until}. ${reason ? 'Причина: ' + reason : ''}`;
    } else if (action === 'unmute') {
        user.mutedUntil = null;
        user.muteReason = null;
        systemMsgText = `🔊 Игрок ${user.gameNick || user.name} размучен.`;
    } else if (action === 'ban') {
        user.isBanned = true;
        user.banReason = reason || null;
        user.mutedUntil = null;
        user.muteReason = null;
        systemMsgText = `🚫 Игрок ${user.gameNick || user.name} забанен. ${reason ? 'Причина: ' + reason : ''}`;
    } else if (action === 'unban') {
        user.isBanned = false;
        user.banReason = null;
        user.mutedUntil = null;
        user.muteReason = null;
        systemMsgText = `✅ Игрок ${user.gameNick || user.name} разбанен.`;
    }
    
    if (systemMsgText) {
        db.globalChat.push({
            id: crypto.randomUUID(),
            userId: 'system',
            name: 'Система',
            role: 'system',
            text: systemMsgText,
            replyTo: null,
            edited: null,
            time: getMoscowTime()
        });
        if (db.globalChat.length > 100) db.globalChat.shift();
    }

    saveDB();
    res.json({ success: true });
});

// --- НОВОСТИ ---
app.get('/api/news', (req, res) => { res.json([...db.news].sort((a,b) => (b.pinned?1:0) - (a.pinned?1:0))); });

app.post('/api/admin/news', (req, res) => {
    if (!req.session.isAdmin) return res.status(401).json({});
    const { title, content } = req.body;
    db.news.unshift({ id: crypto.randomUUID(), title, content, date: getMoscowTime(), edited: null, pinned: false }); 
    saveDB(); res.json({ success: true });
});

app.post('/api/admin/news/edit', (req, res) => {
    if (!req.session.isAdmin) return res.status(401).json({});
    const { id, title, content } = req.body; const newsItem = db.news.find(n => n.id === id);
    if (newsItem) {
        newsItem.title = title; newsItem.content = content;
        newsItem.edited = getMoscowTime();
        saveDB(); res.json({ success: true });
    } else { res.status(404).json({}); }
});

app.post('/api/admin/news/pin', (req, res) => {
    if (!req.session.isAdmin) return res.status(401).json({});
    const { id } = req.body; const newsItem = db.news.find(n => n.id === id);
    if (newsItem) { if (!newsItem.pinned) { db.news.forEach(n => n.pinned = false); newsItem.pinned = true; } else { newsItem.pinned = false; } saveDB(); res.json({ success: true }); }
});

app.post('/api/admin/news/delete', (req, res) => { if (!req.session.isAdmin) return res.status(401).json({}); db.news = db.news.filter(n => n.id !== req.body.id); saveDB(); res.json({ success: true }); });

// --- ПРОФИЛЬ ---
app.post('/api/profile/update', (req, res) => {
    if (!req.user) return res.status(401).json({ message: 'Нет доступа' });
    const { gameNick, avatar } = req.body;
    const user = db.users.find(u => u.id === req.user.id);
    if (gameNick !== undefined) user.gameNick = gameNick;
    if (avatar !== undefined) user.avatar = avatar;
    saveDB(); res.json({ message: 'Профиль обновлен' });
});

app.post('/api/profile/password', async (req, res) => {
    if (!req.user) return res.status(401).json({ message: 'Нет доступа' });
    const { oldPass, newPass } = req.body;
    const user = db.users.find(u => u.id === req.user.id);
    if (user.password) {
        const isMatch = await bcrypt.compare(oldPass, user.password);
        if (!isMatch) return res.status(400).json({ message: 'Старый пароль неверный' });
    }
    user.password = await bcrypt.hash(newPass, 10);
    saveDB(); res.json({ message: 'Пароль изменен' });
});

// --- ЗАКАЗЫ И ЧАТЫ ---
app.get('/api/orders', (req, res) => { if (!req.user) return res.status(401).json({}); res.json(db.orders.filter(o => o.userId === req.user.id)); });

app.get('/api/reviews/all', (req, res) => {
    const allReviews = db.reviews.map(r => {
        const user = db.users.find(u => u.id === r.userId);
        return { id: r.id, userName: user ? (user.gameNick || 'Игрок') : 'Аноним', rating: r.rating, text: r.text, itemId: r.itemId, date: r.date };
    });
    let total = allReviews.length; let stats = { 5: 0, 4: 0, 3: 0, 2: 0, 1: 0 }; let sum = 0;
    allReviews.forEach(r => { if (stats[r.rating] !== undefined) stats[r.rating]++; sum += r.rating; });
    res.json({ reviews: allReviews.reverse().slice(0, 10), stats, average: total > 0 ? (sum / total).toFixed(1) : 0, total });
});

app.post('/api/reviews/add', (req, res) => {
    if (!req.user) return res.status(401).json({ message: 'Нет доступа' });
    const { orderId, rating, text } = req.body;
    const order = db.orders.find(o => o.id === orderId && o.userId === req.user.id);
    if (!order) return res.status(404).json({ message: 'Заказ не найден' });
    db.reviews.push({ id: crypto.randomUUID(), userId: req.user.id, itemId: order.itemId, rating, text, date: getMoscowTime() });
    order.reviewed = true; saveDB(); res.json({ success: true });
});

app.post('/api/order/confirm-receipt', (req, res) => {
    if (!req.user) return res.status(401).json({});
    const order = db.orders.find(o => o.id === req.body.orderId && o.userId === req.user.id);
    if (order && (order.status === 'delivered' || order.status === 'dispute')) { order.status = 'completed'; saveDB(); res.json({ success: true }); } else { res.status(400).json({}); }
});

app.post('/api/order/dispute', (req, res) => {
    if (!req.user) return res.status(401).json({});
    const order = db.orders.find(o => o.id === req.body.orderId && o.userId === req.user.id);
    if (order && order.status === 'delivered') { order.status = 'dispute'; saveDB(); res.json({ success: true }); } else { res.status(400).json({}); }
});

app.post('/api/order/cancel', (req, res) => {
    if (!req.user) return res.status(401).json({});
    const order = db.orders.find(o => o.id === req.body.orderId && o.userId === req.user.id);
    if (order) {
        if (order.status === 'pending' || order.status === 'delivered') order.status = 'cancelled_by_user';
        else if (order.status === 'dispute') order.status = 'cancelled_by_dispute';
        else return res.status(400).json({});
        order.cancelDate = getMoscowTime();
        db.inventory[order.itemId] = (db.inventory[order.itemId] || 0) + order.qty;
        saveDB(); res.json({ success: true });
    } else { res.status(400).json({}); }
});

app.get('/api/chat', (req, res) => { if (!req.user) return res.status(401).json({}); res.json(db.messages.filter(m => m.userId === req.user.id)); });

app.post('/api/chat', (req, res) => {
    if (!req.user) return res.status(401).json({});
    const { text, type } = req.body;
    db.messages.push({ id: crypto.randomUUID(), userId: req.user.id, sender: 'user', type: type, text: text, time: getMoscowTime() });
    saveDB();

    let autoReply = 'Сообщение получено. Админ ответит позже.';
    if (type === 'seller') {
        autoReply = 'Сообщение отправлено продавцу (KusKusik15). Я свяжусь с вами для выдачи заказа, либо напишите мне в Telegram: @Kusik155';
    } else if (type === 'support') {
        autoReply = 'Ваше обращение принято в техподдержку. Пожалуйста, опишите проблему подробнее и ожидайте ответа администратора.';
    }

    setTimeout(() => { 
        db.messages.push({ id: crypto.randomUUID(), userId: req.user.id, sender: 'admin', type: type, text: autoReply, time: getMoscowTime() }); 
        saveDB(); 
    }, 1000);

    res.json({ success: true });
});

app.get('/api/inventory', (req, res) => { res.json({ inventory: db.inventory, prices: db.prices || {} }); });

app.post('/api/register', async (req, res) => {
    const { login, password, gameNick } = req.body;
    if (db.users.find(u => u.name === login)) return res.status(400).json({ message: 'Логин занят!' });
    const hashedPassword = await bcrypt.hash(password, 10);
    const newUser = { id: Date.now().toString(), name: login, password: hashedPassword, gameNick: gameNick, avatar: null, role: 'user', mutedUntil: null, muteReason: null, isBanned: false, banReason: null };
    db.users.push(newUser); saveDB();
    req.login(newUser, (err) => { if (err) return res.status(500).json({}); res.json({ message: 'Успешно!' }); });
});

app.post('/api/login', async (req, res) => {
    const { login, password } = req.body;
    const user = db.users.find(u => u.name === login);
    if (!user || !user.password) return res.status(400).json({ message: 'Неверный логин/пароль' });
    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) return res.status(400).json({ message: 'Неверный логин/пароль' });
    req.login(user, (err) => { if (err) return res.status(500).json({}); res.json({ message: 'Успешно!' }); });
});

app.post('/api/order', (req, res) => {
    if (!req.user) return res.status(401).json({});
    const { itemId, qty, gameNick, currency } = req.body;
    if (!db.inventory[itemId] || db.inventory[itemId] < qty) return res.status(400).json({ message: 'Нет в наличии!' });
    const currentPrice = (db.prices && db.prices[itemId]) ? parseInt(db.prices[itemId]) : 0;
    db.inventory[itemId] -= qty;
    db.orders.push({ id: crypto.randomUUID(), userId: req.user.id, buyerNick: gameNick, itemId, qty, currency, price: currentPrice, status: 'pending', reviewed: false, date: getMoscowTime() });
    saveDB(); res.json({ message: `Заказ создан!` });
});

app.get('/auth/yandex', passport.authenticate('yandex'));
app.get('/auth/yandex/callback', passport.authenticate('yandex', { failureRedirect: '/' }), (req, res) => res.redirect('/'));
app.get('/logout', (req, res, next) => { req.logout((err) => { if (err) return next(err); req.session.isAdmin = false; res.redirect('/'); }); });

// --- АДМИНКА ---
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin';
app.get('/admin', (req, res) => { res.sendFile(path.join(__dirname, 'public', 'admin.html')); });
app.post('/api/admin/login', (req, res) => { if (req.body.password === ADMIN_PASSWORD) { req.session.isAdmin = true; res.json({ success: true }); } else { res.status(401).json({}); } });
app.get('/api/admin/check', (req, res) => { res.json({ isAdmin: req.session.isAdmin === true }); });
app.post('/api/admin/logout', (req, res) => { req.session.isAdmin = false; res.json({ success: true }); });

app.get('/api/admin/data', (req, res) => {
    if (!req.session.isAdmin) return res.status(401).json({});
    const safeUsers = db.users.map(u => ({ 
        id: u.id, 
        name: u.gameNick || u.name, 
        role: u.role || 'user',
        isBanned: u.isBanned || false,
        banReason: u.banReason || null,
        isMuted: u.mutedUntil && (new Date().getTime() < u.mutedUntil),
        mutedUntil: u.mutedUntil || null,
        muteReason: u.muteReason || null
    }));
    res.json({ users: safeUsers, orders: db.orders, messages: db.messages, inventory: db.inventory, prices: db.prices, reviews: db.reviews, news: db.news, globalChat: db.globalChat });
});

app.post('/api/admin/inventory', (req, res) => {
    if (!req.session.isAdmin) return res.status(401).json({});
    let newInv = {}; let newPrices = {};
    for (let key in req.body.inventory) newInv[key] = parseInt(req.body.inventory[key]) || 0;
    for (let key in req.body.prices) newPrices[key] = parseInt(req.body.prices[key]) || 0;
    db.inventory = newInv; db.prices = newPrices; saveDB(); res.json({ success: true });
});

// Смена роли юзера
app.post('/api/admin/set-role', (req, res) => {
    if (!req.session.isAdmin) return res.status(401).json({ message: 'Доступ запрещен' });
    const { userId, role } = req.body;
    const allowedRoles = ['user', 'tester', 'moder', 'owner'];
    if (!allowedRoles.includes(role)) {
        return res.status(400).json({ message: 'Неверная роль' });
    }
    const user = db.users.find(u => u.id === userId);
    if (!user) return res.status(404).json({ message: 'Юзер не найден' });

    user.role = role;
    saveDB();
    res.json({ success: true });
});

app.post('/api/admin/complete-order', (req, res) => {
    if (!req.session.isAdmin) return res.status(401).json({});
    const order = db.orders.find(o => o.id === req.body.orderId);
    if (order) { order.status = 'delivered'; saveDB(); res.json({ success: true }); } else { res.status(404).json({}); }
});

app.post('/api/admin/reply', (req, res) => {
    if (!req.session.isAdmin) return res.status(401).json({});
    const { userId, text, type } = req.body;
    db.messages.push({ id: crypto.randomUUID(), userId: userId, sender: 'admin', type: type, text: text, time: getMoscowTime() });
    saveDB(); res.json({ success: true });
});

app.get('/', (req, res) => { res.sendFile(path.join(__dirname, 'public', 'index.html')); });

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Сервер запущен!`));

const express = require('express');
const session = require('express-session');
const passport = require('passport');
const YandexStrategy = require('passport-yandex').Strategy;
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const webpush = require('web-push');

const app = express();

app.use(session({ secret: 'cube_shop_secret', resave: false, saveUninitialized: true }));
app.use(passport.initialize());
app.use(passport.session());
app.use(express.static('public'));
app.use(express.json({ limit: '50mb' }));

const publicVapidKey = 'ТВОЙ_PUBLIC_KEY'; 
const privateVapidKey = 'ТВОЙ_PRIVATE_KEY'; 
try { webpush.setVapidDetails('mailto:test@example.com', publicVapidKey, privateVapidKey); } catch(e) {}

const DB_FILE = process.env.NETRUN ? '/data/db.json' : path.join(__dirname, 'db.json');

// ДОБАВЛЕНО: массив globalChat для общего чата
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
        if (!db.globalChat) db.globalChat = []; // Проверка на чат
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
    if (!user) { user = { id: Date.now().toString(), yandexId: profile.id, name: profile.displayName, gameNick: null, avatar: null, role: 'user' }; db.users.push(user); saveDB(); }
    return done(null, user);
  }
));
passport.serializeUser((user, done) => done(null, user.id));
passport.deserializeUser((id, done) => { const user = db.users.find(u => u.id === id); done(null, user); });

app.get('/api/user', (req, res) => {
    if (req.user) res.json({ name: req.user.name, gameNick: req.user.gameNick, avatar: req.user.avatar, role: req.user.role || 'user' });
    else res.status(401).json({ error: 'Not logged in' });
});

// ОБЩИЙ ЧАТ (API)
app.get('/api/global-chat', (req, res) => {
    // Отдаем последние 50 сообщений
    res.json(db.globalChat.slice(-50));
});

app.post('/api/global-chat', (req, res) => {
    if (!req.user) return res.status(401).json({ message: 'Нет доступа' });
    const { text } = req.body;
    if (!text) return res.status(400).json({ message: 'Пустое сообщение' });

    const user = db.users.find(u => u.id === req.user.id);
    
    const newMsg = {
        id: Date.now().toString(),
        userId: req.user.id,
        name: user.gameNick || user.name,
        role: user.role || 'user', // Владелец, модер, тестер или юзер
        text: text,
        time: new Date().toLocaleTimeString()
    };
    
    db.globalChat.push(newMsg);
    if (db.globalChat.length > 100) db.globalChat.shift(); // Храним только 100 последних
    saveDB();
    res.json({ success: true });
});

// Выдача ролей (Админ)
app.post('/api/admin/set-role', (req, res) => {
    if (!req.session.isAdmin) return res.status(401).json({ message: 'Доступ запрещен' });
    const { userId, role } = req.body;
    const user = db.users.find(u => u.id === userId);
    if (user) {
        user.role = role;
        saveDB();
        res.json({ success: true });
    } else { res.status(404).json({ message: 'Юзер не найден' }); }
});

// ... (Остальные маршруты: заказы, новости, профиль - оставляем как были) ...

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
    db.reviews.push({ id: Date.now().toString(), userId: req.user.id, itemId: order.itemId, rating, text, date: new Date().toLocaleDateString() });
    order.reviewed = true; saveDB(); res.json({ success: true });
});

app.get('/api/news', (req, res) => { res.json([...db.news].sort((a,b) => (b.pinned?1:0) - (a.pinned?1:0))); });

app.post('/api/admin/news', (req, res) => {
    if (!req.session.isAdmin) return res.status(401).json({});
    const { title, content } = req.body;
    const mskTime = new Date(new Date().getTime() + 3*60*60000);
    const dateStr = mskTime.toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
    db.news.unshift({ id: Date.now().toString(), title, content, date: dateStr, edited: null, pinned: false }); saveDB(); res.json({ success: true });
});

app.post('/api/admin/news/edit', (req, res) => {
    if (!req.session.isAdmin) return res.status(401).json({});
    const { id, title, content } = req.body; const newsItem = db.news.find(n => n.id === id);
    if (newsItem) {
        newsItem.title = title; newsItem.content = content;
        const mskTime = new Date(new Date().getTime() + 3*60*60000);
        newsItem.edited = mskTime.toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
        saveDB(); res.json({ success: true });
    } else { res.status(404).json({}); }
});

app.post('/api/admin/news/pin', (req, res) => {
    if (!req.session.isAdmin) return res.status(401).json({});
    const { id } = req.body; const newsItem = db.news.find(n => n.id === id);
    if (newsItem) { if (!newsItem.pinned) { db.news.forEach(n => n.pinned = false); newsItem.pinned = true; } else { newsItem.pinned = false; } saveDB(); res.json({ success: true }); }
});

app.post('/api/admin/news/delete', (req, res) => { if (!req.session.isAdmin) return res.status(401).json({}); db.news = db.news.filter(n => n.id !== req.body.id); saveDB(); res.json({ success: true }); });

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
        order.cancelDate = new Date().toLocaleString();
        db.inventory[order.itemId] = (db.inventory[order.itemId] || 0) + order.qty;
        saveDB(); res.json({ success: true });
    } else { res.status(400).json({}); }
});

app.get('/api/chat', (req, res) => { if (!req.user) return res.status(401).json({}); res.json(db.messages.filter(m => m.userId === req.user.id)); });

app.post('/api/chat', (req, res) => {
    if (!req.user) return res.status(401).json({});
    const { text, type } = req.body;
    db.messages.push({ id: Date.now().toString(), userId: req.user.id, sender: 'user', type: type, text: text, time: new Date().toLocaleTimeString() });
    saveDB();
    setTimeout(() => { db.messages.push({ id: Date.now().toString(), userId: req.user.id, sender: 'admin', type: type, text: 'Сообщение получено. Админ ответит позже (или в TG @Kusik155).', time: new Date().toLocaleTimeString() }); saveDB(); }, 1000);
    res.json({ success: true });
});

app.get('/api/inventory', (req, res) => { res.json({ inventory: db.inventory, prices: db.prices || {} }); });

app.post('/api/register', async (req, res) => {
    const { login, password, gameNick } = req.body;
    if (db.users.find(u => u.name === login)) return res.status(400).json({ message: 'Логин занят!' });
    const hashedPassword = await bcrypt.hash(password, 10);
    const newUser = { id: Date.now().toString(), name: login, password: hashedPassword, gameNick: gameNick, avatar: null, role: 'user' };
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
    db.orders.push({ id: Date.now().toString(), userId: req.user.id, buyerNick: gameNick, itemId, qty, currency, price: currentPrice, status: 'pending', reviewed: false, date: new Date().toLocaleString() });
    saveDB(); res.json({ message: `Заказ создан!` });
});

app.get('/auth/yandex', passport.authenticate('yandex'));
app.get('/auth/yandex/callback', passport.authenticate('yandex', { failureRedirect: '/' }), (req, res) => res.redirect('/'));
app.get('/logout', (req, res, next) => { req.logout((err) => { if (err) return next(err); res.redirect('/'); }); });

const ADMIN_PASSWORD = 'admin';
app.get('/admin', (req, res) => { res.sendFile(path.join(__dirname, 'public', 'admin.html')); });
app.post('/api/admin/login', (req, res) => { if (req.body.password === ADMIN_PASSWORD) { req.session.isAdmin = true; res.json({ success: true }); } else { res.status(401).json({}); } });
app.get('/api/admin/check', (req, res) => { res.json({ isAdmin: req.session.isAdmin === true }); });
app.post('/api/admin/logout', (req, res) => { req.session.isAdmin = false; res.json({ success: true }); });

app.get('/api/admin/data', (req, res) => {
    if (!req.session.isAdmin) return res.status(401).json({});
    const safeUsers = db.users.map(u => ({ id: u.id, name: u.gameNick || u.name, role: u.role || 'user' }));
    res.json({ users: safeUsers, orders: db.orders, messages: db.messages, inventory: db.inventory, prices: db.prices, reviews: db.reviews, news: db.news });
});

app.post('/api/admin/inventory', (req, res) => {
    if (!req.session.isAdmin) return res.status(401).json({});
    let newInv = {}; let newPrices = {};
    for (let key in req.body.inventory) newInv[key] = parseInt(req.body.inventory[key]) || 0;
    for (let key in req.body.prices) newPrices[key] = parseInt(req.body.prices[key]) || 0;
    db.inventory = newInv; db.prices = newPrices; saveDB(); res.json({ success: true });
});

app.post('/api/admin/complete-order', (req, res) => {
    if (!req.session.isAdmin) return res.status(401).json({});
    const order = db.orders.find(o => o.id === req.body.orderId);
    if (order) { order.status = 'delivered'; saveDB(); res.json({ success: true }); } else { res.status(404).json({}); }
});

app.post('/api/admin/reply', (req, res) => {
    if (!req.session.isAdmin) return res.status(401).json({});
    const { userId, text, type } = req.body;
    db.messages.push({ id: Date.now().toString(), userId: userId, sender: 'admin', type: type, text: text, time: new Date().toLocaleTimeString() });
    saveDB(); res.json({ success: true });
});

app.get('/', (req, res) => { res.sendFile(path.join(__dirname, 'public', 'index.html')); });

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Сервер запущен!`));

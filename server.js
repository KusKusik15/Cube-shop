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

// --- КЛЮЧИ ---
const publicVapidKey = 'ТВОЙ_PUBLIC_KEY'; 
const privateVapidKey = 'ТВОЙ_PRIVATE_KEY'; 
try { webpush.setVapidDetails('mailto:test@example.com', publicVapidKey, privateVapidKey); } catch(e) {}

// --- БАЗА ---
const DB_FILE = path.join(__dirname, 'db.json');
let db = { users: [], inventory: { damass: 10, copper: 5, cobble: 10, vip: 3 }, orders: [], messages: [], reviews: [] };
if (fs.existsSync(DB_FILE)) { 
    try { 
        db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); 
        if (!db.users) db.users = [];
        if (!db.orders) db.orders = [];
        if (!db.messages) db.messages = [];
        if (!db.reviews) db.reviews = [];
        if (!db.inventory) db.inventory = { damass: 10, copper: 5, cobble: 10, vip: 3 };
    } catch (e) {} 
} else { fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2)); }
function saveDB() { fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2)); }

// --- ЯНДЕКС ---
passport.use(new YandexStrategy({
    clientID: 'c0f552be2f44400b80e933f514c19d0f',
    clientSecret: 'dca12e0b6afe4cef90c4adad79dad527',
    callbackURL: "http://localhost:3000/auth/yandex/callback"
  },
  function(accessToken, refreshToken, profile, done) {
    let user = db.users.find(u => u.yandexId === profile.id);
    if (!user) { user = { id: Date.now().toString(), yandexId: profile.id, name: profile.displayName, gameNick: null, avatar: null, pushSub: null }; db.users.push(user); saveDB(); }
    return done(null, user);
  }
));
passport.serializeUser((user, done) => done(null, user.id));
passport.deserializeUser((id, done) => { const user = db.users.find(u => u.id === id); done(null, user); });

// --- МАРШРУТЫ ---
app.get('/api/user', (req, res) => {
    if (req.user) res.json({ name: req.user.name, gameNick: req.user.gameNick, avatar: req.user.avatar });
    else res.status(401).json({ error: 'Not logged in' });
});

app.post('/api/profile/update', (req, res) => {
    if (!req.user) return res.status(401).json({ message: 'Нет доступа' });
    const { gameNick, avatar } = req.body;
    const user = db.users.find(u => u.id === req.user.id);
    if (gameNick !== undefined) user.gameNick = gameNick;
    if (avatar !== undefined) user.avatar = avatar;
    saveDB();
    res.json({ message: 'Профиль обновлен' });
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
    saveDB();
    res.json({ message: 'Пароль изменен' });
});

app.get('/api/orders', (req, res) => {
    if (!req.user) return res.status(401).json({ message: 'Нет доступа' });
    res.json(db.orders.filter(o => o.userId === req.user.id));
});

app.get('/api/reviews/all', (req, res) => {
    const publicReviews = db.reviews.map(r => {
        const user = db.users.find(u => u.id === r.userId);
        return { id: r.id, userName: user ? user.name : 'Аноним', rating: r.rating, text: r.text, itemId: r.itemId, date: r.date };
    }).reverse().slice(0, 10);
    res.json(publicReviews);
});

app.post('/api/reviews/add', (req, res) => {
    if (!req.user) return res.status(401).json({ message: 'Нет доступа' });
    const { orderId, rating, text } = req.body;
    const order = db.orders.find(o => o.id === orderId && o.userId === req.user.id);
    if (!order) return res.status(404).json({ message: 'Заказ не найден' });
    
    db.reviews.push({ id: Date.now().toString(), userId: req.user.id, itemId: order.itemId, rating, text, date: new Date().toLocaleDateString() });
    order.reviewed = true;
    saveDB();
    res.json({ success: true });
});

app.post('/api/order/confirm-receipt', (req, res) => {
    if (!req.user) return res.status(401).json({ message: 'Нет доступа' });
    const { orderId } = req.body;
    const order = db.orders.find(o => o.id === orderId && o.userId === req.user.id);
    if (order && (order.status === 'delivered' || order.status === 'dispute')) {
        order.status = 'completed';
        saveDB();
        res.json({ success: true });
    } else { res.status(400).json({ message: 'Ошибка' }); }
});

app.post('/api/order/dispute', (req, res) => {
    if (!req.user) return res.status(401).json({ message: 'Нет доступа' });
    const { orderId } = req.body;
    const order = db.orders.find(o => o.id === orderId && o.userId === req.user.id);
    if (order && order.status === 'delivered') {
        order.status = 'dispute'; 
        saveDB();
        res.json({ success: true });
    } else { res.status(400).json({ message: 'Ошибка' }); }
});

app.post('/api/order/cancel', (req, res) => {
    if (!req.user) return res.status(401).json({ message: 'Нет доступа' });
    const { orderId } = req.body;
    const order = db.orders.find(o => o.id === orderId && o.userId === req.user.id);
    
    if (order && (order.status === 'pending' || order.status === 'dispute' || order.status === 'delivered')) {
        order.status = 'cancelled';
        db.inventory[order.itemId] = (db.inventory[order.itemId] || 0) + order.qty;
        
        const time = new Date().toLocaleString();
        db.messages.push({ 
            id: Date.now().toString(), userId: req.user.id, sender: 'user', type: 'seller', 
            text: `🚨 ВНИМАНИЕ: Игрок отменил заказ #${order.id} (${order.itemId} x${order.qty}) в ${time}.`, time: time 
        });
        saveDB();
        res.json({ success: true });
    } else { res.status(400).json({ message: 'Нельзя отменить' }); }
});

app.get('/api/chat', (req, res) => {
    if (!req.user) return res.status(401).json({ message: 'Нет доступа' });
    res.json(db.messages.filter(m => m.userId === req.user.id));
});

app.post('/api/chat', (req, res) => {
    if (!req.user) return res.status(401).json({ message: 'Нет доступа' });
    const { text, type } = req.body;
    db.messages.push({ id: Date.now().toString(), userId: req.user.id, sender: 'user', type: type, text: text, time: new Date().toLocaleTimeString() });
    saveDB();
    
    setTimeout(() => {
        let autoText = type === 'support' 
            ? 'Ваше обращение принято в техподдержку. Пожалуйста, опишите проблему подробнее и ожидайте ответа администратора.'
            : 'Сообщение отправлено продавцу (KusKusik15). Я свяжусь с вами для выдачи заказа, либо напишите мне в Telegram: @Kusik155.';
        
        db.messages.push({ id: Date.now().toString(), userId: req.user.id, sender: 'admin', type: type, text: autoText, time: new Date().toLocaleTimeString() });
        saveDB();
    }, 1000);
    res.json({ success: true });
});

app.get('/api/inventory', (req, res) => { res.json(db.inventory); });

app.post('/api/register', async (req, res) => {
    const { login, password, gameNick } = req.body;
    if (db.users.find(u => u.name === login)) return res.status(400).json({ message: 'Логин занят!' });
    const hashedPassword = await bcrypt.hash(password, 10);
    const newUser = { id: Date.now().toString(), name: login, password: hashedPassword, gameNick, avatar: null, pushSub: null };
    db.users.push(newUser); saveDB();
    req.login(newUser, (err) => { if (err) return res.status(500).json({ message: 'Ошибка' }); res.json({ message: 'Успешно!' }); });
});

app.post('/api/login', async (req, res) => {
    const { login, password } = req.body;
    const user = db.users.find(u => u.name === login);
    if (!user || !user.password) return res.status(400).json({ message: 'Неверный логин или пароль' });
    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) return res.status(400).json({ message: 'Неверный логин или пароль' });
    req.login(user, (err) => { if (err) return res.status(500).json({ message: 'Ошибка' }); res.json({ message: 'Успешно!' }); });
});

app.post('/api/order', (req, res) => {
    if (!req.user) return res.status(401).json({ message: 'Вы не авторизованы!' });
    const { itemId, qty, gameNick, currency } = req.body;
    if (!db.inventory[itemId] || db.inventory[itemId] < qty) return res.status(400).json({ message: 'Нет в наличии!' });
    
    db.inventory[itemId] -= qty;
    db.orders.push({ 
        id: Date.now().toString(), userId: req.user.id, buyerNick: gameNick, itemId, qty, currency, 
        status: 'pending', reviewed: false,
        date: new Date().toLocaleString() 
    });
    saveDB();
    res.json({ message: `Заказ создан!` });
});

app.get('/auth/yandex', passport.authenticate('yandex'));
app.get('/auth/yandex/callback', passport.authenticate('yandex', { failureRedirect: '/login' }), (req, res) => res.redirect('/'));
app.get('/logout', (req, res, next) => { req.logout((err) => { if (err) return next(err); res.redirect('/login'); }); });

// --- АДМИНКА ---
const ADMIN_PASSWORD = 'admin';
app.get('/admin', (req, res) => { res.sendFile(path.join(__dirname, 'public', 'admin.html')); });
app.post('/api/admin/login', (req, res) => { if (req.body.password === ADMIN_PASSWORD) { req.session.isAdmin = true; res.json({ success: true }); } else { res.status(401).json({ message: 'Неверный пароль' }); } });
app.get('/api/admin/check', (req, res) => { res.json({ isAdmin: req.session.isAdmin === true }); });
app.post('/api/admin/logout', (req, res) => { req.session.isAdmin = false; res.json({ success: true }); });

app.get('/api/admin/data', (req, res) => {
    if (!req.session.isAdmin) return res.status(401).json({ message: 'Доступ запрещен' });
    const safeUsers = db.users.map(u => ({ id: u.id, name: u.name, gameNick: u.gameNick }));
    res.json({ users: safeUsers, orders: db.orders, messages: db.messages, inventory: db.inventory, reviews: db.reviews });
});

app.post('/api/admin/inventory', (req, res) => {
    if (!req.session.isAdmin) return res.status(401).json({ message: 'Доступ запрещен' });
    let newInv = {};
    for (let key in req.body) { newInv[key] = parseInt(req.body[key]) || 0; }
    db.inventory = newInv;
    saveDB();
    res.json({ success: true });
});

app.post('/api/admin/complete-order', (req, res) => {
    if (!req.session.isAdmin) return res.status(401).json({ message: 'Доступ запрещен' });
    const { orderId } = req.body;
    const order = db.orders.find(o => o.id === orderId);
    if (order) { order.status = 'delivered'; saveDB(); res.json({ success: true }); } 
    else { res.status(404).json({ message: 'Заказ не найден' }); }
});

app.post('/api/admin/reply', (req, res) => {
    if (!req.session.isAdmin) return res.status(401).json({ message: 'Доступ запрещен' });
    const { userId, text, type } = req.body;
    db.messages.push({ id: Date.now().toString(), userId: userId, sender: 'admin', type: type, text: text, time: new Date().toLocaleTimeString() });
    saveDB();
    res.json({ success: true });
});

app.get('/', (req, res) => { res.sendFile(path.join(__dirname, 'public', 'index.html')); });

// --- ЗАПУСК СЕРВЕРА С КРАСИВЫМИ ССЫЛКАМИ ---
const PORT = 3000;
app.listen(PORT, () => {
    console.log('\n=============================================');
    console.log('🚀 СЕРВЕР УСПЕШНО ЗАПУЩЕН!');
    console.log(`🛒 Магазин:  http://localhost:${PORT}`);
    console.log(`🚨 Админка:  http://localhost:${PORT}/admin`);
    console.log('=============================================\n');
});
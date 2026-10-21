// --- НОВОСТИ ---
app.get('/api/news', (req, res) => {
    // Сортируем: сначала закрепленные, потом по дате (новые сверху)
    const sortedNews = [...db.news].sort((a, b) => {
        if (a.pinned && !b.pinned) return -1;
        if (!a.pinned && b.pinned) return 1;
        return 0; // Если статус одинаковый, оставляем как есть (они уже добавлены в начало при создании)
    });
    res.json(sortedNews);
});

app.post('/api/admin/news', (req, res) => {
    if (!req.session.isAdmin) return res.status(401).json({ message: 'Доступ запрещен' });
    const { title, content } = req.body;
    
    const now = new Date();
    const mskOffset = 3 * 60; 
    const localOffset = now.getTimezoneOffset();
    const mskTime = new Date(now.getTime() + (mskOffset + localOffset) * 60000);
    
    const dateStr = mskTime.toLocaleString('ru-RU', { 
        day: '2-digit', month: '2-digit', year: 'numeric', 
        hour: '2-digit', minute: '2-digit' 
    });

    db.news.unshift({ id: Date.now().toString(), title, content, date: dateStr, edited: null, pinned: false });
    saveDB();
    res.json({ success: true });
});

app.post('/api/admin/news/edit', (req, res) => {
    if (!req.session.isAdmin) return res.status(401).json({ message: 'Доступ запрещен' });
    const { id, title, content } = req.body;
    const newsItem = db.news.find(n => n.id === id);
    
    if (newsItem) {
        newsItem.title = title;
        newsItem.content = content;

        const now = new Date();
        const mskOffset = 3 * 60; 
        const localOffset = now.getTimezoneOffset();
        const mskTime = new Date(now.getTime() + (mskOffset + localOffset) * 60000);
        
        newsItem.edited = mskTime.toLocaleString('ru-RU', { 
            day: '2-digit', month: '2-digit', year: 'numeric', 
            hour: '2-digit', minute: '2-digit' 
        });
        
        saveDB();
        res.json({ success: true });
    } else {
        res.status(404).json({ message: 'Новость не найдена' });
    }
});

// ЗАКРЕПЛЕНИЕ НОВОСТИ
app.post('/api/admin/news/pin', (req, res) => {
    if (!req.session.isAdmin) return res.status(401).json({ message: 'Доступ запрещен' });
    const { id } = req.body;
    const newsItem = db.news.find(n => n.id === id);
    
    if (newsItem) {
        // Если закрепляем, снимаем закреп со всех остальных (чтобы закреп был только один)
        if (!newsItem.pinned) {
            db.news.forEach(n => n.pinned = false);
            newsItem.pinned = true;
        } else {
            newsItem.pinned = false; // Если уже закреплено, открепляем
        }
        saveDB();
        res.json({ success: true });
    } else {
        res.status(404).json({ message: 'Новость не найдена' });
    }
});

app.post('/api/admin/news/delete', (req, res) => {
    if (!req.session.isAdmin) return res.status(401).json({ message: 'Доступ запрещен' });
    db.news = db.news.filter(n => n.id !== req.body.id);
    saveDB();
    res.json({ success: true });
});

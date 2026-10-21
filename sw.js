self.addEventListener('push', function(event) {
    const data = event.data ? event.data.json() : {};
    const title = data.title || 'Cube Shop';
    const options = {
        body: data.body || 'Новое уведомление',
        icon: 'https://cdn.jsdelivr.net/gh/InventivetalentDev/minecraft-assets@1.20.1/assets/minecraft/textures/item/netherite_ingot.png'
    };
    event.waitUntil(self.registration.showNotification(title, options));
});
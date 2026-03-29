# 🚀 تشغيل خطّاف — خطوة بخطوة

## المتطلبات
- Node.js 18 أو أحدث → https://nodejs.org
- حساب Anthropic (للذكاء الاصطناعي) → https://console.anthropic.com
- حساب Stripe (للدفع) → https://stripe.com

---

## الخطوات

### ١. نسخ ملف البيئة
```bash
cp .env.example .env
```
افتح `.env` وحط مفاتيحك الحقيقية.

### ٢. تثبيت المكتبات
```bash
npm install
```

### ٣. تشغيل المشروع
```bash
# للتطوير (يتجدد تلقائياً)
npm run dev

# للإنتاج
npm start
```

### ٤. افتح المتصفح
```
http://localhost:3000
```

---

## إعداد Stripe

1. سجّل دخول على https://dashboard.stripe.com
2. روح لـ **Products** → **Add Product**
3. أنشئ منتج اسمه "خطّاف Pro"
4. أضف سعرين:
   - شهري: **39 SAR** / month  → انسخ الـ Price ID في `.env` كـ `STRIPE_PRICE_MONTHLY`
   - سنوي: **299 SAR** / year  → انسخ الـ Price ID في `.env` كـ `STRIPE_PRICE_ANNUAL`
5. من **Developers → API Keys** انسخ الـ Secret Key

---

## النشر على الإنترنت (مجاناً أو رخيص)

### Railway (الأسهل)
1. روح https://railway.app
2. New Project → Deploy from GitHub
3. أضف متغيرات البيئة من لوحة الإعدادات
4. ✅ خلاص — رابطك جاهز

### Render
1. روح https://render.com
2. New Web Service → Connect GitHub
3. Build Command: `npm install`
4. Start Command: `npm start`
5. أضف Environment Variables

---

## هيكل الملفات

```
khattaf/
├── index.html       ← الواجهة الأمامية (RTL عربي)
├── server.js        ← الباك-إند (Express + Claude + Stripe)
├── package.json     ← المكتبات
├── .env             ← مفاتيح API (لا ترفعه على GitHub!)
├── .env.example     ← مثال للمفاتيح
├── PROJECT_BRIEF.md ← وصف المشروع الكامل
└── SETUP.md         ← هذا الملف
```

---

## ملاحظات مهمة

- **لا ترفع `.env` على GitHub** — أضفه في `.gitignore`
- في وضع التطوير، Stripe يعمل بـ test keys (بدون دفع حقيقي)
- لتفعيل الـ Stripe Webhook، راجع: https://stripe.com/docs/webhooks

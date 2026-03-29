require('dotenv').config();
const express  = require('express');
const cors     = require('cors');
const path     = require('path');
const Stripe   = require('stripe');

// ── AI clients ──────────────────────────────────────────
const { GoogleGenerativeAI } = require('@google/generative-ai');
const Anthropic = require('@anthropic-ai/sdk');

const gemini    = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const anthropic = process.env.ANTHROPIC_API_KEY
  ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  : null;

const stripe = process.env.STRIPE_SECRET_KEY
  ? Stripe(process.env.STRIPE_SECRET_KEY)
  : null;

// ── App ─────────────────────────────────────────────────
const app  = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname)));

// ── Platform hints ───────────────────────────────────────
const HINTS = {
  instagram: 'إنستقرام: كابشن مثالي بين ١٥٠–٣٠٠ حرف، هوك قوي في أول سطر، إيموجي مناسبة، CTA واضح.',
  tiktok:    'تيك توك: نص قصير وصارخ، الجملة الأولى تحسم كل شيء في ثانيتين، لغة شبابية ومباشرة.',
  x:         'تويتر/X: أقل من ٢٨٠ حرف، مباشر وجريء، يثير فضول أو ردة فعل فورية.'
};

// ══════════════════════════════════════════════════════════
//  STEP 1 — Gemini analyzes the post
// ══════════════════════════════════════════════════════════
async function runGemini(text, platform) {
  const model = gemini.getGenerativeModel({ model: 'gemini-2.0-flash' });

  const prompt = `
أنت خبير محتوى رقمي خليجي متخصص في السوشيال ميديا السعودية والخليجية.
مهمتك تحليل المنشور التالي وتحسينه لتحقيق أكبر انتشار وتفاعل.

المنصة: ${platform}
تلميح المنصة: ${HINTS[platform] || HINTS.instagram}

قواعد مهمة:
- اكتب بالعربي الخليجي السعودي الطبيعي، ليس فصحى رسمية
- كن صريحاً ومباشراً في النقد
- ركّز على: الهوك، التشويق، الـ CTA، المشاعر، الوضوح
- الهاشتاقات يجب أن تكون خليجية ومناسبة للمحتوى

المنشور:
"""
${text}
"""

أرجع ردّك كـ JSON فقط بهذا الشكل بالضبط (لا تضف أي نص خارج الـ JSON):
{
  "score": رقم من 1 إلى 10,
  "verdict": "جملة واحدة تلخّص تقييمك للمنشور",
  "analysis": "فقرة تحليل مفصّلة من 2-3 جمل تشرح نقاط الضعف والقوة",
  "weaknesses": ["نقطة ضعف محددة وقابلة للتطبيق", "نقطة ضعف ثانية", "نقطة ضعف ثالثة"],
  "rewrite": "نص المنشور المُحسَّن كاملاً بالخليجي",
  "hashtags": ["#هاشتاق١", "#هاشتاق٢", "#هاشتاق٣", "#هاشتاق٤", "#هاشتاق٥", "#هاشتاق٦"]
}`;

  const result = await model.generateContent(prompt);
  const raw    = result.response.text().trim();
  const match  = raw.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('Gemini: invalid JSON');
  return JSON.parse(match[0]);
}

// ══════════════════════════════════════════════════════════
//  STEP 2 — Claude reviews & elevates Gemini's output
//  (only runs if ANTHROPIC_API_KEY is set)
// ══════════════════════════════════════════════════════════
async function runClaudeReview(originalText, platform, geminiResult) {
  if (!anthropic) return geminiResult; // skip if no Claude key

  const systemPrompt = `أنت محرر محتوى رقمي خليجي خبير. مهمتك مراجعة تحليل AI آخر لمنشور على السوشيال ميديا وتحسينه.
اكتب دائماً بالعربي الخليجي السعودي الطبيعي.
أرجع JSON فقط بنفس الشكل الذي استلمته.`;

  const userPrompt = `
المنشور الأصلي:
"""${originalText}"""

المنصة: ${platform}

تحليل Gemini:
${JSON.stringify(geminiResult, null, 2)}

مهمتك:
1. راجع التقييم (score) — هل هو دقيق؟ عدّله إذا لزم
2. حسّن نقاط الضعف — اجعلها أكثر تحديداً وقابلية للتطبيق
3. أعد كتابة النسخة المحسّنة إذا كانت تحتاج تطوير
4. تأكد من أن الهاشتاقات خليجية وفعّالة
5. اجعل الـ verdict أكثر صدقاً وصرامة

أرجع JSON بنفس الشكل بالضبط:
{
  "score": رقم,
  "verdict": "...",
  "analysis": "...",
  "weaknesses": ["...","...","..."],
  "rewrite": "...",
  "hashtags": ["#...","#...","#...","#...","#...","#..."]
}`;

  const msg = await anthropic.messages.create({
    model:      'claude-sonnet-4-6',
    max_tokens: 1500,
    system:     systemPrompt,
    messages:   [{ role: 'user', content: userPrompt }]
  });

  const raw   = msg.content[0].text.trim();
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return geminiResult; // fallback to Gemini result
  return JSON.parse(match[0]);
}

// ══════════════════════════════════════════════════════════
//  POST /api/analyze
// ══════════════════════════════════════════════════════════
app.post('/api/analyze', async (req, res) => {
  const { text, platform } = req.body;

  if (!text || text.trim().length < 5) {
    return res.status(400).json({ error: 'المنشور فارغ أو قصير جداً' });
  }

  try {
    // Round 1: Gemini analyzes
    console.log('🟡 Gemini analyzing...');
    const geminiResult = await runGemini(text.trim(), platform || 'instagram');

    // Round 2: Claude reviews & elevates (if key exists)
    let finalResult = geminiResult;
    if (anthropic) {
      console.log('🟣 Claude reviewing Gemini output...');
      finalResult = await runClaudeReview(text.trim(), platform || 'instagram', geminiResult);
    }

    console.log('✅ Final score:', finalResult.score);
    res.json(finalResult);

  } catch (err) {
    console.error('❌ Analysis error:', err.message);
    res.status(500).json({ error: 'حدث خطأ في التحليل، حاول مرة ثانية' });
  }
});

// ══════════════════════════════════════════════════════════
//  GET /api/checkout
// ══════════════════════════════════════════════════════════
app.get('/api/checkout', async (req, res) => {
  if (!stripe) {
    return res.status(503).send('Stripe not configured. Add STRIPE_SECRET_KEY to .env');
  }

  const plan    = req.query.plan === 'annual' ? 'annual' : 'monthly';
  const priceId = plan === 'annual'
    ? process.env.STRIPE_PRICE_ANNUAL
    : process.env.STRIPE_PRICE_MONTHLY;

  if (!priceId) {
    return res.status(503).send(`Missing Stripe price ID for: ${plan}`);
  }

  try {
    const session = await stripe.checkout.sessions.create({
      mode:                 'subscription',
      payment_method_types: ['card'],
      line_items:           [{ price: priceId, quantity: 1 }],
      success_url: `${process.env.BASE_URL || 'http://localhost:' + PORT}/?success=true`,
      cancel_url:  `${process.env.BASE_URL || 'http://localhost:' + PORT}/?canceled=true`,
      locale:      'ar',
      metadata:    { plan }
    });
    res.redirect(303, session.url);
  } catch (err) {
    console.error('Stripe error:', err.message);
    res.status(500).send('خطأ في الدفع');
  }
});

// ══════════════════════════════════════════════════════════
//  POST /api/webhook
// ══════════════════════════════════════════════════════════
app.post('/api/webhook', express.raw({ type: 'application/json' }), (req, res) => {
  if (!stripe) return res.status(503).send('Stripe not configured');

  let event;
  try {
    event = stripe.webhooks.constructEvent(
      req.body, req.headers['stripe-signature'], process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === 'checkout.session.completed') {
    const s = event.data.object;
    console.log('✅ New Pro subscriber:', s.customer_email, '| Plan:', s.metadata?.plan);
    // TODO: mark user as Pro in your database
  }
  res.json({ received: true });
});

// ── Catch-all ──
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// ── Start ──
app.listen(PORT, () => {
  console.log(`\n🚀 خطّاف running on http://localhost:${PORT}`);
  if (!process.env.GEMINI_API_KEY)    console.warn('⚠️  GEMINI_API_KEY missing');
  if (!process.env.ANTHROPIC_API_KEY) console.warn('ℹ️  ANTHROPIC_API_KEY not set (dual-model disabled)');
  if (!process.env.STRIPE_SECRET_KEY) console.warn('ℹ️  STRIPE_SECRET_KEY not set (payments disabled)');
});

require('dotenv').config();
const express  = require('express');
const cors     = require('cors');
const path     = require('path');
const Stripe   = require('stripe');
const { clerkMiddleware, getAuth, clerkClient } = require('@clerk/express');

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
// Webhook يحتاج raw body — يجب أن يكون قبل express.json()
app.use('/api/webhook', express.raw({ type: 'application/json' }));
app.use(express.json());
app.use(express.static(path.join(__dirname)));

// Clerk middleware — يضيف auth لكل الطلبات (لا يمنع الوصول، فقط يقرأ التوكن)
app.use(clerkMiddleware());

// ── Platform hints ───────────────────────────────────────
const HINTS = {
  instagram: 'إنستقرام: كابشن مثالي بين ١٥٠–٣٠٠ حرف، هوك قوي في أول سطر، إيموجي مناسبة، CTA واضح.',
  tiktok:    'تيك توك: نص قصير وصارخ، الجملة الأولى تحسم كل شيء في ثانيتين، لغة شبابية ومباشرة.',
  x:         'تويتر/X: أقل من ٢٨٠ حرف، مباشر وجريء، يثير فضول أو ردة فعل فورية.',
  linkedin:  'لينكدإن: محتوى احترافي وملهم، قصة شخصية أو إنجاز أو درس تعلمته، أسلوب دافئ وإنساني، CTA يدعو للتعليق أو المشاركة، لا تزيد عن ٣٠٠ كلمة.'
};

// ══════════════════════════════════════════════════════════
//  PROMPT builder
// ══════════════════════════════════════════════════════════
function buildPrompt(text, platform) {
  return `أنت خبير محتوى رقمي خليجي متخصص في السوشيال ميديا السعودية والخليجية.
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

أرجع ردّك كـ JSON فقط بهذا الشكل (لا تضف أي نص خارج الـ JSON):
{
  "score": رقم من 1 إلى 10,
  "verdict": "جملة واحدة تلخّص تقييمك للمنشور",
  "analysis": "فقرة تحليل مفصّلة 2-3 جمل",
  "weaknesses": ["نقطة ضعف محددة", "نقطة ضعف ثانية", "نقطة ضعف ثالثة"],
  "rewrite": "نص المنشور المُحسَّن كاملاً بالخليجي",
  "hashtags": ["#هاشتاق١", "#هاشتاق٢", "#هاشتاق٣", "#هاشتاق٤", "#هاشتاق٥", "#هاشتاق٦"]
}`;
}

// ══════════════════════════════════════════════════════════
//  STEP 1 — Claude يحلّل
// ══════════════════════════════════════════════════════════
async function runClaude(text, platform) {
  const msg = await anthropic.messages.create({
    model:      'claude-sonnet-4-6',
    max_tokens: 1500,
    messages:   [{ role: 'user', content: buildPrompt(text, platform) }]
  });
  const raw   = msg.content[0].text.trim();
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('Claude: invalid JSON');
  return JSON.parse(match[0]);
}

// ══════════════════════════════════════════════════════════
//  STEP 2 — Gemini يراجع (اختياري)
// ══════════════════════════════════════════════════════════
async function runGeminiReview(text, platform, claudeResult) {
  if (!process.env.GEMINI_API_KEY) return claudeResult;
  try {
    const model  = gemini.getGenerativeModel({ model: 'gemini-2.0-flash' });
    const prompt = `أنت محرر محتوى خليجي. راجع هذا التحليل وحسّنه إذا لزم.

المنشور الأصلي: """${text}"""
المنصة: ${platform}

التحليل الحالي:
${JSON.stringify(claudeResult, null, 2)}

أرجع JSON بنفس الشكل بالضبط مع أي تحسينات تراها مناسبة.`;

    const result = await model.generateContent(prompt);
    const raw    = result.response.text().trim();
    const match  = raw.match(/\{[\s\S]*\}/);
    if (!match) return claudeResult;
    return JSON.parse(match[0]);
  } catch (err) {
    console.warn('⚠️ Gemini review skipped:', err.message.slice(0, 80));
    return claudeResult;
  }
}

// ══════════════════════════════════════════════════════════
//  GET /api/user-status — هل المستخدم Pro؟
// ══════════════════════════════════════════════════════════
app.get('/api/user-status', async (req, res) => {
  try {
    const { userId } = getAuth(req);
    if (!userId) return res.json({ authenticated: false, pro: false });

    const user = await clerkClient.users.getUser(userId);
    const pro  = user.publicMetadata?.pro === true;
    const plan = user.publicMetadata?.plan || null;

    res.json({ authenticated: true, pro, plan, userId });
  } catch (err) {
    console.error('user-status error:', err.message);
    res.json({ authenticated: false, pro: false });
  }
});

// ══════════════════════════════════════════════════════════
//  POST /api/analyze
// ══════════════════════════════════════════════════════════
app.post('/api/analyze', async (req, res) => {
  const { text, platform } = req.body;

  if (!text || text.trim().length < 5) {
    return res.status(400).json({ error: 'المنشور فارغ أو قصير جداً' });
  }
  if (!anthropic) {
    return res.status(503).json({ error: 'ANTHROPIC_API_KEY غير موجود في الإعدادات' });
  }

  try {
    console.log('🟣 Claude analyzing...');
    const claudeResult = await runClaude(text.trim(), platform || 'instagram');

    console.log('🟡 Gemini reviewing...');
    const finalResult = await runGeminiReview(text.trim(), platform || 'instagram', claudeResult);

    console.log('✅ Final score:', finalResult.score);
    res.json(finalResult);
  } catch (err) {
    console.error('❌ Analysis error:', err.message);
    res.status(500).json({ error: 'حدث خطأ في التحليل، حاول مرة ثانية' });
  }
});

// ══════════════════════════════════════════════════════════
//  GET /api/checkout — يمرر userId لـ Stripe
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

  // نجيب userId من Clerk إذا كان المستخدم مسجّل دخول
  const { userId } = getAuth(req);

  try {
    const session = await stripe.checkout.sessions.create({
      mode:                      'subscription',
      payment_method_types:      ['card'],
      payment_method_options:    {
        card: { request_three_d_secure: 'automatic' }
      },
      line_items:                [{ price: priceId, quantity: 1 }],
      billing_address_collection:'required',
      success_url: `${process.env.BASE_URL || 'http://localhost:' + PORT}/?success=true&plan=${plan}`,
      cancel_url:  `${process.env.BASE_URL || 'http://localhost:' + PORT}/?canceled=true`,
      locale:      'auto',
      metadata:    { plan, clerkUserId: userId || '' },
      // نحفظ clerkUserId حتى نربطه في الـ webhook
      client_reference_id: userId || 'guest'
    });
    res.redirect(303, session.url);
  } catch (err) {
    console.error('Stripe error:', err.message);
    res.status(500).send(`خطأ في الدفع: ${err.message}`);
  }
});

// ══════════════════════════════════════════════════════════
//  POST /api/webhook — بعد الدفع نفعّل Pro في Clerk
// ══════════════════════════════════════════════════════════
app.post('/api/webhook', async (req, res) => {
  if (!stripe) return res.status(503).send('Stripe not configured');

  let event;
  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      req.headers['stripe-signature'],
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error('Webhook signature error:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === 'checkout.session.completed') {
    const session     = event.data.object;
    const clerkUserId = session.metadata?.clerkUserId || session.client_reference_id;
    const plan        = session.metadata?.plan || 'monthly';

    console.log('✅ Payment completed | Clerk user:', clerkUserId, '| Plan:', plan);

    // نفعّل Pro في Clerk metadata
    if (clerkUserId && clerkUserId !== 'guest') {
      try {
        await clerkClient.users.updateUserMetadata(clerkUserId, {
          publicMetadata: {
            pro:   true,
            plan:  plan,
            since: Date.now(),
            stripeCustomer: session.customer
          }
        });
        console.log('✅ Clerk user marked as Pro:', clerkUserId);
      } catch (err) {
        console.error('❌ Failed to update Clerk metadata:', err.message);
      }
    }
  }

  if (event.type === 'customer.subscription.deleted') {
    // لو ألغى الاشتراك — نلغي Pro
    const subscription = event.data.object;
    const customerId   = subscription.customer;
    console.log('⚠️ Subscription cancelled for customer:', customerId);
    // يمكن ربطه لاحقاً بـ userId عبر قاعدة بيانات
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
  if (!process.env.ANTHROPIC_API_KEY) console.warn('⚠️  ANTHROPIC_API_KEY not set');
  if (!process.env.STRIPE_SECRET_KEY) console.warn('⚠️  STRIPE_SECRET_KEY not set');
  if (!process.env.CLERK_SECRET_KEY)  console.warn('⚠️  CLERK_SECRET_KEY not set');
});

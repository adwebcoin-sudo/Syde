// =========================================================
// Nabd Copy Server
// سيرفر بسيط: يستقبل بيانات حساب المشترك (أي بروكر)،
// يضيفه على MetaApi، ثم يشترك تلقائيًا في نسخ صفقات
// حساب الماستر عبر خدمة CopyFactory المدمجة في MetaApi.
// =========================================================

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const MetaApi = require('metaapi.cloud-sdk').default;
const { CopyFactory } = require('metaapi.cloud-sdk');

const TOKEN = process.env.METAAPI_TOKEN;
const MASTER_ACCOUNT_ID = process.env.MASTER_ACCOUNT_ID;
const STRATEGY_NAME = process.env.STRATEGY_NAME || 'Nabd SMA Strategy';
const PORT = process.env.PORT || 3000;

if (!TOKEN || !MASTER_ACCOUNT_ID) {
  console.error('خطأ: لازم تضبط METAAPI_TOKEN و MASTER_ACCOUNT_ID في متغيرات البيئة');
  process.exit(1);
}

const api = new MetaApi(TOKEN);
const copyFactory = new CopyFactory(TOKEN);

let strategyId = process.env.STRATEGY_ID || null;

// ---------------------------------------------------------
// إنشاء (أو استرجاع) إستراتيجية CopyFactory مرتبطة بحساب الماستر
// ---------------------------------------------------------
async function ensureStrategy() {
  const configApi = copyFactory.configurationApi;

  if (strategyId) {
    console.log('تم استخدام strategyId موجود مسبقًا:', strategyId);
    return strategyId;
  }

  const existing = await configApi.getStrategies();
  const found = existing.find(s => s.name === STRATEGY_NAME);
  if (found) {
    strategyId = found._id;
    console.log('تم العثور على إستراتيجية موجودة:', strategyId);
    return strategyId;
  }

  const created = await configApi.generateStrategyId();
  await configApi.updateStrategy(created.id, {
    name: STRATEGY_NAME,
    description: 'إستراتيجية Nabd — تقاطع SMA5/SMA20',
    accountId: MASTER_ACCOUNT_ID,
  });
  strategyId = created.id;
  console.log('تم إنشاء إستراتيجية جديدة:', strategyId);
  console.log('احفظ هذا المعرف في متغير STRATEGY_ID لتفادي إعادة الإنشاء لاحقًا');
  return strategyId;
}

// ---------------------------------------------------------
// إضافة حساب MT الخاص بالمشترك على MetaApi
// ---------------------------------------------------------
async function addSubscriberAccount({ login, password, server, platform, name }) {
  const account = await api.metatraderAccountApi.createAccount({
    login,
    password,
    server,
    name: name || `subscriber-${login}`,
    platform: platform === 'mt4' ? 'mt4' : 'mt5',
    magic: Math.floor(Math.random() * 900000) + 100000,
    application: 'MetaApi',
    type: 'cloud',
  });

  await account.deploy();
  await account.waitConnected();
  return account;
}

// ---------------------------------------------------------
// ربط حساب المشترك بإستراتيجية الماستر بنسبة مخاطرة محددة
// ---------------------------------------------------------
async function subscribeToStrategy(account, riskRatio) {
  const subscriberConfigApi = copyFactory.configurationApi;
  await subscriberConfigApi.updateSubscriber(account.id, {
    name: account.name,
    subscriptions: [
      {
        strategyId,
        multiplier: riskRatio || 1, // 1 = نفس حجم الماستر نسبيًا، 0.5 = نصف المخاطرة
      },
    ],
  });
}

// ---------------------------------------------------------
// نقاط النهاية (API Endpoints)
// ---------------------------------------------------------
const app = express();
app.use(cors());
app.use(express.json());

app.get('/health', (req, res) => {
  res.json({ status: 'ok', strategyId });
});

// نقطة التسجيل — تستدعيها صفحة الاشتراك على موقعك
app.post('/subscribe', async (req, res) => {
  const { login, password, server, platform, riskRatio, name } = req.body;

  if (!login || !password || !server) {
    return res.status(400).json({ error: 'بيانات ناقصة: login و password و server مطلوبة' });
  }

  try {
    const account = await addSubscriberAccount({ login, password, server, platform, name });
    await subscribeToStrategy(account, riskRatio);

    res.json({
      success: true,
      accountId: account.id,
      message: 'تم ربط الحساب بنجاح — سيبدأ النسخ عند حدوث أول صفقة جديدة من الماستر',
    });
  } catch (err) {
    console.error('خطأ أثناء الاشتراك:', err.message);
    res.status(500).json({ error: 'تعذر ربط الحساب', details: err.message });
  }
});

// نقطة إيقاف النسخ لمشترك (عند إلغاء اشتراكه مثلاً)
app.post('/unsubscribe', async (req, res) => {
  const { accountId } = req.body;
  if (!accountId) return res.status(400).json({ error: 'accountId مطلوب' });

  try {
    const subscriberConfigApi = copyFactory.configurationApi;
    await subscriberConfigApi.updateSubscriber(accountId, { subscriptions: [] });
    res.json({ success: true, message: 'تم إيقاف النسخ لهذا الحساب' });
  } catch (err) {
    res.status(500).json({ error: 'تعذر إيقاف النسخ', details: err.message });
  }
});

ensureStrategy()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`السيرفر شغّال على المنفذ ${PORT}`);
      console.log(`Strategy ID: ${strategyId}`);
    });
  })
  .catch(err => {
    console.error('فشل تجهيز الإستراتيجية عند بدء التشغيل:', err.message);
    process.exit(1);
  });

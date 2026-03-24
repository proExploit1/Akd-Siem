# 🛡️ AKD SIEM

نظام مراقبة أمنية كامل مبني على Electron — مثل Wazuh لكن في برنامج واحد.

---

## 📦 التثبيت السريع

```bash
# 1. نزّل المشروع
git clone https://github.com/yourname/AKD-siem
cd AKD-siem

# 2. ثبّت الـ dependencies
npm install

# 3. شغّل التطبيق
npm start
```

## 🖥️ ربط الأجهزة

### الخطوة الوحيدة المطلوبة:

1. **افتح AKD** على جهازك الرئيسي
2. اضغط **"Connect Agent"** في القائمة الجانبية
3. ستظهر IP الخاصة بك تلقائياً (مثال: `ws://192.168.1.10:8765`)
4. على أي جهاز تريد تراقبه:

```bash
# Linux/Mac
pip install websockets psutil
# عدّل السطر 14 في الملف:
# SIEM_SERVER = "ws://192.168.1.10:8765"
sudo python3 agent/siem_agent.py

# Windows (كـ Administrator)
pip install websockets psutil
python agent\siem_agent.py
```

الجهاز سيظهر تلقائياً في الداشبورد! ✅

---

## 🔨 Build (إنشاء ملف تثبيت)

```bash
npm run build:win    # Windows (.exe)
npm run build:linux  # Linux (.AppImage)
npm run build:mac    # macOS (.dmg)
```

---

## 🛡️ الميزات

| الميزة | الوصف |
|--------|-------|
| 📊 Dashboard | نظرة عامة real-time على كل الأحداث |
| 📋 Live Events | تدفق مباشر للـ logs من كل الأجهزة |
| 🛡️ Threat Detection | 15+ rule للكشف عن الهجمات |
| 🔍 File Integrity | مراقبة تغييرات الملفات الحساسة |
| 🖥️ Agent Management | إدارة كل الأجهزة المتصلة |
| 🔔 Notifications | إشعارات desktop للأحداث الحرجة |

---

## 📁 هيكل المشروع

```
AKD/
├── main.js          ← Electron main + WebSocket server
├── preload.js       ← IPC bridge
├── src/
│   └── index.html   ← Dashboard UI (كل شيء في ملف واحد)
├── agent/
│   └── siem_agent.py ← Agent للأجهزة المراقَبة
└── package.json
```

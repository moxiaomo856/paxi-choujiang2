/* =====================================================================
 * sw.js —— Service Worker
 * 策略：同源静态资源「网络优先 + 缓存兜底」（保证改版后一定是新代码），
 *       跨域请求（LCD / RPC / CDN）一律不拦截，避免缓存脏的链上数据。
 *
 * 【多站隔离】GitHub Pages 的所有项目站点共享同一个 origin，而 Cache Storage
 * 是**跨目录共享**的：tkcc / orion / pick / leo 四个站若用同一个缓存名，
 * 任一站升版本时 activate 里的清理会把另外三站的缓存一起删掉。
 * 所以缓存名从 sw.js 自身路径推导应用名（/paxi-choujiang/tkcc/sw.js → tkcc），
 * 且清理时只动自己的前缀。四个目录共用这一份文件，复制过去即生效。
 * ===================================================================== */
const APP = (self.location.pathname.replace(/\/sw\.js$/, '').split('/').filter(Boolean).pop()) || 'root';
const PREFIX = 'paxi-lottery-' + APP + '-';
// v1 -> v2：SHELL 里的图标由 icon.svg 换成 icon-192.png，清单变了，缓存名必须同步升。
const CACHE = PREFIX + 'v2';

const SHELL = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './chain.js',
  './session.js',
  './lottery.js',
  './hash.js',
  './config.js',
  './i18n.js',
  './manifest.json',
  './icon-192.png',
  // ---- 本地 vendor 加密 / 交易库 ----
  // 缺任何一个都会让"首次离线打开"退化成半残：i18n.js 缺失 → 界面全是 key 原文
  // （wallet.connect 之类直接显示出来）；vendor 缺失 → 加密栈（secp256k1 /
  // hashes / bech32）或交易库加载失败，页面看起来正常但一点就报错。
  './vendor/bech32.mjs',
  './vendor/secp256k1.mjs',
  './vendor/long.umd.js',
  './vendor/paxi-cosmjs.umd.js',
  './vendor/hashes/sha256.js',
  './vendor/hashes/ripemd160.js',
  './vendor/hashes/crypto.js',
  './vendor/hashes/utils.js',
  './vendor/hashes/_md.js',
  './vendor/hashes/_assert.js',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => c.addAll(SHELL).catch(() => {}))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      // 只清理"本站"的历史版本：绝不能删到别的站（同 origin 共享 Cache Storage）
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith(PREFIX) && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  // 跨域（链上 API / CDN）不缓存，直接放行
  if (url.origin !== self.location.origin) return;

  e.respondWith(
    fetch(req)
      .then((res) => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
        }
        return res;
      })
      .catch(async () => {
        const hit = await caches.match(req);
        if (hit) return hit;
        // 只有"导航请求"才回落到 index.html；其它同源资源（css/js/图片）缓存
        // 未命中时若也回落 index.html，浏览器会拿 HTML 去当 CSS/JS 解析 ——
        // 结果是一堆语法错误或静默失败，比直接 504 更难排查。
        if (req.mode === 'navigate') {
          const shell = await caches.match('./index.html');
          if (shell) return shell;
        }
        return new Response('', { status: 504, statusText: 'offline' });
      })
  );
});

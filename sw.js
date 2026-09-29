/* =====================================================================
 * 根目录 sw.js —— 一次性"自杀"脚本（改版过渡用，不是站点的常驻 SW）
 *
 * 背景：旧版把整个抽奖应用放在仓库根目录，并注册了
 * scope = /paxi-choujiang/ 的 Service Worker。改版后根目录变成门户、
 * 应用搬到 tkcc/ orion/ pick/ leo/ 子目录，但那个旧 SW 仍留在用户浏览器里，
 * 它的 scope 覆盖全部子目录 —— 离线时会把 /tkcc/ 的导航请求塞回**旧的根
 * index.html**，用户看到的是旧界面，非常难排查。
 *
 * 所以根目录保留同名 sw.js（字节已变 → 浏览器做更新检查时会取到新版），
 * 它一激活就做两件事：
 *   1) 删掉旧版遗留的缓存（**只删 paxi-lottery-v<N>**，绝不碰四站的新缓存
 *      paxi-lottery-tkcc-v1 之类 —— 同 origin 的 Cache Storage 是共享的，
 *      误删会把四站的离线缓存一起清掉）
 *   2) 注销自己
 * 之后这个 origin 上不再有根 scope 的 SW。
 *
 * 门户页**故意不注册** SW：用户的浏览器只要曾经装过旧根 SW，导航到这里就会
 * 自动做一次更新检查并取到本文件，走完上面的流程；没装过的用户则本来就没有。
 * 这里**不调用 clients.navigate()** —— 激活期间重新导航有触发无限刷新的风险，
 * 而旧 SW 的 fetch 是"网络优先"，在线时页面照常工作，不必强刷。
 * ===================================================================== */
const LEGACY = /^paxi-lottery-v\d+$/;   // 只匹配旧版缓存名：paxi-lottery-v1 / v2 …

self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    try {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => LEGACY.test(k)).map((k) => caches.delete(k)));
    } catch (_) { /* 隐私模式等环境下 caches 可能不可用，忽略 */ }
    try { await self.registration.unregister(); } catch (_) { /* 已注销则忽略 */ }
  })());
});

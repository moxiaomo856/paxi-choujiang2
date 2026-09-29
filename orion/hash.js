/* =====================================================================
 * hash.js —— 加密工具（不自己实现密码学原语，全部走 CDN 库）
 *
 * 依赖 index.html 用 **动态 import()** 挂到 window（这些包只发 ESM）：
 *   @noble/secp256k1 → window.nobleSecp256k1
 *   @noble/hashes    → window.nobleHashes（sha256 / ripemd160）
 *   bech32           → window.bech32
 * 加载完成后 index.html 会 dispatch 'crypto-ready' 事件。
 * ===================================================================== */
(function () {
  function requireLib() {
    const pk = window.nobleSecp256k1 || (window.noble && window.noble.secp256k1);
    const hs = window.nobleHashes || (window.noble && window.noble.hashes);
    const bc = window.bech32 || (window.bech32Lib && window.bech32Lib.bech32);
    if (!pk) throw new Error('缺少 @noble/secp256k1（CDN 未加载）');
    if (!hs || !hs.ripemd160) throw new Error('缺少 @noble/hashes 的 ripemd160（CDN 未加载）');
    if (!bc) throw new Error('缺少 bech32（CDN 未加载）');
    return { pk, hs, bc };
  }

  /** 等 index.html 的动态 import 把库挂上来；超时后交给 requireLib 自己报错 */
  function waitForLibs(timeoutMs = 8000) {
    return new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        window.removeEventListener('crypto-ready', check);
        resolve();
      };
      const check = () => {
        try { requireLib(); finish(); } catch (e) { /* 还没挂上，继续等 */ }
      };
      const timer = setTimeout(finish, timeoutMs);
      window.addEventListener('crypto-ready', check);
      check();
    });
  }

  const hexOf = (u8) => Array.from(u8).map((b) => b.toString(16).padStart(2, '0')).join('');
  const bytesOf = (hex) => Uint8Array.from(hex.match(/.{2}/g).map((x) => parseInt(x, 16)));

  /** secp256k1 压缩公钥 → paxi 地址（sha256 → ripemd160 → bech32） */
  function pubkeyToAddr(pubHex, prefix) {
    const { hs, bc } = requireLib();
    const sha = hs.sha256(bytesOf(pubHex));
    const rip = hs.ripemd160(sha);
    return bc.encode(prefix, bc.toWords(rip));
  }

  /** 生成会话密钥对（压缩公钥 33 字节） */
  function genKeyPair() {
    const { pk } = requireLib();
    const priv = pk.utils.randomPrivateKey
      ? pk.utils.randomPrivateKey()
      : globalThis.crypto.getRandomValues(new Uint8Array(32));
    return { privHex: hexOf(priv), pubHex: hexOf(pk.getPublicKey(priv, true)) };
  }

  /**
   * 对任意字节的 SHA-256 摘要做 secp256k1 签名，返回 64 字节 compact hex（r‖s）。
   *
   * 两个用途：
   * 1) signHash —— 会话授权原文（字符串 → UTF-8 字节）；
   * 2) **真无感交易** —— Cosmos SignDoc 签名 = Sign(SHA256(SignDoc 编码字节))，
   *    与 SDK secp256k1 验签一致（64 字节 compact，noble 默认 low-S）。
   *
   * 必须用 **signAsync**：@noble/secp256k1@2 的同步 sign 需要预置
   * etc.hmacSha256Sync，否则抛 "etc.hmacSha256Sync not set"。
   */
  async function signBytes(bytes, privHex) {
    await waitForLibs();
    const { pk, hs } = requireLib();
    const sha = hs.sha256(bytes);
    let sig;
    if (typeof pk.signAsync === 'function') {
      sig = await pk.signAsync(sha, bytesOf(privHex));
    } else if (typeof pk.sign === 'function') {
      sig = pk.sign(sha, bytesOf(privHex));
    } else {
      throw new Error('@noble/secp256k1 缺少签名接口');
    }
    let sigBytes;
    if (sig instanceof Uint8Array) sigBytes = sig;
    else if (typeof sig.toCompactRawBytes === 'function') sigBytes = sig.toCompactRawBytes();
    else if (sig && sig.r != null && sig.s != null) {
      const r = BigInt(sig.r).toString(16).padStart(64, '0');
      const s = BigInt(sig.s).toString(16).padStart(64, '0');
      sigBytes = bytesOf(r + s);
    } else {
      throw new Error('签名结果格式未知');
    }
    return hexOf(sigBytes);
  }

  async function signHash(message, privHex) {
    return signBytes(new TextEncoder().encode(message), privHex);
  }

  function sha256Hex(str) {
    const { hs } = requireLib();
    return hexOf(hs.sha256(new TextEncoder().encode(str)));
  }

  /**
   * 真实自检：真的跑一遍「生成密钥 → 签名」，而不是只看库在不在。
   * 旧实现只做 requireLib，库挂了但签名接口不兼容时仍会返回 true。
   */
  let _readyCache = null;
  async function ready() {
    // 只缓存成功；失败不缓存 —— CDN 慢加载/瞬时网络抖动后，下次调用还能重试
    if (_readyCache === true) return true;
    try {
      await waitForLibs();
      requireLib();
      const kp = genKeyPair();
      const sig = await signHash('selftest', kp.privHex);
      _readyCache = typeof sig === 'string' && sig.length === 128;
      if (!_readyCache) window.__hashError = '自检签名长度异常: ' + sig;
      return _readyCache;
    } catch (e) {
      window.__hashError = (e && e.message) || String(e);
      _readyCache = false;   // 不缓存 false，下次调用重试
      return false;
    }
  }

  window.CJHash = { pubkeyToAddr, genKeyPair, signHash, signBytes, sha256Hex, ready, hexOf, bytesOf };
})();

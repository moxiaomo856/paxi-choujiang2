/* =====================================================================
 * session.js —— 无感会话密钥（domain = "lottery"）
 *
 * 签名原文（必须与合约 build_sign_bytes 逐字一致）：
 *   "{chainId}:{contract}:{domain}:{action}:{roundId}:{amount}:{nonce}:{pubkeyHex}"
 * 哈希：裸 SHA-256（非 ADR-36）。
 *
 * 私钥存 localStorage（手机端 sessionStorage 切后台会被清空）。
 * 会话私钥 ≠ 主钱包私钥，泄漏仅影响 daily_limit 额度内资金，可随时 Revoke。
 * ===================================================================== */
(function () {
  const C = window.CJ_CONFIG;
  const K = window.CJChain;

  const STORE = window.localStorage;
  const LS = { priv: 'cj_sess_priv', pub: 'cj_sess_pub', addr: 'cj_sess_addr', nonce: 'cj_sess_nonce', user: 'cj_sess_user' };
  // 已知会话地址列表：本设备为该钱包创建过的全部会话地址。
  // 用途：开无感前把旧的统统撤销，防止反复开关无感时旧会话留在链上，
  // 慢慢堆到每钱包上限（MAX_SESSIONS_PER_USER = 5）后注册被拒。
  // ⚠️ 故意不放进 LS：clear() 只清"当前活跃会话"的私钥/地址等，
  // 这个清单必须跨「关无感/开无感」保留，否则关一次就丢一个孤儿。
  const LS_KNOWN = 'cj_sess_addrs';

  const state = {
    sessPriv: '',
    sessPubHex: '',
    sessAddr: '',
    sessNonce: 0,
    sessUser: '',
    enabled: false,
  };

  // 多站（tkcc / orion / pick / leo）共存时，同一个 origin 下的 localStorage
  // 是共享的：四站的会话键名完全相同，不加命名空间就会互相覆盖
  // （在 A 站开的无感会话被 B 站顶掉）。
  //   storageNs 为空（本站 tkcc）→ 键名与历史完全一致，老用户不掉线；
  //   其余三站带各自前缀 → 互不干扰。
  const NS = (C && C.storageNs) || '';

  // 按 应用 + 主钱包地址 隔离存储（换号不串会话、换站不串会话）
  const sk = (base) => base + (NS ? '@' + NS : '') + '__' + (K.wallet.address || 'anon');

  /** 升级清理：清掉旧格式 key（没有 __<addr> 后缀的遗留数据）
   *  模块加载时 K.wallet.address 为空，sk(b) 会得到 b__anon，从没被写过（persist 要 address）。
   *  真正需要清的是 localStorage 里直接以 LS 值为 key 的遗留条目。
   *  L-3：一次性标记统一放 META JSON 对象（避免散落 __cj_xxx / __cj_yyy 多键），
   *       META.key 带应用前缀，将来可扩展更多 flag。*/
  const META_KEY = '__cj_session_meta';
  function getMeta() {
    try { return JSON.parse(localStorage.getItem(META_KEY) || '{}'); } catch { return {}; }
  }
  function setMeta(key, val) {
    const m = getMeta(); m[key] = val;
    try { localStorage.setItem(META_KEY, JSON.stringify(m)); } catch {}
  }
  function _wipeLegacyLocalStorage() {
    if (getMeta().legacy_wiped) return;
    try {
      const prefixes = Object.values(LS);
      for (const k of Object.keys(localStorage)) {
        if (prefixes.includes(k)) localStorage.removeItem(k);
      }
      setMeta('legacy_wiped', Date.now());
    } catch (_) { /* 某些环境禁用 localStorage 也别炸 */ }
  }

  function persist() {
    if (!K.wallet.address) return;
    STORE.setItem(sk(LS.priv), state.sessPriv);
    STORE.setItem(sk(LS.pub), state.sessPubHex);
    STORE.setItem(sk(LS.addr), state.sessAddr);
    STORE.setItem(sk(LS.nonce), String(state.sessNonce));
    STORE.setItem(sk(LS.user), state.sessUser);
  }

  function restore() {
    if (!K.wallet.address) return false;
    state.sessPriv = STORE.getItem(sk(LS.priv)) || '';
    state.sessPubHex = STORE.getItem(sk(LS.pub)) || '';
    state.sessAddr = STORE.getItem(sk(LS.addr)) || '';
    state.sessNonce = Number(STORE.getItem(sk(LS.nonce)) || 0);
    state.sessUser = STORE.getItem(sk(LS.user)) || '';
    state.enabled = !!(state.sessPriv && state.sessAddr && state.sessUser === K.wallet.address);
    return state.enabled;
  }

  // ---------- 已知会话地址清单（跨开关保留，per 主钱包隔离） ----------
  function loadKnownAddrs() {
    try {
      const a = JSON.parse(STORE.getItem(sk(LS_KNOWN)) || '[]');
      return Array.isArray(a) ? a.filter((x) => typeof x === 'string' && x) : [];
    } catch { return []; }
  }
  function saveKnownAddrs(arr) {
    try { STORE.setItem(sk(LS_KNOWN), JSON.stringify(arr)); } catch { /* 禁 localStorage 也别炸 */ }
  }

  function clear() {
    Object.values(LS).forEach((b) => STORE.removeItem(sk(b)));
    _wipeLegacyLocalStorage();
    state.sessPriv = state.sessPubHex = state.sessAddr = state.sessUser = '';
    state.sessNonce = 0;
    state.enabled = false;
  }

  /**
   * 把会话账户里没用完的 gas 扫回主钱包。
   *
   * gas 是注册时直接 BankSend 到会话地址的，合约不代管、也不会自动退；
   * 而每次开启无感都是全新密钥对 / 新地址，不扫回就等于这笔钱沉睡在
   * 一次性地址上。私钥只存在本机 localStorage，所以只有关之前能扫。
   *
   * 预留扫码这笔交易自己的手续费，余额不够付手续费就不扫（避免交易失败）。
   * @returns {Promise<string>} 实际扫回的金额（raw upaxi）；未扫回为 '0'
   */
  async function sweepGasBack() {
    if (!state.enabled || !state.sessAddr || !state.sessPriv) return '0';
    if (!K.wallet.address) return '0';
    if (!K.executeRawViaSession || !K.buildMsgSendAny) return '0';

    let bal = 0n;
    try {
      bal = BigInt(String((await K.getBankUpaxi(state.sessAddr)) || '0'));
    } catch (_) { return '0'; }
    if (bal <= 0n) return '0';

    // 手续费按 defaultGas × gasPrice 估算，留 1.5 倍冗余
    const gas = Number(C.defaultGas || 600000);
    const fee = BigInt(Math.ceil(gas * (C.gasPrice || 0.05) * 1.5));
    const send = bal - fee;
    if (send <= 0n) return '0';

    const any = K.buildMsgSendAny(
      state.sessAddr, K.wallet.address, send.toString(), C.coinMinimalDenom
    );
    await K.executeRawViaSession([any], { gas, memo: 'sweep session gas back' });
    return send.toString();
  }

  /**
   * 关闭无感：先扫回剩余 gas → 再撤销链上会话 → 最后清本地。
   * 任一步失败都不影响"关掉"这个结果（被动撤销由 RegisterSession 自清理兜底）。
   * @returns {Promise<string>} 扫回金额（raw upaxi），未扫回为 '0'
   */
  async function disable() {
    let swept = '0';
    try {
      swept = await sweepGasBack();
    } catch (_) { /* 扫回失败不阻断关闭：钱还在会话地址，私钥仍在本地 */ }
    if (state.sessAddr) {
      try {
        await K.execute(
          { revoke_session: { session_addr: state.sessAddr } },
          [],
          { gas: 300000, memo: 'revoke session' }
        );
      } catch (_) { /* 已过期/已撤销都无所谓 */ }
    }
    clear();
    return swept;
  }

  // 模块加载即清一次 legacy
  _wipeLegacyLocalStorage();

  /** 开启无感（唯一一次弹钱包） */
  async function enable() {
    if (!K.wallet.address) await K.connect();
    if (!window.CJHash || !(await window.CJHash.ready())) {
      throw new Error('加密库未就绪（secp256k1 / hashes / bech32 CDN 未加载）');
    }

    // 注册新会话前，撤销本设备记录过的**全部**旧会话（不止最新 1 个）：
    // 反复开关无感时，旧会话若不撤销会一直留在链上占名额，堆满 5 个后
    // RegisterSession 会被 "Too many active sessions" 拒绝。
    // 逐个独立撤销 + try/catch：旧会话已过期/已撤销/网络抖动都无所谓；
    // 不能把撤销合进注册那笔多消息交易——Cosmos 交易是原子的，一条
    // revoke 失败会让整笔回滚，注册也跟着失败。
    const known = loadKnownAddrs();
    for (const old of known) {
      try {
        await K.execute(
          { revoke_session: { session_addr: old } },
          [],
          { gas: 300000, memo: 'revoke old session' }
        );
      } catch (_) { /* 旧会话已过期/已撤销都无所谓 */ }
    }
    // 旧的都尝试撤过了，清掉本地"当前活跃会话"状态（旧私钥不再使用）
    clear();

    const { privHex, pubHex } = window.CJHash.genKeyPair();
    const sessAddr = window.CJHash.pubkeyToAddr(pubHex, C.bech32Prefix);

    const msg = {
      register_session: {
        session_addr: sessAddr,
        pubkey: pubHex,
        daily_limit: String(C.sessionDailyLimit || '1000000000000'),
      },
    };

    // 一笔交易同时完成「注册会话」+「给会话账户充 gas」：
    // 之后参与 / 建池由会话私钥本地签名广播（真无感，不弹钱包），
    // gas 从会话账户扣。每次开启都是新密钥对 → 新地址必然要充。
    let res;
    const gasFund = String(C.sessionGasFund || '2000000');
    if (K.executeRaw && K.buildExecAny && typeof PaxiCosmJS !== 'undefined') {
      const anys = [
        K.buildExecAny(K.wallet.address, C.contract, msg, []),
        K.buildMsgSendAny(K.wallet.address, sessAddr, gasFund, C.coinMinimalDenom),
      ];
      res = await K.executeRaw(anys, { gas: 600000, memo: 'register session (+gas)' });
    } else {
      // 老加载环境兜底：仅注册（会话路径会因无 gas 自动回退钱包签名）
      res = await K.execute(msg, [], { gas: 400000, memo: 'register session' });
    }
    if (res.code !== 0) throw new Error(res.rawLog || '注册会话失败');

    state.sessPriv = privHex;
    state.sessPubHex = pubHex;
    state.sessAddr = sessAddr;
    state.sessUser = K.wallet.address;
    state.sessNonce = 0;
    state.enabled = true;
    persist();
    // 旧的都撤了，清单只留新会话（注册失败抛错时不动清单，下次重试还能补撤）
    saveKnownAddrs([sessAddr]);
    return sessAddr;
  }

  /** 从链上同步 nonce（以链上为准，避免本地计数漂移） */
  async function syncNonce() {
    if (!state.sessAddr) return 0;
    try {
      const res = await K.queryContract({ session: { session_addr: state.sessAddr } });
      if (res && res.info) {
        state.sessNonce = Number(res.info.nonce || 0);
        persist();
      } else {
        // 会话不存在（被撤销 / 过期）→ 清掉本地存储并关闭无感。
        // 只置 enabled = false 不够：storage 里还留着 session，下次连接
        // restore() 会把它恢复出来，每次连接都对死会话空试一轮。
        clear();
      }
    } catch (e) {
      /* 查询失败时沿用本地 nonce */
    }
    return state.sessNonce;
  }

  /**
   * 签名原文（第一段 chainId 必须**与交易签名同源**）。
   *
   * P3-1：原先这里用 config.js 的硬编码 `C.chainId`，而 chain.js 取链上值。
   * 两者目前都是 `paxi-mainnet` 所以看不出问题；一旦链改名或换链，交易能正常
   * 发出、会话验签却会全量失败，且很难定位。统一走 `K.getChainId()`。
   */
  async function buildMessage(action, roundId, amount, nonce) {
    return [
      await K.getChainId(),
      C.contract,
      C.signDomain,
      action,
      String(roundId === undefined || roundId === null ? '0' : roundId),
      String(amount === undefined || amount === null ? '0' : amount),
      String(nonce),
      state.sessPubHex,
    ].join(':');
  }

  /**
   * 给 ExecuteMsg 注入 auth 字段。
   * @param {object} execMsg 原始消息，如 { join_lottery: { id: 1 } }
   * @param {string} action  合约校验用的 action 名
   * @param {string} roundId 业务轮次（抽奖 ID / "0"）
   * @param {string} amount  本次扣费金额（raw，进签名原文）
   */
  async function signPayload(execMsg, action, roundId, amount) {
    if (!state.enabled) throw new Error('未开启无感会话');
    const nonce = state.sessNonce;
    const message = await buildMessage(action, roundId, amount, nonce);
    const signature = await window.CJHash.signHash(message, state.sessPriv);

    const key = Object.keys(execMsg)[0];
    const payload = {
      ...execMsg,
      [key]: { ...execMsg[key], auth: { session_addr: state.sessAddr, nonce, signature } },
    };

    // 本地先自增；交易失败时调用 rollbackNonce()
    state.sessNonce = nonce + 1;
    persist();
    return { payload, nonce, signature, message };
  }

  /** 交易失败后回滚 nonce */
  function rollbackNonce() {
    state.sessNonce = Math.max(0, state.sessNonce - 1);
    persist();
  }

  window.CJSession = { state, enable, disable, sweepGasBack, clear, restore, persist, syncNonce, signPayload, rollbackNonce, buildMessage };
})();

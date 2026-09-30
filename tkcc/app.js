/* =====================================================================
 * app.js —— 抽奖前端 UI 逻辑（4 tab：奖池 / 创建 / 我的 / 管理）
 * ===================================================================== */
(function () {
  const C = window.CJ_CONFIG;
  const K = window.CJChain;
  const S = window.CJSession;
  const L = window.CJLottery;
  // i18n.js 万一没加载（网络/缓存问题），退化成"原文直出"，绝不能因此让整个应用起不来
  const T = (window.CJ_I18N && window.CJ_I18N.t) || ((k) => k);
  const LANG = () => (window.CJ_I18N && window.CJ_I18N.getLang()) || 'zh';

  const $ = (id) => document.getElementById(id);
  const log = (msg) => {
    const el = $('log');
    el.textContent = `[${new Date().toLocaleTimeString(LANG() === 'zh' ? 'zh-CN' : 'en-US')}] ${msg}\n` + el.textContent;
  };
  const UNCLAIMED_MAX = 30;   // 已开奖池的"未领奖"查询上限（轮询性能）

  /** 并发受限的 map：LCD 查询并发太高会被限流，8 路并发是稳妥值。
   *  串行 await 循环查 200 个池要几十秒，并行化后首屏扫描能快一个数量级。 */
  async function mapLimit(items, limit, fn) {
    const arr = Array.isArray(items) ? items : [];
    let i = 0;
    const n = Math.max(1, Math.min(limit, arr.length));
    const workers = [];
    for (let w = 0; w < n; w++) {
      workers.push((async () => {
        while (i < arr.length) {
          const idx = i++;
          await fn(arr[idx], idx);
        }
      })());
    }
    await Promise.all(workers);
  }

  const escapeHtml = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // ---------- Banner ----------
  const _bannerKind = { _k: 'info' };
  const banner = (msg, kind) => {
    const el = $('banner');
    // 清掉上一次挂的 onclick / cursor（深链分支会把 banner 变成可点跳 paxi://，
    // 不清的话之后任何错误提示点一下都会误跳）
    el.onclick = null;
    el.style.cursor = '';
    if (!msg) {
      if (_bannerKind._k !== 'info') return;   // 只清 info，错误提示不被轮询冲掉
      el.hidden = true;
      return;
    }
    _bannerKind._k = kind || 'info';
    el.hidden = false;
    el.className = 'banner ' + _bannerKind._k;
    el.textContent = msg;
  };

  /** 通用地址脱敏：paxi1q…k9x2（保留头尾）。
   *  中奖名单/参与者列表另有更强的中间脱敏 maskMiddle12（含自己也脱敏）。 */
  function maskAddr(addr, head = 8, tail = 6) {
    const s = String(addr || '');
    if (!s) return '';
    if (head + tail >= s.length) return s;
    return `${s.slice(0, head)}…${s.slice(-tail)}`;
  }

  /**
   * 中奖名单专用脱敏：固定隐藏中间 12 位，前后各留一半明文。
   * 例：paxi1qyx…（44 位地址 → 前 16 + 中间 12 隐藏 + 后 16）
   * 太短的地址退化为通用脱敏。所有人统一处理（含自己），点击仍可复制完整地址。
   */
  function maskMiddle12(addr) {
    const s = String(addr || '');
    if (!s) return '';
    const visible = s.length - 12;
    if (visible < 10) return maskAddr(s, 8, 6);
    const head = Math.ceil(visible / 2);
    const tail = visible - head;
    return `${s.slice(0, head)}…${s.slice(-tail)}`;
  }

  /**
   * 轻量 Toast。Banner 负责"持续存在的状态/错误"，Toast 负责"一闪而过的反馈"。
   * 之前复制、领奖、建池成功都去占 Banner，会把真正的错误提示顶掉。
   */
  function toast(msg, kind = 'info', ms = 2800) {
    if (!msg) return;
    let wrap = $('toastWrap');
    if (!wrap) {
      wrap = document.createElement('div');
      wrap.id = 'toastWrap';
      wrap.className = 'toast-wrap';
      document.body.appendChild(wrap);
    }
    const el = document.createElement('div');
    el.className = 'toast ' + kind;
    el.textContent = msg;
    wrap.appendChild(el);
    requestAnimationFrame(() => el.classList.add('show'));
    setTimeout(() => {
      el.classList.remove('show');
      setTimeout(() => el.remove(), 220);
    }, ms);
  }

  /**
   * 把合约 / 链上返回的英文错误，映射成用户能看懂的中英文提示。
   * 合约错误被 cosmwasm 包成 "failed to execute message; message index: 0: <详情>: execute wasm contract failed"，
   * 所以用子串 / 关键字匹配，而不是靠精确的错误类名。找不到对应项就返回 null（沿用原文）。
   */
  function mapContractError(msg) {
    // 顺序敏感：靠前的优先匹配。每个子串都来自 error.rs 的 #[error(...)] 实际输出。
    const rules = [
      // ⚠️ 节点侧故障必须排在最前：这些文案由 chain.js 抛出（LCD 5xx / 超时 /
      // 账户查询失败），不含合约关键字，但一旦落到下面的宽规则里就会被误读成
      // "你的余额不足""你的操作有问题"。用户需要的是"稍后重试"。
      [/(链上节点暂时不可用|node unavailable)/i, 'err.nodeUnavailable'],
      [/(尚未在链上初始化|account_number)/i,     'err.accountNotInit'],
      [/(already joined)/i,                     'err.alreadyJoined'],
      [/(not open for joining)/i,                'err.lotteryNotOpen'],
      [/(creator cannot join)/i,                 'err.creatorCannotJoin'],
      [/(not a participant)/i,                   'err.notParticipant'],
      [/(already expired|expired at)/i,          'err.lotteryExpired'],
      [/(has not expired yet)/i,                 'err.notExpired'],
      [/(already refunded)/i,                    'err.alreadyRefunded'],
      [/(already has refunds)/i,                 'err.refundStarted'],
      [/(already claimed)/i,                     'err.alreadyClaimed'],
      [/(nothing to claim)/i,                    'err.nothingToClaim'],
      [/(already drawn)/i,                       'err.alreadyDrawn'],
      [/(not full yet)/i,                        'err.lotteryNotFull'],
      [/(not enough participants)/i,             'err.notEnoughParticipants'],
      [/(is not a winner)/i,                     'err.notWinner'],
      [/(committed a secret but never revealed)/i, 'err.commitNotRevealed'],
      [/(no committed secret)/i,                 'err.templateCommit'],
      [/(insufficient balance|insufficient funds)/i, 'err.insufficientBalance'],
      [/(too many active sessions)/i,            'err.sessionLimit'],
      [/(session not found|invalid signature|nonce mismatch)/i, 'err.sessionError'],
      [/(out of gas|gas insufficient|insufficient fee)/i, 'err.gasError'],
      [/(contract is paused)/i,                  'err.paused'],
      [/(unauthorized)/i,                        'err.unauthorized'],
      [/(must be greater than zero)/i,            'err.zeroAmount'],
      [/(multisig required)/i,                   'err.multisig'],
      // 合约 "Invalid tier N: must be 0 (5 people) / 1 (20 people) / 2 (50 people)"
      // 前端已按合约版本门控档位（见 availableTiers），这里是兜底：
      // 万一版本探测失败漏了，也给用户一句可读中文，而不是裸英文。
      [/(invalid tier)/i,                        'err.invalidTier'],
    ];
    for (const [re, key] of rules) {
      if (re.test(msg)) return T(key);
    }
    return null;
  }

  function fail(e, prefix) {
    const msg = (e && e.message) ? e.message : String(e);
    const friendly = mapContractError(msg);
    if (e && e.needSession) {
      const b = $('btnSession');
      b.hidden = false;
      b.classList.add('primary');
      b.classList.remove('ghost');
      b.textContent = T('wallet.openSession');
      refreshSessionCard();
    }
    // 日志记原文（方便排查），横幅显示友好提示（找不到则回退原文）
    log((prefix ? prefix + '：' : '') + msg);
    banner(friendly || msg, 'err');
  }

  // ---------- 手机端防双击 ----------
  // 触屏连点会发出两笔交易（双倍扣费）。全局锁：有交易在途时拦截新操作。
  let txBusy = false;

  /** 等交易库就位（cosmjs 2.6MB 是后台异步加载的） */
  function waitCosmjs(ms = 20000) {
    return new Promise((resolve) => {
      if (typeof PaxiCosmJS !== 'undefined') return resolve(true);
      const t0 = Date.now();
      const iv = setInterval(() => {
        if (typeof PaxiCosmJS !== 'undefined') { clearInterval(iv); resolve(true); }
        else if (Date.now() - t0 > ms) { clearInterval(iv); resolve(false); }
      }, 200);
    });
  }

  async function guardBusy(btn, fn) {
    if (txBusy) {
      banner(T('common.busy'), 'warn');
      return;
    }
    if (typeof PaxiCosmJS === 'undefined') {
      banner(T('common.libLoading'), 'info');
      const ok = await waitCosmjs();
      if (!ok) {
        banner(T('common.libFail'), 'err');
        return;
      }
      banner('');
    }
    txBusy = true;
    // 存 innerHTML：领奖按钮是图标+文字，只还原 textContent 会丢掉图标
    const origHtml = btn ? btn.innerHTML : '';
    if (btn) { btn.disabled = true; btn.textContent = T('common.processing'); }
    try {
      await fn();
    } finally {
      txBusy = false;
      if (btn) { btn.disabled = false; btn.innerHTML = origHtml; }
    }
  }

  // ---------- 复制 ----------
  async function copyText(text, label) {
    const s = String(text == null ? '' : text);
    if (!s) return;
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(s);
      } else {
        const ta = document.createElement('textarea');
        ta.value = s;
        ta.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0;';
        document.body.appendChild(ta);
        ta.focus(); ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
      }
      toast(T('common.copyOk', { label: label ? ' ' + label : '' }), 'info', 1600);
    } catch (e) {
      toast(T('common.copyFail'), 'warn');
    }
  }
  function copyable(text, label, display) {
    const t = String(text == null ? '' : text);
    const d = display == null ? t : String(display);
    return `<span class="copyable" data-copy="${escapeHtml(t)}" data-copy-label="${escapeHtml(label || '')}">${escapeHtml(d)}</span>`;
  }
  document.addEventListener('click', (e) => {
    const el = e.target.closest && e.target.closest('[data-copy]');
    if (!el) return;
    e.preventDefault();
    copyText(el.dataset.copy, el.dataset.copyLabel || '');
  });

  // ---------- 全局状态 ----------
  let tkccInfo = { token: '', decimals: C.tkccDecimals, configured: false };
  let tkccResolved = false;     // refreshTkcc 是否已成功从链上解析过 TKCC 信息
  let isAdmin = false;
  let adminFromChain = false;
  let chainAdmins = [];
  let chainThreshold = 0;
  let currentTab = 'pools';
  let allPools = [];
  let selectedTier = Number(C.defaultTier || 0);
  let refreshing = false;
  let sharedPoolId = null;      // 从分享链接解析出的目标奖池
  let poolsLoaded = false;      // 首次加载用骨架屏
  // 内部余额（raw，字符串），用于"余额不足"预检
  let balPaxiRaw = '0';
  let balTkccRaw = '0';
  let myJoinedIds = new Set();      // 我参与过的池 id（列表打"已参与"标）
  let pendingClaims = [];           // 待领奖（奖池页顶部展示）
  // 奖池视图缓存（id → view）：奖池页与我的页都会写入，
  // 按钮操作从这里取，避免在我的页点到奖池页列表里没有的池（如已退款池）
  let poolCache = new Map();
  // 终态数据缓存（性能关键）：
  //   - participantsCache：池子一旦"冻结"（满员/已开奖/已退款/已取消/已截止），
  //     参与者名单**永远不再变化** → 查一次永久缓存；
  //   - unclaimedCache：drawn 池的未领名单只在有人领奖时变化 → 缓存，
  //     领奖成功时按 id 失效（onAction claim 分支）。
  // 没有这两个缓存，"我的"页每 10 秒轮询会串行打 2×N 个 LCD 查询，池子一多必卡。
  const participantsCache = new Map();  // id → bool（仅冻结池）
  const unclaimedCache = new Map();     // id → pending 数组（仅 drawn 池）

  // =====================================================================
  // 本地统计 / 成就（纯 localStorage，不涉及链上，不影响合约）
  // =====================================================================
  // 多站（tkcc / orion / pick / leo）共用同一个 origin → localStorage 是共享的，
  // 不加命名空间四站的统计 / 成就 / 提案 / 密钥会互相污染。见 config.js 的 storageNs。
  const NS = (C && C.storageNs) || '';
  const nsKey = (k) => (NS ? k + '@' + NS : k);

  const STATS_KEY = nsKey('cj_stats_v1');
  const ACH_KEY   = nsKey('cj_achievements_v1');
  const WINS_KEY  = nsKey('cj_counted_wins_v1');   // 已计入"中奖"统计的池 id，防重复累加

  function loadJSON(key) { try { return JSON.parse(localStorage.getItem(key) || '{}') || {}; } catch (_) { return {}; } }
  function saveJSON(key, val) { try { localStorage.setItem(key, JSON.stringify(val)); } catch (_) {} }

  const ACH_LIST = [
    { id: 'firstConnect', key: 'connect', need: 1,  icon: '🔌' },
    { id: 'firstJoin',    key: 'join',    need: 1,  icon: '🎯' },
    { id: 'firstCreate',  key: 'create',  need: 1,  icon: '🏗️' },
    { id: 'firstWin',     key: 'win',     need: 1,  icon: '🏆' },
    { id: 'firstClaim',   key: 'claim',   need: 1,  icon: '💰' },
    { id: 'tenJoins',     key: 'join',    need: 10, icon: '🎖️' },
    { id: 'threeWins',    key: 'win',     need: 3,  icon: '👑' },
    { id: 'fiveCreates',  key: 'create',  need: 5,  icon: '🧱' },
  ];

  function bumpStat(key, n = 1) {
    const s = loadJSON(STATS_KEY);
    s[key] = (Number(s[key]) || 0) + n;
    saveJSON(STATS_KEY, s);
    checkAchievements(s);
  }

  function checkAchievements(stats) {
    const got = loadJSON(ACH_KEY);
    const fresh = [];
    for (const it of ACH_LIST) {
      if (got[it.id]) continue;
      if ((Number(stats[it.key]) || 0) >= it.need) {
        got[it.id] = Date.now();
        fresh.push(it);
      }
    }
    if (!fresh.length) return;
    saveJSON(ACH_KEY, got);
    // 错开一点再弹，避免和"操作成功"的 Toast 撞车
    fresh.forEach((it, i) => {
      setTimeout(() => toast(`${it.icon} ${T('ach.' + it.id)}`, 'info', 4000), 300 + i * 500);
    });
  }

  /** 中奖只计一次：用「poolId:名次」集合去重，否则每次轮询都会 +1 */
  function countWinOnce(v, me) {
    if (!v.winners || v.status !== 'drawn' || !me) return false;
    const isFirst  = (v.winners.first  || []).includes(me);
    const isSecond = (v.winners.second || []).includes(me);
    if (!isFirst && !isSecond) return false;
    const counted = loadJSON(WINS_KEY);
    const k = `${v.id}:${isFirst ? '1' : '2'}`;
    if (counted[k]) return false;
    counted[k] = Date.now();
    saveJSON(WINS_KEY, counted);
    bumpStat('win');
    return true;
  }

  /** 扫一批池，把自己中奖的池计入统计（countWinOnce 内部去重，重复/轮询调用都安全） */
  function scanWins(list) {
    const me = K.wallet.address;
    if (!me || !Array.isArray(list)) return;
    for (const v of list) countWinOnce(v, me);
  }

  function renderStats() {
    const box = $('statsBox');
    if (!box) return;
    const s = loadJSON(STATS_KEY);
    const ach = loadJSON(ACH_KEY);
    const badges = ACH_LIST.map((it) =>
      `<span class="ach ${ach[it.id] ? 'got' : ''}" title="${escapeHtml(T('ach.' + it.id))}">${it.icon}</span>`
    ).join('');
    box.innerHTML = `
      <div class="stats-grid">
        <div class="stat"><div class="k">${T('me.statJoined')}</div><div class="v">${s.join || 0}</div></div>
        <div class="stat"><div class="k">${T('me.statCreated')}</div><div class="v">${s.create || 0}</div></div>
        <div class="stat"><div class="k">${T('me.statWon')}</div><div class="v">${s.win || 0}</div></div>
        <div class="stat"><div class="k">${T('me.statClaim')}</div><div class="v">${s.claim || 0}</div></div>
      </div>
      <div class="ach-row">
        <span class="ach-label">${T('me.achievements')}</span>${badges}
      </div>`;
  }

  // =====================================================================
  // Tab 切换
  // =====================================================================
  function switchTab(name) {
    currentTab = name;
    document.querySelectorAll('.page').forEach((el) => {
      el.hidden = el.id !== 'page-' + name;
    });
    document.querySelectorAll('.tabbar .tab').forEach((b) => {
      b.classList.toggle('active', b.dataset.tab === name);
    });
    window.scrollTo({ top: 0, behavior: 'smooth' });

    if (name === 'me')    refreshMyPage().catch(() => {});
    if (name === 'admin') refreshAdminPage().catch(() => {});
    if (name === 'pools') refreshPools().catch(() => {});
    if (name === 'create') { updateCostBox(); refreshSeedPreview(); }
  }
  document.querySelectorAll('.tabbar .tab').forEach((b) => {
    b.onclick = () => switchTab(b.dataset.tab);
  });

  // =====================================================================
  // 无感引导卡片
  // =====================================================================
  function refreshSessionCard() {
    const card = $('sessionCard');
    if (!card) return;
    if (!K.wallet.address) {
      card.hidden = false;
      $('sessionCardTitle').textContent = T('sessCard.titleConnect');
      $('sessionCardDesc').textContent  = T('sessCard.descConnect');
      $('btnSessionCard').textContent   = T('sessCard.btnConnect');
      $('btnSessionCard').onclick       = () => guardBusy($('btnSessionCard'), () => onConnect());
      return;
    }
    if (S.state.enabled) {
      card.hidden = true;
      return;
    }
    card.hidden = false;
    $('sessionCardTitle').textContent = T('sessCard.titleEnable');
    $('sessionCardDesc').textContent  = T('sessCard.descEnable');
    $('btnSessionCard').textContent   = T('sessCard.btnEnable');
    $('btnSessionCard').onclick       = () => guardBusy($('btnSessionCard'), () => onSession());
  }

  // =====================================================================
  // 钱包 / 会话
  // =====================================================================
  async function onConnect() {
    const addr = await K.connect();
    bumpStat('connect');
    $('addr').innerHTML = copyable(addr, '地址', addr.slice(0, 10) + '…' + addr.slice(-6));
    $('btnSession').hidden = false;
    // 清掉连接前遗留的错误横幅（注入完成前点过连接会留下误导性报错）
    _bannerKind._k = 'info';
    banner('');

    if (!(window.CJHash && (await window.CJHash.ready()))) {
      // 把底层失败原因一并带出来：加密栈（secp256k1 / hashes / bech32）加载失败时，
      // 只显示一句"加密库失败"用户无从自查；window.__hashError 里存着具体原因。
      const reason = window.__hashError ? '（' + window.__hashError + '）' : '';
      banner(T('msg.cryptoLibFail') + reason, 'warn');
    }
    if (S.restore()) {
      await S.syncNonce();
      if (S.state.enabled) {
        $('sessTag').hidden = false;
        $('btnSession').textContent = T('wallet.closeSession');
      } else {
        $('sessTag').hidden = true;
        $('btnSession').textContent = T('wallet.openSession');
        log(T('msg.sessionExpired'));
      }
    }
    await detectAdmin();
    refreshSessionCard();
    await refreshTkcc(true).catch(() => {});
    await refreshBalance().catch(() => {});
    await refreshPools().catch(() => {});
    log(T('msg.connected', { addr }));
    autoEnableTkcc().catch(() => {});
  }

  async function detectAdmin() {
    try {
      const res = await K.queryContract({ admins: {} });
      chainAdmins = res.admins || [];
      chainThreshold = res.threshold || 0;
      isAdmin = chainAdmins.includes(K.wallet.address);
      adminFromChain = true;
    } catch (e) {
      isAdmin = (C.admins || []).includes(K.wallet.address);
      adminFromChain = false;
    }
    $('tabAdmin').hidden = !isAdmin;
  }

  function renderAdmins() {
    const list = adminFromChain && chainAdmins.length ? chainAdmins : (C.admins || []);
    const sep = LANG() === 'zh' ? '、' : ', ';
    const listStr = list.length ? list.join(sep) : '—';
    $('adminsStatus').textContent = T('msg.adminsLine', {
      src: adminFromChain ? T('msg.statusOnchain') : T('msg.statusFallback'),
      t: chainThreshold || C.multisigThreshold,
      list: listStr,
    });
  }

  async function onSession() {
    if (S.state.enabled) {
      // 关闭前把会话账户里没用完的 gas 扫回主钱包（不扫就沉睡在一次性地址上）
      const swept = await S.disable().catch(() => '0');
      $('sessTag').hidden = true;
      $('btnSession').textContent = T('wallet.openSession');
      log(T('msg.sessionClosed'));
      toast(T('msg.sessionClosed'), 'info');
      if (BigInt(swept || '0') > 0n) {
        toast(T('msg.sessionSwept', { v: L.fmtPaxi(swept) }), 'info', 3600);
      }
      refreshSessionCard();
      return;
    }
    try {
      const a = await S.enable();
      $('sessTag').hidden = false;
      $('btnSession').textContent = T('wallet.closeSession');
      log(T('msg.sessionOpened', { addr: a }));
      banner(T('msg.sessionOpenedBanner', { h: C.sessionTtlHours || 24, g: (Number(C.sessionGasFund || 300000) / 1e6).toFixed(2) }), 'info');
      refreshSessionCard();
      if (currentTab === 'me') refreshSessionStatus().catch(() => {});
    } catch (e) {
      // 开无感失败（含合约 "Too many active sessions" 等业务拒绝）：
      // 之前没接 fail()，合约报错直接裸奔；现在走友好映射 + 日志留原文
      fail(e, T('err.enableSession'));
      refreshSessionCard();
    }
  }

  // =====================================================================
  // TKCC / 余额
  // =====================================================================
  /**
   * 仅重渲 TKCC 相关的**本地文案**（不发起链上查询）。
   *
   * refreshTkcc 内部会 await L.resolveTkcc()，decimals 未缓存时会打 LCD；
   * 而切换语言是纯本地操作，不该顺带发网络请求（慢节点会把 UI 卡住）。
   * 因此把"画界面"与"查链"拆开：切语言只调这里。
   */
  function renderTkccUI() {
    $('balTkccLabel').textContent = tkccInfo.symbol || SYM();
    $('tkccStatus').textContent = tkccInfo.token
      ? T('msg.tkccStatusLine', {
          addr: tkccInfo.token,
          symbol: tkccInfo.symbol,
          d: tkccInfo.decimals,
          on: tkccInfo.configured ? T('common.yes') : T('common.no'),
        })
      : T('msg.tkccStatusEmpty');

    const btn = $('btnSetTkcc');
    if (btn) {
      btn.textContent = tkccInfo.configured ? T('admin.rewriteTkcc') : T('admin.enableTkcc');
      btn.classList.toggle('ghost', tkccInfo.configured);
      btn.classList.toggle('primary', !tkccInfo.configured);
    }
  }

  async function refreshTkcc(quiet) {
    try {
      tkccInfo = await L.resolveTkcc();
      tkccResolved = true;
      renderTkccUI();

      if (tkccInfo.burnMode) $('burnMode').value = tkccInfo.burnMode;
      if (tkccInfo.burnAddress && !$('burnAddr').value) $('burnAddr').value = tkccInfo.burnAddress;

      if (quiet) return;
      if (tkccInfo.configured) banner('');
      else if (isAdmin && tkccInfo.token) banner(T('msg.tkccNotConfiguredAdmin'), 'warn');
      else banner(T('msg.tkccNotConfigured'), 'warn');
    } catch (e) {
      if (!quiet) banner(e.message || String(e), 'err');
    }
  }

  async function refreshBalance() {
    if (!K.wallet.address) return;
    // 硬依赖兜底：下面用 tkccInfo.token 决定 TKCC 余额查询方式。
    // 正常路径 onConnect 已先 refreshTkcc，但若将来有人在前面插入耗时代码
    // 或直接从"我的"页进入，tkccInfo 还没解析时 TKCC 余额会静默显示为 0。
    if (!tkccResolved) await refreshTkcc(true).catch(() => {});
    // 不解析 Balances 列表猜 native key（旧代码假设空字符串，实际可能不是），
    // 改成各查一次：PAXI 用 token=null，TKCC 用显式地址。
    try {
      const p = await L.balance(K.wallet.address, null);
      balPaxiRaw = String(p.balance || '0');
      $('balPaxi').textContent = L.fmtPaxi(balPaxiRaw);
    } catch (e) { /* 忽略 */ }
    try {
      if (tkccInfo.token) {
        const t = await L.balance(K.wallet.address, tkccInfo.token);
        balTkccRaw = String(t.balance || '0');
        $('balTkcc').textContent = L.fmtTkcc(balTkccRaw, tkccInfo.decimals);
      } else {
        balTkccRaw = '0';
        $('balTkcc').textContent = '—';
      }
    } catch (e) { /* 忽略 */ }
    try {
      const bank = await K.getBankBalances(K.wallet.address);
      const p = bank.find((b) => b.denom === C.coinMinimalDenom);
      $('bankPaxi').textContent = L.fmtPaxi(p ? p.amount : '0');
    } catch (e) { /* 忽略 */ }
    updateCostBox();
  }

  // =====================================================================
  // 奖池：刷新 + 渲染
  // =====================================================================
  function showSkeleton() {
    $('list').innerHTML = [0, 1, 2].map(() =>
      '<div class="skeleton"><i class="w40"></i><i class="w70"></i><i class="w40"></i></div>'
    ).join('');
  }

  /**
   * 批量加载已开奖池的「未领奖名单」（写回每个池的 `_unclaimed`）。
   *
   * 三条硬性约束，各自对应一个曾经真实发生的 bug：
   * 1. **我中奖的池必查**，不受 UNCLAIMED_MAX 截断影响 —— 少查一个池，
   *    那个中奖者的卡片就永远停在"加载中"、顶部待领奖区块也永不命中，
   *    这是真金白银的漏报，绝不能因为"性能优化"被切掉。
   * 2. **失败不写缓存** —— LCD 抖动一次就把 pending 缓存成 []，之后每次
   *    刷新都读这个空数组，中奖者再也等不到提示（缓存是模块级 Map，
   *    只有整页刷新才重建）。失败就留 undefined，下次轮询自动重试。
   * 3. **并发而非串行** —— 几十个已开奖池串行 await 要跑几十秒，
   *    10 秒一轮的轮询根本跑不完，列表永远处于"追不上"的状态。
   */
  async function loadUnclaimed(pools) {
    const drawn = (pools || []).filter((x) => x && x.status === 'drawn');
    if (!drawn.length) return;

    const me = K.wallet.address;
    const mine = [];
    const rest = [];
    for (const l of drawn) {
      const w = l.winners;
      const iWon = !!me && !!w &&
        ((w.first || []).includes(me) || (w.second || []).includes(me));
      (iWon ? mine : rest).push(l);
    }

    await mapLimit(mine.concat(rest.slice(0, UNCLAIMED_MAX)), 8, async (l) => {
      if (unclaimedCache.has(l.id)) { l._unclaimed = unclaimedCache.get(l.id); return; }
      try {
        const un = await L.unclaimed(l.id);
        l._unclaimed = (un && un.pending) || [];
        unclaimedCache.set(l.id, l._unclaimed);
      } catch (_) {
        l._unclaimed = undefined;   // 明确留空 = "还没查到"，下次自动重试
      }
    });
  }

  async function refreshPools() {
    if (refreshing) return;
    refreshing = true;
    try {
      if (!poolsLoaded) showSkeleton();
      const mode = $('fStatus').value || '';
      const status = (mode === '' || mode === 'all') ? null : mode;
      const res = await L.lotteries(status, 100);
      // Bug-1：模板池是否展示由 config.js 的 showTemplatePools 决定。
      // 之前这里是写死的 `!l.is_template_pool`，配置改了也不生效（死配置）。
      // 现在支持三态：'admin' 仅管理员地址可见 ｜ true 所有人 ｜ false 彻底关闭。
      const list = tplPoolsVisible()
        ? (res.lotteries || [])
        : (res.lotteries || []).filter((l) => !l.is_template_pool);

      // 已开奖池要查"谁还没领"：优先用缓存（领奖成功时失效），轮询零重复查询。
      //
      // Bug-2：旧实现 `.slice(0, UNCLAIMED_MAX)` 会把第 31 个及之后的已开奖池
      // 整段截断，这些池的 `_unclaimed` 永远停在 undefined → 卡片恒显"加载中"、
      // pendingClaims 也永不命中，中奖者排在后面就彻底看不到"待领奖"。
      // 现在改成：**我中奖的池必查**（不受上限约束），其余池才走上限。
      await loadUnclaimed(list);

      let views = list.map((l) => {
        const v = L.toView(l, tkccInfo.decimals);
        v._unclaimed = l._unclaimed;
        return v;
      });
      views.forEach((v) => poolCache.set(v.id, v));

      // 维护"我参与过"状态：只对进行中(open 且未过期)且尚未标记过的池查 participants()。
      // 目的：① "已参与"标签正确；② 参与按钮对已参与的池隐藏（避免重复点触发 AlreadyJoined）。
      // 已标记过的池跳过查询 → 轮询 / 切 tab 几乎零额外请求。
      // Bug-4：原来是串行 await，50 个进行中池 = 50 次排队 LCD 查询，
      // 10 秒轮询根本跑不完（列表永远在"追数据"）。改成 8 路并发后首屏快一个数量级。
      if (K.wallet.address) {
        const todo = views.filter(
          (v) => (v.statusView || v.status) === 'open' && !v.expired && !myJoinedIds.has(v.id)
        );
        await mapLimit(todo, 8, async (v) => {
          try {
            const ps = await L.participants(v.id);
            if ((ps.participants || []).includes(K.wallet.address)) myJoinedIds.add(v.id);
          } catch (_) { /* 忽略单池查询失败 */ }
        });
      }

      views = sortPools(views);

      // 默认"进行中"/"报名中"：过滤掉已退款、已开奖且奖金已领完、以及已截止只能退款的死池
      // （死池只出现在"全部"里；创建人 / 参与者也能在"我的"页看到并退款）
      if (mode !== 'all') {
        views = views.filter((v) => {
          if (v.status === 'refunded') return false;
          if ((v.statusView || v.status) === 'expired') return false;
          if (v.status === 'drawn' && Array.isArray(v._unclaimed) && v._unclaimed.length === 0) return false;
          return true;
        });
      }

      allPools = views;
      poolsLoaded = true;
      // 待领奖：中奖名单就在 Lottery 对象里（无需额外查询），
      // 再配合上面已查过的 unclaimed 即可判定"我中奖且还没领"
      pendingClaims = views.filter((v) => {
        if (v.status !== 'drawn' || !v.winners || !K.wallet.address) return false;
        const me = K.wallet.address;
        const won = (v.winners.first || []).includes(me) || (v.winners.second || []).includes(me);
        return won && (v._unclaimed || []).includes(me);
      });
      scanWins(allPools);       // 中奖统计（内部去重，轮询不会重复累加）
      renderClaimsTop();
      renderPoolList();

      if (sharedPoolId) setTimeout(() => highlightSharedPool(sharedPoolId), 300);
    } finally {
      refreshing = false;
    }
  }

  /**
   * 排序（基于派生状态 statusView）：
   *   进行中(open) → 满员待开(full) → 已开奖(drawn) → 已截止可退款(expired) → 已退款/取消；
   * 同状态内「快满员的靠前」（进度高的更容易成局），进度相同则快截止的靠前。
   * 用派生状态让"时间到了没满员"的死池沉到最底，新池 / 进行中池自然回到顶部。
   */
  const STATUS_RANK = { open: 0, full: 1, drawn: 2, expired: 3, refunded: 4, cancelled: 4 };
  function sortPools(views) {
    return views.slice().sort((a, b) => {
      const rank = (v) => STATUS_RANK[(v.statusView || v.status) || ''] ?? 9;
      const r = rank(a) - rank(b);
      if (r) return r;
      // 同状态内官方池靠前（用户要求官方奖池更显眼）
      const pa = a.maxPeople ? a.count / a.maxPeople : 0;
      const pb = b.maxPeople ? b.count / b.maxPeople : 0;
      if (pb !== pa) return pb - pa;
      return (a.expiresAt || 0) - (b.expiresAt || 0);
    });
  }

  /** 奖池页顶部的待领奖区块：有才显示，点一下即可领 */
  function renderClaimsTop() {
    const box = $('claimsTop');
    if (!box) return;
    const n = pendingClaims.length;
    box.hidden = n === 0;

    // 我的 tab 红点：切到别的 tab（创建/管理）时也看得到还有待领
    const dot = $('tabMeDot');
    if (dot) dot.hidden = n === 0;

    const cnt = $('claimsCount');
    if (cnt) {
      cnt.textContent = n > 1 ? String(n) : '';
      cnt.hidden = n <= 1;
    }

    if (n === 0) { $('claimsTopList').innerHTML = ''; return; }
    $('claimsTopList').innerHTML = pendingClaims.map(renderPoolCard).join('');
    bindCardActions($('claimsTopList'));
  }

  function renderPoolList() {
    const el = $('list');
    if (!allPools.length) {
      el.innerHTML = '<div class="empty"><span class="big">🫥</span>' + T('pools.empty') + '</div>';
      return;
    }
    el.innerHTML = allPools.map(renderPoolCard).join('');
    bindCardActions(el);
  }

  /** raw 字符串 → Number（按精度），避免 fmtWan 的"万"被 parseFloat 吞成 NaN */
  function rawToNum(raw, decimals) {
    try { return Number(BigInt(String(raw || '0'))) / (10 ** Number(decimals || 0)); }
    catch (_) { return 0; }
  }

  /**
   * 本站代币符号（TKCC / ORION / PICK / LEO）。
   *
   * 四站共用一份代码，所以**任何**面向用户的代币名都不能写字面量 ——
   * 写死的 "TKCC" 在另外三站不会跟着 config 变（语言包才走 localizeTokenName
   * 替换，app.js 模板里的字面量不在替换范围内）。
   */
  function SYM() { return (C && C.tokenName) || 'TKCC'; }

  /** 按万分之一（bps）向下取整，与合约 compute_payout 的 bps() 同口径 */
  function bpsOf(raw, bp) {
    try { return (BigInt(String(raw == null ? '0' : raw).trim() || '0') * BigInt(bp)) / 10000n; }
    catch (_) { return 0n; }
  }

  /**
   * 开奖后各档的实际金额（raw 字符串）。
   *
   * 优先用**链上 payout** —— 那是开奖交易里合约用 compute_payout 算好、
   * 写进 Lottery 快照的那一份，含"百分比取整 + 二等奖除不尽"的零头全部归一等奖，
   * 是唯一权威值（链上 `QueryMsg::Payout` 也是查它）。
   * 老池子万一没有 payout，就在本地按合约同一套 bps 复算一遍，
   * 保证显示的金额 = 实际到账金额，而不是"大概多少"。
   */
  function payoutOf(v) {
    const p = (v && v.payout) || null;
    if (p && (L.isNonZeroRaw(p.first_tkcc) || L.isNonZeroRaw(p.first_paxi) ||
              L.isNonZeroRaw(p.second_each_tkcc) || L.isNonZeroRaw(p.second_each_paxi))) {
      return {
        exact: true,
        firstPaxi: p.first_paxi || '0',      firstTkcc: p.first_tkcc || '0',
        secondPaxi: p.second_each_paxi || '0', secondTkcc: p.second_each_tkcc || '0',
        creatorPaxi: p.creator_paxi || '0',  creatorTkcc: p.creator_tkcc || '0',
        opsPaxi: p.ops_paxi || '0',          opsTkcc: p.ops_tkcc || '0',
        burnTkcc: p.burn_tkcc || '0',
      };
    }
    // ---- 本地复算：口径与合约 state.rs / compute_payout 完全一致 ----
    // TKCC：一等奖 38%、二等奖两人共 28%、建池者 14%、运营 14%、销毁 6%
    // PAXI：一等奖 40%、二等奖两人共 30%、建池者 15%、运营 15%（无销毁）
    // 平台模板池的建池者分成归运营。
    const poolP = String((v && v.poolPaxiRaw) || '0');
    const poolT = String((v && v.poolTkccRaw) || '0');
    const tpl = !!(v && v.isTemplatePool);
    let poolPb, poolTb;
    try { poolPb = BigInt(poolP) || 0n; } catch (_) { poolPb = 0n; }
    try { poolTb = BigInt(poolT) || 0n; } catch (_) { poolTb = 0n; }
    const n = 2n;                                    // 合约 cfg.second_prize_count
    const pFirst = bpsOf(poolTb, 3800);
    const pSecondEach = bpsOf(poolTb, 2800) / n;
    const pBurn = bpsOf(poolTb, 600);
    const pCreator = tpl ? 0n : bpsOf(poolTb, 1400);
    const pOps = bpsOf(poolTb, tpl ? 2800 : 1400);
    const aFirst = bpsOf(poolPb, 4000);
    const aSecondEach = bpsOf(poolPb, 3000) / n;
    const aCreator = tpl ? 0n : bpsOf(poolPb, 1500);
    const aOps = bpsOf(poolPb, tpl ? 3000 : 1500);
    const pRest = poolTb - (pFirst + pSecondEach * n + pCreator + pOps + pBurn);
    const aRest = poolPb - (aFirst + aSecondEach * n + aCreator + aOps);
    const add = (base, rest) => String(base + (rest > 0n ? rest : 0n));
    return {
      exact: false,
      firstTkcc: add(pFirst, pRest),   secondTkcc: String(pSecondEach),
      firstPaxi: add(aFirst, aRest),   secondPaxi: String(aSecondEach),
      creatorTkcc: String(pCreator),   creatorPaxi: String(aCreator),
      opsTkcc: String(pOps),           opsPaxi: String(aOps),
      burnTkcc: String(pBurn),
    };
  }

  /** 「2.4 PAXI + 2.66万 ORION」——为 0 的那一半不显示，两样都 0 返回空串 */
  function amtText(paxiRaw, tkccRaw) {
    const parts = [];
    if (L.isNonZeroRaw(paxiRaw)) parts.push(L.fmtPaxi(paxiRaw) + ' PAXI');
    if (L.isNonZeroRaw(tkccRaw)) parts.push(L.fmtTkcc(tkccRaw, tkccInfo.decimals) + ' ' + SYM());
    return parts.join(' + ');
  }

  /** 占比文案：14.3% / 14%；分母为 0 返回空串（不显示"undefined%"） */
  function pctText(part, whole) {
    const w = rawToNum(whole, 0);
    if (!w) return '';
    const v = Math.round((rawToNum(part, 0) / w) * 1000) / 10;
    if (!v) return '';                 // 0% 不显示：别出现"PAXI 0%"这种噪声
    return L.trimZeros(String(v)) + '%';
  }

  /** 「PAXI 40% / ORION 38%」——比例由金额反算，改费率也不会显示错 */
  function shareText(paxiRaw, tkccRaw, poolPaxi, poolTkcc) {
    const a = pctText(paxiRaw, poolPaxi);
    const b = pctText(tkccRaw, poolTkcc);
    const out = [];
    if (a) out.push('PAXI ' + a);
    if (b) out.push(SYM() + ' ' + b);
    return out.join(' / ');
  }

  /** 倒计时分段：文本 + 是否临近截止（≤1h 标红）+ 是否已截止 */
  function countdownParts(expiresAt) {
    const ms = Number(expiresAt) - Date.now();
    if (ms <= 0) return { text: T('pools.expired'), soon: false, done: true };
    const m = Math.floor(ms / 60000);
    const d = Math.floor(m / 1440);
    const h = Math.floor((m % 1440) / 60);
    const mm = m % 60;
    return {
      text: d > 0 ? T('pools.leftDays', { d, h })
        : h > 0 ? T('pools.leftHours', { h, m: mm })
        : T('pools.leftMinutes', { m: mm }),
      soon: ms < 3600000,
      done: false,
    };
  }

  /** 剩余时间（带 data-expires，供每秒 tick 就地刷新，不必重渲整张卡） */
  function leftText(expiresAt) {
    const p = countdownParts(expiresAt);
    return `<span class="left${p.soon ? ' soon' : ''}" data-expires="${Number(expiresAt)}">${p.text}</span>`;
  }

  /** 热度标签 */
  function hotTags(v) {
    const tags = [];
    const st = v.statusView || v.status;
    if (st === 'open' && v.maxPeople && v.count / v.maxPeople >= 0.8) {
      tags.push(`<span class="hot-tag hot">${T('pools.hot')}</span>`);
    }
    const left = v.expiresAt - Date.now();
    if (st === 'open' && left > 0 && left < 3600000) {
      tags.push(`<span class="hot-tag closing">${T('pools.closingSoon')}</span>`);
    }
    if (st === 'drawn' && Date.now() - (v.expiresAt || 0) < 600000) {
      tags.push(`<span class="hot-tag just">${T('pools.justDrawn')}</span>`);
    }
    return tags.join('');
  }

  /** 预计一等奖：按合约 bps 常量（PAXI 40% / TKCC 38%）算，口径与开奖一致 */
  function expectedHtml(v) {
    const st = v.statusView || v.status;
    if (st !== 'open' && st !== 'full') return '';
    if (!v.count) return '';
    // 用 payoutOf 在本地按合约口径复算"现在开奖能拿多少"：
    // 旧写法是 ×0.4 / ×0.38 的浮点估算，忽略"零头全部归一等奖"，
    // 显示出来的数字与真实开奖结果差一点点，容易被当成"算错了"。
    const pay = payoutOf(v);
    if (!L.isNonZeroRaw(pay.firstPaxi) && !L.isNonZeroRaw(pay.firstTkcc)) return '';
    return `<div class="meta expected">🎯 ${T('pools.expectedFirst', {
      p: L.fmtPaxi(pay.firstPaxi),
      t: L.fmtTkcc(pay.firstTkcc, tkccInfo.decimals),
    })}</div>`;
  }

  /** 中奖名单单行：统一隐藏中间 12 位（含自己），点击可复制完整地址 */
  function renderWinnerRow(addr, me, medal, cls, amt) {
    const isMe = !!me && addr === me;
    const shown = maskMiddle12(addr);
    return `<div class="winner ${cls}${isMe ? ' me' : ''}">
      <span class="medal">${medal}</span>
      ${isMe ? `<span class="me-tag">${T('common.you')}</span>` : ''}
      ${copyable(addr, T('common.address'), shown)}
      ${amt ? `<span class="amt">${amt}</span>` : ''}
    </div>`;
  }

  function renderWinners(v, me) {
    if (v.status !== 'drawn' || !v.winners) return '';
    const first  = v.winners.first  || [];
    const second = v.winners.second || [];
    if (!first.length && !second.length) return '';
    // 一等奖整份、二等奖是"每人可得"——两个口径在合约里就不同，别混用
    const pay  = payoutOf(v);
    const fAmt = amtText(pay.firstPaxi,  pay.firstTkcc);
    const sAmt = amtText(pay.secondPaxi, pay.secondTkcc);
    return `<div class="winners-box">
      <div class="winners-title">${T('pools.winnersTitle')}</div>
      ${first.map((a)  => renderWinnerRow(a, me, '🥇', 'first',  fAmt)).join('')}
      ${second.map((a) => renderWinnerRow(a, me, '🥈', 'second', sAmt)).join('')}
    </div>`;
  }

  function renderPoolCard(v) {
    const pct = v.maxPeople ? Math.min(100, Math.round((v.count / v.maxPeople) * 100)) : 0;
    const me = K.wallet.address;
    const isCreator = !!me && v.creator === me;
    const joined = !!me && myJoinedIds.has(v.id);
    const expired = v.expired;                       // 用统一派生状态，与排序 / 徽章一致
    const statusView = v.statusView || v.status;

    const stateCls = statusView === 'open' ? 'is-open'
      : statusView === 'full' ? 'is-full'
      : statusView === 'drawn' ? 'is-drawn'
      : statusView === 'expired' ? 'is-expired'
      : statusView === 'refunded' ? 'is-refunded' : '';

    const acts = [];
    if (v.status === 'open' && !expired) {
      // 建池者不能参与自己的池（合约已拒绝）；已参与过的人也不显示「参与」按钮
      // （避免反复点击触发 AlreadyJoined；myJoinedIds 由 refreshPools / 参与成功后维护）
      if (!isCreator && !joined) {
        acts.push(`<button class="btn sm primary" data-act="join" data-id="${v.id}">${T('pools.join')}</button>`);
      }
      acts.push(`<button class="btn sm ghost share-btn" data-act="share" data-id="${v.id}">${T('common.share')}</button>`);
    }
    if (v.status === 'full' && !v.deadFull) {
      // commit-reveal：建池者承诺过种子且尚未揭示时，必须先揭示才能开奖
      // （合约会拒绝未揭示的开奖；到期未揭示只能退款）
      if (isCreator && v.commitHash && !v.revealed) {
        acts.push(`<button class="btn sm primary" data-act="reveal" data-id="${v.id}">${T('pools.reveal')}</button>`);
      }
      acts.push(`<button class="btn sm primary" data-act="draw" data-id="${v.id}">${T('pools.draw')}</button>`);
    }
    // ⚠️ v.deadFull（链上 full 但人数 < 满员）= 满员后有人退款 → 合约的
    // REFUND_STARTED 已置位，开奖 100% 报错。这里不渲染开奖按钮，
    // 只留下面的「退款」，避免给用户一个必然失败的按钮。
    // 退款按钮：已截止且未开奖 / 未退款的池，只给"参与过的人 / 建池人"看
    // （合约层面非参与者点退款会被拒，这里把按钮对齐合约，消除"点了报错"的陷阱）
    if (expired && v.status !== 'drawn' && v.status !== 'refunded' && (joined || isCreator)) {
      acts.push(`<button class="btn sm ghost" data-act="refund" data-id="${v.id}">${T('pools.refund')}</button>`);
    }

    // 详情按钮：任何状态都能点进去看（未开奖看参与者，已开奖看中奖名单 + 分配明细）
    acts.push(`<button class="btn sm ghost" data-act="detail" data-id="${v.id}">${T('pools.viewDetail')}</button>`);

    const winHtml = renderWinBanner(v, me) + renderWinners(v, me);

    return `<div class="item ${stateCls}" data-id="${v.id}">
      <div class="item-top">
        <span class="id">${copyable(String(v.id), '抽奖 ID', '#' + v.id)}</span>
        <span class="st ${statusView}">${v.statusText}</span>
        ${isCreator ? '<span class="st mine">' + T('pools.tagMine') + '</span>' : ''}
        ${joined ? '<span class="st joined">' + T('pools.tagJoined') + '</span>' : ''}
        ${hotTags(v)}
      </div>

      <div class="meta">${T('pools.fee')} <b>${v.joinPaxi}</b> PAXI + <b>${v.joinTkcc}</b> ${SYM()}</div>
      <div class="meta">${T('pools.pool')} <b>${v.poolPaxi}</b> PAXI / <b>${v.poolTkcc}</b> ${SYM()}</div>

      <div class="bar"><i style="width:${pct}%"></i></div>
      <div class="meta">${T('pools.people', { c: v.count, m: v.maxPeople })} · ${leftText(v.expiresAt)}${v.randomSource ? ' · ' + escapeHtml(v.randomSource) : ''}</div>
      ${expectedHtml(v)}
      ${winHtml}
      ${acts.length ? `<div class="acts">${acts.join('')}</div>` : ''}
    </div>`;
  }

  function renderWinBanner(v, me) {
    if (v.status !== 'drawn' || !me) return '';
    const w = v.winners;
    if (!w) return '';

    const isFirst  = (w.first  || []).includes(me);
    const isSecond = (w.second || []).includes(me);
    if (!isFirst && !isSecond) return '';

    // 我能领多少：一等奖取 first_*（整份），二等奖取 second_each_*（合约里就是每人）
    const pay = payoutOf(v);
    const amt = amtText(isFirst ? pay.firstPaxi : pay.secondPaxi,
                        isFirst ? pay.firstTkcc : pay.secondTkcc);
    const amtHtml = amt ? `<span class="amt">+${amt}</span>` : '';

    // _unclaimed 还没查回来时不能当成"待领奖"，否则会闪出一个点了就报错的领奖按钮
    const pending = v._unclaimed;
    if (!Array.isArray(pending)) {
      return `<div class="win-banner ${isFirst ? 'first' : 'second'}">
        <span class="ico">⏳</span><span>${T('common.loading')}</span>
      </div>`;
    }
    const claimed = !pending.includes(me);

    if (isFirst) {
      if (claimed) {
        return `<div class="win-banner first claimed">
          <span class="ico">🏆</span><span>${T('pools.winFirstDone')}</span>${amtHtml}
        </div>`;
      }
      return `<div class="win-banner first">
        <span class="ico">🎉</span><span>${T('pools.winFirst')}</span>${amtHtml}
      </div>
      <button class="claim-btn" data-act="claim" data-id="${v.id}">
        <span>💰</span><span>${T('pools.claimNow')}</span>
      </button>`;
    }
    if (isSecond) {
      if (claimed) {
        return `<div class="win-banner second claimed">
          <span class="ico">🥈</span><span>${T('pools.winSecondDone')}</span>${amtHtml}
        </div>`;
      }
      return `<div class="win-banner second">
        <span class="ico">🎉</span><span>${T('pools.winSecond')}</span>${amtHtml}
      </div>
      <button class="claim-btn second" data-act="claim" data-id="${v.id}">
        <span>💰</span><span>${T('pools.claimNow')}</span>
      </button>`;
    }
    return '';
  }

  /**
   * 分配明细：**每一项的真实金额** + 由金额反算的占比。
   *
   * 旧版这里是五行写死的 "TKCC 38% / PAXI 40%"，只能看比例、看不到钱，
   * 而且四站共用一份代码时 "TKCC" 字面量在 ORION/PICK/LEO 站不会本地化。
   * 现在金额取链上 payout（开奖时合约算好存下的），比例由 金额/奖池 反算，
   * 末尾再加一行"奖池合计"，玩家可以自己按加法核对有没有少发。
   */
  function distributionHtml(v) {
    const pay  = payoutOf(v);
    const poolP = v.poolPaxiRaw, poolT = v.poolTkccRaw;
    const rows = [
      ['🥇', T('pools.firstPrizeName') + ' · 1 ' + T('pools.person'),
        pay.firstPaxi, pay.firstTkcc, ''],
      ['🥈', T('pools.secondPrizeName') + ' · 2 ' + T('pools.person') + T('pools.eachOne'),
        pay.secondPaxi, pay.secondTkcc, ''],
      ['🏗️', T('pools.creatorShare'), pay.creatorPaxi, pay.creatorTkcc, ''],
      ['🏢', T('pools.opShare'),      pay.opsPaxi,     pay.opsTkcc,     ''],
      ['🔥', T('pools.burnShare'),    '0',             pay.burnTkcc,    ''],
    ];
    const body = rows.map(([ico, name, paxiRaw, tkccRaw]) => {
      const amt = amtText(paxiRaw, tkccRaw);
      const pct = shareText(paxiRaw, tkccRaw, poolP, poolT);
      return `<div class="meta dist">
        <span class="d-name">${ico} ${name}</span>
        <span class="amt">${amt || '—'}</span>
        ${pct ? `<span class="pct">${pct}</span>` : ''}
      </div>`;
    }).join('');
    const total = amtText(poolP, poolT);
    return body + (total
      ? `<div class="meta dist total">
          <span class="d-name">🧮 ${T('pools.poolTotal')}</span>
          <span class="amt">${total}</span>
        </div>`
      : '');
  }

  function bindCardActions(root) {
    root.querySelectorAll('button[data-act]').forEach((b) => {
      b.onclick = () => guardBusy(b, () => onAction(b.dataset.act, Number(b.dataset.id), b));
    });
  }

  // =====================================================================
  // 弹窗：开奖结果 / 奖池详情
  // =====================================================================
  async function fetchView(id) {
    let v = poolCache.get(id);
    if (v && v._unclaimed) return v;
    try {
      const l = await L.lottery(id);
      v = L.toView(l, tkccInfo.decimals);
      // 查询失败时**不能**写 []：[] 在 JS 里是 truthy，会被上面那句当成
      // "有效缓存"永久命中 → 中奖名单弹窗永远显示空。留 undefined = "还没查到"，
      // 下次进来自动重试。与 loadUnclaimed 的"失败不写缓存"原则保持一致。
      try { v._unclaimed = ((await L.unclaimed(id)) || {}).pending || []; }
      catch (_) { v._unclaimed = undefined; }
      poolCache.set(v.id, v);
      return v;
    } catch (_) {
      return poolCache.get(id) || null;
    }
  }

  /** 开奖结果弹窗：中奖名单 + 分配明细 + 随机源/seed（可对外证明"没作弊"） */
  async function showDrawResult(id) {
    const v = await fetchView(id);
    if (!v) return toast(T('msg.poolNotFound'), 'err');
    const me = K.wallet.address;
    const first  = (v.winners && v.winners.first)  || [];
    const second = (v.winners && v.winners.second) || [];
    const isMine = !!me && (first.includes(me) || second.includes(me));

    document.body.insertAdjacentHTML('beforeend', `
      <div class="modal-mask" onclick="if(event.target===this)this.remove()">
        <div class="modal">
          <h3 class="modal-title">🎉 ${T('pools.drawResult')} #${v.id}</h3>
          ${isMine ? `<div class="mine-banner">${T('pools.youWon')}</div>` : ''}
          ${renderWinners(v, me) || `<div class="empty">${T('pools.noWinners')}</div>`}
          <details class="draw-detail">
            <summary>${T('pools.distribution')}</summary>
            ${distributionHtml(v)}
            ${v.randomSource ? `<div class="meta">🎲 ${T('pools.randomSource')}: <b>${escapeHtml(v.randomSource)}</b></div>` : ''}
            ${v.seed ? `<div class="meta">🌱 ${T('pools.seed')}: ${copyable(v.seed, 'seed', maskAddr(v.seed, 12, 8))}</div>` : ''}
          </details>
          <button class="btn primary block" data-modal-close>${T('common.close')}</button>
        </div>
      </div>`);
    bindModalClose();

    if (isMine && window.confetti) {
      try { confetti({ particleCount: 180, spread: 90, origin: { y: 0.6 } }); } catch (_) {}
    }
  }

  /** 奖池详情弹窗：基本信息 + 参与者名单（自己高亮） */
  async function showPoolDetail(id) {
    const v = await fetchView(id);
    if (!v) return toast(T('msg.poolNotFound'), 'err');
    const me = K.wallet.address;
    let participants = [];
    try { participants = (await L.participants(v.id)).participants || []; } catch (_) {}

    document.body.insertAdjacentHTML('beforeend', `
      <div class="modal-mask" onclick="if(event.target===this)this.remove()">
        <div class="modal">
          <h3 class="modal-title">${T('pools.detailTitle')} #${v.id}</h3>
          <div class="meta">${T('pools.fee')} <b>${v.joinPaxi}</b> PAXI + <b>${v.joinTkcc}</b> ${SYM()}</div>
          <div class="meta">${T('pools.pool')} <b>${v.poolPaxi}</b> PAXI / <b>${v.poolTkcc}</b> ${SYM()}</div>
          <div class="meta">${T('pools.people', { c: v.count, m: v.maxPeople })} · ${leftText(v.expiresAt)}</div>
          ${renderWinners(v, me)}
          ${v.status === 'drawn' ? `<details class="draw-detail"><summary>${T('pools.distribution')}</summary>
            ${distributionHtml(v)}
          </details>` : ''}
          <details class="draw-detail"${v.status === 'drawn' ? '' : ' open'}>
            <summary>${T('pools.participants')} (${participants.length})</summary>
            <div class="participants">
              ${participants.map((a) => {
                const isMe = !!me && a === me;
                return `<div class="winner${isMe ? ' me' : ''}">
                  <span class="medal">·</span>
                  ${isMe ? `<span class="me-tag">${T('common.you')}</span>` : ''}
                  ${copyable(a, T('common.address'), maskMiddle12(a))}
                </div>`;
              }).join('') || '<div class="empty">—</div>'}
            </div>
          </details>
          <button class="btn primary block" data-modal-close>${T('common.close')}</button>
        </div>
      </div>`);
    bindModalClose();
  }

  /** 关闭按钮走 JS 绑定，避免内联 onclick 依赖全局（CSP 更友好） */
  function bindModalClose() {
    document.querySelectorAll('[data-modal-close]:not([data-bound])').forEach((b) => {
      b.setAttribute('data-bound', '1');
      b.onclick = () => { const m = b.closest('.modal-mask'); if (m) m.remove(); };
    });
  }
  // ESC 关弹窗
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    const m = document.querySelector('.modal-mask');
    if (m) m.remove();
  });

  // =====================================================================
  // 我的页
  // =====================================================================
  async function refreshMyPage() {
    if (!K.wallet.address) {
      $('myClaims').innerHTML  = '<div class="empty">' + T('me.needConnect') + '</div>';
      $('myCreated').innerHTML = '';
      $('myJoined').innerHTML  = '';
      renderStats();      // 未连接也展示本地历史统计/成就
      return;
    }
    await refreshBalance();
    refreshSessionStatus().catch(() => {});

    const me = K.wallet.address;
    const res = await L.lotteries(null, 200).catch(() => ({ lotteries: [] }));
    // 与奖池页同一口径：官方模板池只对管理员地址可见（非管理员连"我参与过"也不显示）
    const pools = (res.lotteries || [])
      .filter((l) => tplPoolsVisible() || !l.is_template_pool)
      .map((l) => L.toView(l, tkccInfo.decimals));

    const created = [];
    const joined  = [];
    const claims  = [];
    myJoinedIds = new Set();

    // 8 路并发 + 终态缓存：冻结池的 participants / drawn 池的 unclaimed 只查一次，
    // 之后每 10 秒的轮询只查活跃池（open 且未过期），LCD 压力降一个数量级。
    // unclaimed 统一走 loadUnclaimed（我中奖的池必查 + 失败不缓存），
    // 与奖池页共用同一套语义，避免两处行为漂移。
    await loadUnclaimed(pools);
    await mapLimit(pools, 8, async (v) => {
      poolCache.set(v.id, v);

      if (v.creator === me) { created.push(v); return; }

      let isJoined = false;
      // 冻结判定：非 open（满员/已开奖/已退款/已取消）或已截止 → 名单不再变化，可缓存
      const frozen = v.status !== 'open' || v.expired;
      if (frozen && participantsCache.has(v.id)) {
        isJoined = participantsCache.get(v.id);
      } else {
        try {
          const ps = await L.participants(v.id);
          isJoined = (ps.participants || []).includes(me);
        } catch (_) { isJoined = false; }
        if (frozen) participantsCache.set(v.id, isJoined);
      }

      if (isJoined) {
        myJoinedIds.add(v.id);
        joined.push(v);
        if (v.status === 'drawn' && v.winners) {
          const isFirst  = (v.winners.first  || []).includes(me);
          const isSecond = (v.winners.second || []).includes(me);
          if ((isFirst || isSecond) && Array.isArray(v._unclaimed) && v._unclaimed.includes(me)) {
            claims.push(v);
          }
        }
      }
    });

    $('myClaims').innerHTML  = claims.length
      ? claims.map(renderPoolCard).join('')
      : '<div class="empty"><span class="big">🎈</span>' + T('me.emptyClaims') + '</div>';

    $('myCreated').innerHTML = created.length
      ? created.map(renderPoolCard).join('')
      : '<div class="empty"><span class="big">🏗️</span>' + T('me.emptyCreated') + '</div>';

    $('myJoined').innerHTML  = joined.length
      ? joined.map(renderPoolCard).join('')
      : '<div class="empty"><span class="big">🎯</span>' + T('me.emptyJoined') + '</div>';

    bindCardActions($('myClaims'));
    bindCardActions($('myCreated'));
    bindCardActions($('myJoined'));

    // 待领奖以"我的"页结果为准（这里扫的是全部池，更全），同步给顶部区块与红点
    pendingClaims = claims;
    scanWins(pools);          // 这里扫的是全部池，比奖池页更全
    renderStats();
    renderClaimsTop();
    // 奖池列表里同步"已参与"标记
    if (currentTab === 'pools') renderPoolList();
  }

  // =====================================================================
  // 我的页：无感会话状态 + gas 余额
  // =====================================================================
  async function refreshSessionStatus() {
    const el = $('sessStateText');
    const gasEl = $('sessGasText');
    const btn = $('btnSessionMe');
    if (!el) return;

    if (!K.wallet.address) {
      el.textContent = T('sessStatus.notConnected');
      el.className = 'v off';
      gasEl.textContent = T('sessStatus.connectHint');
      gasEl.className = 'hint';
      btn.textContent = T('wallet.connect');
      btn.onclick = () => guardBusy(btn, () => onConnect());
      return;
    }

    if (!S.state.enabled) {
      el.textContent = T('sessStatus.off');
      el.className = 'v off';
      gasEl.textContent = T('sessStatus.offHint');
      gasEl.className = 'hint';
      btn.textContent = T('sessCard.btnEnable');
      btn.onclick = () => guardBusy(btn, () => onSession());
      return;
    }

    el.textContent = T('sessStatus.on');
    el.className = 'v on';
    btn.textContent = T('wallet.closeSession');
    btn.onclick = () => guardBusy(btn, () => onSession());

    // gas 余额：会话账户自己付 gas，用完会静默回退弹钱包，这里提前提醒
    try {
      const raw = await K.getBankUpaxi(S.state.sessAddr);
      const paxi = L.fmtPaxi(raw);
      // 单笔估算：gas × gasPrice。gasPrice 未来若被改成 0（本地调试常见），
      // 除法会得 Infinity/NaN；连同 gas 一起兜底为最小 1，保证倒计时永远是个数。
      const perOp = Math.max(1, Number(C.defaultGas || 600000) * (C.gasPrice || 0.05));
      const times = Math.floor(Number(raw || 0) / perOp);
      gasEl.textContent = T('sessStatus.gas', { v: paxi, n: times });
      gasEl.className = Number(raw || 0) < 100000 ? 'hint low' : 'hint';
      if (Number(raw || 0) < 100000) {
        gasEl.textContent = T('sessStatus.gasLow', { v: paxi });
      }
    } catch (_) {
      gasEl.textContent = T('sessStatus.gasMissing');
      gasEl.className = 'hint low';
    }
  }

  // =====================================================================
  // 管理页
  // =====================================================================
  async function refreshAdminPage() {
    if (!isAdmin) return;
    renderAdmins();

    // 两块可选面板：显示与否由 config 决定，关掉的面板不渲染、也不发链上查询
    const tplOn = tplPanelVisible();
    const msOn  = msPanelVisible();
    const tplSec = $('tplSection');
    const msSec  = $('msSection');
    if (tplSec) tplSec.hidden = !tplOn;
    if (msSec)  msSec.hidden  = !msOn;
    if (tplOn) renderTemplateTierOptions();
    if (msOn)  renderMsActions();

    await refreshContractInfo().catch(() => {});
    await refreshTkcc(true).catch(() => {});
    if (tplOn) await refreshTemplates().catch(() => {});
    if (msOn)  await refreshMultisig().catch(() => {});
  }

  /** 模板档位下拉（与奖池档位同一份配置，同样按合约版本门控） */
  function renderTemplateTierOptions() {
    const sel = $('tplTier');
    if (!sel) return;
    const prev = sel.value;
    const tiers = L.availableTiers();
    sel.innerHTML = tiers.map((t) =>
      `<option value="${t.id}">${t.label}（${T('create.peopleFull', { n: t.people })}）</option>`).join('');
    // 尽量保留用户原选择；原档位若已不可用则回落到第一个
    if (tiers.some((t) => String(t.id) === String(prev))) sel.value = prev;
  }

  async function refreshContractInfo() {
    try {
      const cfg = await L.contractConfig();
      const t = cfg.treasury || '';
      const match = t === C.treasury;
      $('treasuryStatus').textContent =
        T('msg.treasuryLine', { v: t || '—' })
        + (t && !match ? T('msg.treasuryMismatch', { v: C.treasury }) : '')
        + (cfg.paused ? T('msg.paused') : '');
      $('btnSetTreasury').textContent = match ? T('msg.treasurySame') : T('msg.treasuryWrite');
      $('btnSetTreasury').classList.toggle('ghost', match);
    } catch (e) {
      $('treasuryStatus').textContent = T('msg.treasuryConfigFallback', { v: C.treasury });
    }
  }

  // =====================================================================
  // 可见性开关：官方模板池 / 多签提案（config 驱动）
  //
  // 合约侧的能力一直都在（pool_template* 与 Propose/Confirm/Query 均可正常调用），
  // 这里只决定前端"给谁看"：
  //   showTemplatePools : 'admin' 仅管理员地址可见（默认）｜ true 所有人 ｜ false 彻底关闭
  //   showMultisig      : true 显示 ｜ false（默认）隐藏
  // 跟着开关走的一共两处：① 奖池列表里的官方池卡片；② 管理页的两块面板。
  // 用 function 声明（会提升），前面 refreshPools / refreshMyPage 可先调用。
  // =====================================================================
  /** 奖池列表里的官方模板池卡片是否可见 */
  function tplPoolsVisible() {
    const v = C.showTemplatePools;
    if (v === 'admin') return !!isAdmin;   // 只有连上管理员地址才可见
    return v === true;
  }
  /** 管理页「官方模板池」面板是否显示（false = 该功能彻底关闭） */
  function tplPanelVisible() { return !!isAdmin && C.showTemplatePools !== false; }
  /** 管理页「多签提案」面板是否显示（默认隐藏） */
  function msPanelVisible() { return !!isAdmin && C.showMultisig === true; }

  // =====================================================================
  // 官方模板池管理（Bug-6）
  // =====================================================================
  let templatesCache = [];

  async function refreshTemplates() {
    const box = $('tplList');
    if (!box) return;
    // 面板不开（非管理员 / showTemplatePools === false）时既不清空也不发链上查询
    if (!tplPanelVisible()) { box.innerHTML = ''; templatesCache = []; return; }
    let tpls = [];
    try {
      const r = await L.poolTemplates();
      tpls = (r && r.templates) || [];
    } catch (e) {
      box.innerHTML = '<div class="empty">' + T('admin.tplLoadFail') + '</div>';
      return;
    }
    // 顺带拿每个模板的活跃池进度（合约有专门的聚合查询）
    let activeMap = new Map();
    try {
      const a = await L.activePoolOfTemplates();
      for (const e of ((a && a.entries) || [])) {
        activeMap.set(Number(e.template_id), e);
      }
    } catch (_) { /* 进度拿不到就只显示模板本身 */ }
    templatesCache = tpls;

    if (!tpls.length) {
      box.innerHTML = '<div class="empty"><span class="big">🏛️</span>' + T('admin.tplEmpty') + '</div>';
      return;
    }

    box.innerHTML = tpls.map((t) => {
      const tier = C.tiers.find((x) => x.id === Number(t.tier));
      const a = activeMap.get(Number(t.id));
      const prog = a
        ? T('admin.tplProgress', { c: a.participant_count, m: a.max_people, id: a.active_pool_id ?? '—' })
        : T('admin.tplNoPool');
      return `<div class="item" data-tpl="${t.id}">
        <div class="item-top">
          <span class="id">${escapeHtml(t.name)}</span>
          <span class="st ${t.active ? 'open' : 'expired'}">${t.active ? T('admin.tplOn') : T('admin.tplOff')}</span>
          <span class="st mine">#${t.id} · ${tier ? tier.label : T('common.tier') + t.tier}</span>
          <span class="st ${t.has_commit ? 'joined' : 'expired'}">${t.has_commit ? T('admin.tplHasCommit') : T('admin.tplNoCommit')}</span>
        </div>
        <div class="meta">${prog}</div>
        <div class="acts">
          <button class="btn sm ghost" data-tpl-act="toggle" data-tpl="${t.id}">${t.active ? T('admin.tplStop') : T('admin.tplStart')}</button>
          ${t.has_commit ? `<button class="btn sm" data-tpl-act="reveal" data-tpl="${t.id}">${T('admin.tplReveal')}</button>` : ''}
        </div>
      </div>`;
    }).join('');

    box.querySelectorAll('button[data-tpl-act]').forEach((b) => {
      const id = Number(b.dataset.tpl);
      b.onclick = () => guardBusy(b, () => (
        b.dataset.tplAct === 'toggle'
          ? onToggleTemplate(id, !templatesCache.find((x) => Number(x.id) === id).active)
          : onRevealTemplateSecret(id)
      ));
    });
  }

  async function onCreateTemplate() {
    const name = ($('tplName').value || '').trim();
    const tier = Number($('tplTier').value);
    const commit = ($('tplCommit').value || '').trim();
    if (!name) return banner(T('admin.tplNameRequired'), 'warn');
    if (commit && !/^[0-9a-fA-F]{64}$/.test(commit)) return banner(T('admin.tplCommitBad'), 'warn');
    try {
      const res = await L.createPoolTemplate(name, tier, commit || null);
      const tid = extractAttr(res, 'template_id');
      log(T('msg.tplCreated', { id: tid || '?' }));
      toast(T('msg.tplCreatedBanner'), 'info');
      $('tplName').value = '';
      $('tplCommit').value = '';
      await refreshTemplates();
    } catch (e) { fail(e, T('err.createTpl')); }
  }

  async function onToggleTemplate(id, active) {
    try {
      await L.updatePoolTemplate(id, active);
      log(T('msg.tplUpdated', { id, s: active ? T('admin.tplOn') : T('admin.tplOff') }));
      await refreshTemplates();
    } catch (e) { fail(e, T('err.updateTpl')); }
  }

  async function onRevealTemplateSecret(id) {
    const secret = window.prompt(T('admin.tplRevealPrompt', { id }));
    if (!secret) return;
    if (!/^[0-9a-fA-F]{64}$/.test(secret.trim())) return banner(T('admin.tplRevealBad'), 'warn');
    try {
      await L.revealTemplateSecret(id, secret.trim());
      log(T('msg.tplRevealed', { id }));
      toast(T('msg.tplRevealedBanner'), 'info');
      await refreshTemplates();
    } catch (e) { fail(e, T('err.revealTpl')); }
  }

  // =====================================================================
  // 多签提案（Bug-7：合约有 Propose/Confirm/Query，前端此前零入口）
  //
  // 合约只有按 ID 单查的 `Proposal { id }`，没有列表接口 —— 因此除"按 ID
  // 查询 / 确认"外，额外把本机发起过的提案 ID 记在 localStorage，避免换页就丢。
  // =====================================================================
  const PROPOSAL_LS = nsKey('cj_proposals');

  // value 是下拉的键；build 把输入框里的参数翻译成 AdminAction JSON
  const MS_ACTIONS = [
    { v: 'set_treasury', need: 'admin.msNeedAddr', build: (p) => ({ set_treasury: { treasury: p } }) },
    { v: 'set_paused', need: 'admin.msNeedBool', build: (p) => ({ set_paused: { paused: p === 'true' } }) },
    { v: 'set_tkcc_burn_mode', need: 'admin.msNeedMode', build: (p) => ({ set_tkcc_burn_mode: { mode: p } }) },
    { v: 'custom_set_burn_mode', need: 'admin.msNeedMode', build: (p) => L.customAdminAction('lottery', { set_burn_mode: { mode: p } }) },
    {
      v: 'custom_reveal_template_secret',
      need: 'admin.msNeedTplSecret',
      build: (p) => {
        const [tid, secret] = String(p).split(':');
        return L.customAdminAction('lottery', {
          reveal_template_secret: { template_id: Number(tid), secret: String(secret || '') },
        });
      },
    },
    {
      v: 'update_admins',
      need: 'admin.msNeedAdmins',
      build: (p) => {
        // 格式：add1,add2|-addr1|threshold（三段，可留空）
        const [addS = '', rmS = '', thS = ''] = String(p).split('|');
        const list = (s) => s.split(',').map((x) => x.trim()).filter(Boolean);
        const th = thS.trim() === '' ? null : Number(thS.trim());
        return {
          update_admins: {
            add: list(addS),
            remove: list(rmS),
            threshold: th == null || Number.isNaN(th) ? null : th,
          },
        };
      },
    },
  ];

  function renderMsActions() {
    const sel = $('msAction');
    if (!sel || !msPanelVisible()) return;
    sel.innerHTML = MS_ACTIONS.map((a) =>
      `<option value="${a.v}">${T('admin.msAct.' + a.v)}</option>`).join('');
    refreshMsHint();
  }

  function refreshMsHint() {
    const a = MS_ACTIONS.find((x) => x.v === $('msAction').value);
    if (a && $('msActionHint')) $('msActionHint').textContent = T(a.need);
  }

  async function refreshMultisig() {
    const el = $('msThreshold');
    if (!el || !msPanelVisible()) return;
    try {
      const r = await K.queryContract({ admins: {} });
      el.textContent = T('admin.msThreshold', { t: r.threshold, n: (r.admins || []).length });
    } catch (_) {
      el.textContent = T('admin.msThresholdFallback', { t: C.multisigThreshold });
    }
    renderMsLocalList();
  }

  function msLocal() { return loadJSON(PROPOSAL_LS).list || []; }
  function pushMsLocal(id, label) {
    const obj = loadJSON(PROPOSAL_LS);
    const list = obj.list || [];
    if (!list.some((x) => Number(x.id) === Number(id))) {
      list.unshift({ id: Number(id), label, ts: Date.now() });
    }
    obj.list = list.slice(0, 20);
    saveJSON(PROPOSAL_LS, obj);
  }

  function renderMsLocalList() {
    const box = $('msLocalList');
    if (!box) return;
    const list = msLocal();
    if (!list.length) { box.innerHTML = ''; return; }
    box.innerHTML = list.map((p) => `
      <div class="item">
        <div class="item-top">
          <span class="id">#${p.id}</span>
          <span class="st mine">${escapeHtml(p.label || '')}</span>
        </div>
        <div class="acts">
          <button class="btn sm ghost" data-ms="query" data-id="${p.id}">${T('admin.msQuery')}</button>
          <button class="btn sm primary" data-ms="confirm" data-id="${p.id}">${T('admin.msConfirmBtn')}</button>
        </div>
      </div>`).join('');
    box.querySelectorAll('button[data-ms]').forEach((b) => {
      const id = Number(b.dataset.id);
      b.onclick = () => guardBusy(b, () => (b.dataset.ms === 'query' ? onQueryProposal(id) : onConfirmProposal(id)));
    });
  }

  async function onPropose() {
    const a = MS_ACTIONS.find((x) => x.v === $('msAction').value);
    const p = ($('msParam').value || '').trim();
    if (!a) return;
    try {
      const action = a.build(p);
      const res = await L.proposeAdminAction(action);
      const id = extractAttr(res, 'proposal_id');
      log(T('msg.msProposed', { id: id || '?' }));
      toast(T('msg.msProposedBanner'), 'info');
      if (id) {
        pushMsLocal(id, T('admin.msAct.' + a.v));
        $('msId').value = id;
        await onQueryProposal(Number(id));
      }
      renderMsLocalList();
    } catch (e) { fail(e, T('err.propose')); }
  }

  async function onQueryProposal(idArg) {
    const id = Number(idArg != null ? idArg : $('msId').value);
    const el = $('msProposalInfo');
    if (!id) { if (el) el.textContent = T('admin.msIdRequired'); return; }
    try {
      const p = await L.proposal(id);
      if (!p) { el.textContent = T('admin.msNotFound', { id }); return; }
      el.textContent = T('admin.msInfo', {
        id,
        n: (p.confirmations || []).length,
        ex: p.executed ? T('admin.msExecuted') : T('admin.msPending'),
      });
    } catch (e) {
      el.textContent = T('admin.msQueryFail', { m: (e && e.message) || e });
    }
  }

  async function onConfirmProposal(idArg) {
    const id = Number(idArg != null ? idArg : $('msId').value);
    if (!id) return banner(T('admin.msIdRequired'), 'warn');
    try {
      await L.confirmAdminAction(id);
      log(T('msg.msConfirmed', { id }));
      toast(T('msg.msConfirmedBanner'), 'info');
      await onQueryProposal(id);
      await refreshContractInfo().catch(() => {});
    } catch (e) { fail(e, T('err.confirm')); }
  }

  // =====================================================================
  // 分享
  // =====================================================================
  function buildShareUrl(id) {
    const url = new URL(window.location.href);
    url.search = '';
    url.hash = '';
    url.searchParams.set('pool', id);
    return url.toString();
  }

  async function sharePool(v) {
    if (!v) return;
    const shareUrl = buildShareUrl(v.id);
    const title = T('share.title', { id: v.id });
    const text = T('share.body', {
      id: v.id,
      jp: v.joinPaxi, jt: v.joinTkcc,
      pp: v.poolPaxi, pt: v.poolTkcc,
    });

    if (navigator.share) {
      try {
        await navigator.share({ title, text, url: shareUrl });
        log(T('msg.shareLog', { id: v.id }));
        return;
      } catch (e) {
        if (e && e.name === 'AbortError') return;   // 用户取消
      }
    }
    await copyText(shareUrl, T('common.share'));
  }

  function parseSharedPool() {
    try {
      const params = new URLSearchParams(window.location.search);
      const id = Number(params.get('pool') || 0);
      if (id > 0) sharedPoolId = id;
    } catch (e) {}
  }

  function highlightSharedPool(targetId) {
    const card = document.querySelector(`.item[data-id="${targetId}"]`);
    if (!card) {
      // 目标池不在当前筛选里 → 切"全部"再试一次
      if ($('fStatus').value !== 'all') {
        $('fStatus').value = 'all';
        refreshPools().then(() => {
          setTimeout(() => highlightSharedPool(targetId), 300);
        }).catch(() => {});
      }
      return;
    }

    card.scrollIntoView({ behavior: 'smooth', block: 'center' });
    card.classList.add('highlight');
    setTimeout(() => card.classList.remove('highlight'), 5000);

    if (!K.wallet.address) {
      banner(T('msg.shareBannerNoWallet', { id: targetId }), 'info');
    } else {
      banner(T('msg.shareBanner', { id: targetId }), 'info');
    }

    try {
      const url = new URL(window.location.href);
      url.searchParams.delete('pool');
      window.history.replaceState({}, '', url.toString());
    } catch (e) {}
    sharedPoolId = null;
  }

  // =====================================================================
  // 动作
  // =====================================================================
  /** 参与前的内部余额预检：避免白扣 gas 后合约报 Insufficient */
  function checkAfford(v) {
    const needPaxi = BigInt(v.joinPaxiRaw || '0');
    const needTkcc = BigInt(v.joinTkccRaw || '0');
    const hasPaxi = BigInt(balPaxiRaw || '0');
    const hasTkcc = BigInt(balTkccRaw || '0');
    const shortPaxi = needPaxi > hasPaxi;
    const shortTkcc = needTkcc > hasTkcc;
    if (!shortPaxi && !shortTkcc) return true;
    const need = `${v.joinPaxi} PAXI + ${v.joinTkcc} ${SYM()}`;
    const lack = `${shortPaxi ? L.fmtPaxi(needPaxi - hasPaxi) + ' PAXI ' : ''}`
      + `${shortTkcc ? L.fmtTkcc(needTkcc - hasTkcc, tkccInfo.decimals) + ' ' + SYM() : ''}`;
    banner(T('create.balShort', { need, lack }), 'err');
    return false;
  }

  async function onAction(act, id, btn) {
    try {
      if (act === 'join') {
        const v = poolCache.get(id) || allPools.find((x) => x.id === id);
        if (!v) return banner(T('msg.poolNotFound'), 'err');
        if (!checkAfford(v)) return;
        const res = await L.joinLottery(id, v.joinTkccRaw, v.joinPaxiRaw);
        log(T('msg.joinOk', { id }) + (res.transactionHash ? ' tx=' + res.transactionHash : ''));
        // 乐观更新：不等链上刷新，先把人数 +1、进度条顶上去、按钮变「已参与」
        myJoinedIds.add(id);
        bumpStat('join');
        if (v) {
          v.count = (v.count || 0) + 1;
          const card = document.querySelector(`.item[data-id="${id}"]`);
          if (card) {
            const bar = card.querySelector('.bar i');
            if (bar) bar.style.width = Math.min(100, Math.round((v.count / v.maxPeople) * 100)) + '%';
            card.querySelector('button[data-act="join"]')?.remove();
          }
        }
        if (currentTab === 'pools') renderPoolList();
        await S.syncNonce().catch(() => {});
        toast(T('msg.joinOkBanner'), 'info');
      } else if (act === 'draw') {
        await L.drawLottery(id);
        log(T('msg.drawOk', { id }));
        toast(T('msg.drawOkBanner'), 'info');
        unclaimedCache.delete(id);
        showDrawResult(id).catch(() => {});   // 弹结果 + 中奖名单 + 分配明细
      } else if (act === 'reveal') {
        await onRevealSecret(id);
        return;   // 内部已按需刷新
      } else if (act === 'claim') {
        if (btn) { btn.disabled = true; btn.innerHTML = `<span>⏳</span><span>${T('pools.claiming')}</span>`; }
        try {
          await L.claim(id);
          unclaimedCache.delete(id);   // 领奖成功：该池未领名单已变化，失效缓存让下次刷新取新值
          bumpStat('claim');
          log(T('msg.claimOk', { id }));
          toast(T('msg.claimOkBanner'), 'info');
        } finally {
          if (btn) btn.disabled = false;
        }
      } else if (act === 'refund') {
        await L.refund(id);
        log(T('msg.refundLog', { id }));
        toast(T('msg.refundOk'), 'info');
      } else if (act === 'share') {
        const v = poolCache.get(id) || allPools.find((x) => x.id === id);
        await sharePool(v);
        return;   // 分享不刷新列表
      } else if (act === 'detail') {
        await showPoolDetail(id);
        return;   // 只是看，不刷新列表
      }

      if (currentTab === 'pools') await refreshPools().catch(() => {});
      if (currentTab === 'me')    await refreshMyPage().catch(() => {});
      if (currentTab === 'admin') await refreshAdminPage().catch(() => {});
      await refreshBalance().catch(() => {});
    } catch (e) {
      fail(e, T('err.action'));
    }
  }

  // =====================================================================
  // 创建
  // =====================================================================
  function renderTierList() {
    const el = $('tierList');
    if (!el) return;
    // 只展示当前合约版本真正支持的档位（线上 0.1.0 → 只有 0/1/2）。
    // 详见 lottery.js 的 availableTiers()。
    const tiers = L.availableTiers();
    if (!tiers.some((t) => t.id === Number(selectedTier))) {
      selectedTier = tiers.length ? tiers[0].id : Number(C.defaultTier || 0);
    }
    el.innerHTML = tiers.map((t) => `
      <div class="tier-card ${t.id === selectedTier ? 'selected' : ''}" data-tier="${t.id}">
        <h3>${t.label}<span class="badge">${T('create.peopleFull', { n: t.people })}</span></h3>
        <div class="meta">${T('create.perJoin')}<b>${t.joinPaxi}</b> PAXI + <b>${L.fmtWan(t.joinTkcc)}</b> ${SYM()}</div>
        <div class="meta">${T('create.fee')}<b>${t.createPaxi}</b> PAXI + <b>${L.fmtWan(t.createTkcc)}</b> ${SYM()}${T('create.feeNote')}</div>
      </div>
    `).join('');
    el.querySelectorAll('.tier-card').forEach((card) => {
      card.onclick = () => {
        selectedTier = Number(card.dataset.tier);
        renderTierList();
        updateCostBox();
      };
    });
  }

  /** 创建页费用 + 余额校验 */
  function updateCostBox() {
    const tiers = L.availableTiers();
    const t = tiers.find((x) => x.id === Number(selectedTier)) || tiers[0] || C.tiers[0];
    const needPaxi = BigInt(L.paxiToRaw(t.createPaxi));
    const needTkcc = BigInt(L.tkccToRaw(t.createTkcc, tkccInfo.decimals));
    const hasPaxi = BigInt(balPaxiRaw || '0');
    const hasTkcc = BigInt(balTkccRaw || '0');
    const ok = hasPaxi >= needPaxi && hasTkcc >= needTkcc;

    $('costCreate').textContent = `${t.createPaxi} PAXI + ${L.fmtWan(t.createTkcc)} ${SYM()}`;
    const balEl = $('costBal');
    balEl.textContent = `${L.fmtPaxi(balPaxiRaw)} PAXI / ${L.fmtTkcc(balTkccRaw, tkccInfo.decimals)} ${SYM()}`;
    balEl.className = ok ? '' : 'short';

    const btn = $('btnCreate');
    btn.disabled = !ok;
    btn.textContent = ok
      ? T('create.btn')
      : T('create.btnShort');
  }

  // =====================================================================
  // 建池的随机种子承诺（Bug-5：commit-reveal 前端入口）
  // =====================================================================
  const SECRET_LS = nsKey('cj_pool_secrets');   // { [poolId]: secret }

  function loadSecrets() { return loadJSON(SECRET_LS); }
  function saveSecret(poolId, secret) {
    const m = loadSecrets();
    m[String(poolId)] = secret;
    saveJSON(SECRET_LS, m);
  }
  function getSecret(poolId) { return loadSecrets()[String(poolId)] || ''; }

  /** 承诺 sha256(secret)：用 hash.js（@noble/hashes），失败时退回空串由调用方提示 */
  function commitOf(secret) {
    try { return window.CJHash.sha256Hex(String(secret)); } catch (_) { return ''; }
  }

  /** 当前创建页选中的 secret（勾选后生效） */
  function currentSecret() {
    if (!$('useSeed') || !$('useSeed').checked) return '';
    return ($('seedSecret').value || '').trim();
  }

  function refreshSeedPreview() {
    const el = $('seedCommit');
    if (!el) return;
    if (!$('useSeed').checked) { el.textContent = ''; return; }
    const s = ($('seedSecret').value || '').trim();
    if (!s) { el.textContent = T('create.seedEmpty'); return; }
    const c = commitOf(s);
    el.textContent = c
      ? T('create.seedCommit', { c: c.slice(0, 16) + '…' + c.slice(-8) })
      : T('create.seedHashFail');
  }

  async function onCreate() {
    try {
      // commit-reveal：勾选后把 sha256(secret) 作为建池承诺提交
      let commitHash = null;
      const secret = currentSecret();
      if (secret) {
        commitHash = commitOf(secret);
        if (!commitHash) return banner(T('create.seedHashFail'), 'err');
      }
      const res = await L.createLottery({ tier: selectedTier, commitHash });
      log(T('msg.createOk') + (res.transactionHash ? ' tx=' + res.transactionHash : ''));

      // 建池成功后把 secret 按 lottery_id 存本机：揭示时要原样提交
      const pid = extractAttr(res, 'lottery_id');
      if (secret && pid) {
        saveSecret(pid, secret);
        log(T('msg.seedSaved', { id: pid }));
      }
      bumpStat('create');
      toast(secret ? T('msg.createOkSeedBanner') : T('msg.createOkBanner'), 'info');
      await S.syncNonce().catch(() => {});
      switchTab('me');
    } catch (e) {
      fail(e, T('err.create'));
    }
  }

  /** 从交易结果里取一个 wasm 事件属性（attributes 是 {key,value} 数组） */
  function extractAttr(res, key) {
    const attrs = (res && res.attributes) || [];
    for (const a of attrs) {
      if (a && a.key === key && a.value != null && a.value !== '') return a.value;
    }
    return '';
  }

  /** 揭示建池时承诺的 secret：优先用本机保存的，没有就让管理员/建池者手填 */
  async function onRevealSecret(id) {
    const preset = getSecret(id);
    const secret = preset || window.prompt(T('pools.revealPrompt', { id }));
    if (!secret) return;
    try {
      await L.revealSecret(id, secret.trim());
      log(T('msg.revealOk', { id }));
      toast(T('msg.revealOkBanner'), 'info');
      unclaimedCache.delete(id);
      if (currentTab === 'me') await refreshMyPage();
      else await refreshPools();
    } catch (e) {
      fail(e, T('err.reveal'));
    }
  }

  // =====================================================================
  // 充值 / 提现
  // =====================================================================
  async function onDeposit() {
    const amount = $('depAmount').value;
    const token = $('depToken').value;
    if (!amount || Number(amount) <= 0) return banner(T('msg.inputAmount'), 'warn');
    try {
      if (token === 'paxi') await L.depositPaxi(amount);
      else await L.depositTkcc(amount);
      log(T('msg.depositOk', { a: amount, t: token.toUpperCase() }));
      await refreshBalance();
      banner(T('msg.depositOkBanner'), 'info');
    } catch (e) { fail(e, T('err.deposit')); }
  }

  async function onWithdraw() {
    const amount = $('depAmount').value;
    const token = $('depToken').value;
    if (!amount || Number(amount) <= 0) return banner(T('msg.inputAmount'), 'warn');
    try {
      const raw = token === 'paxi'
        ? L.paxiToRaw(amount)
        : L.tkccToRaw(amount, tkccInfo.decimals);
      await L.withdraw(token === 'paxi' ? null : tkccInfo.token, raw);
      log(T('msg.withdrawOk', { a: amount, t: token.toUpperCase() }));
      await refreshBalance();
      banner(T('msg.withdrawOkBanner'), 'info');
    } catch (e) { fail(e, T('err.withdraw')); }
  }

  // =====================================================================
  // 管理员动作
  // =====================================================================
  async function onSetTkcc() {
    try {
      const target = C.tkccToken;
      if (!target) return banner(T('msg.noTkccInConfig'), 'err');
      await L.setTkccToken(target);
      log(T('msg.tkccWritten', { addr: target }));
      await refreshTkcc(true);
      banner(T('msg.tkccEnabled'), 'info');
    } catch (e) { fail(e, T('err.enableTkcc')); }
  }

  /**
   * 管理员自动启用 TKCC：连接后若合约还没写入 TKCC 地址，自动发起一次。
   * 交易必须由钱包确认（无法真正静默），这里省掉的是"找按钮 + 点按钮"。
   * 只试一次，失败则提示去管理页手动点。
   */
  let autoTkccTried = false;
  async function autoEnableTkcc() {
    if (autoTkccTried || !C.autoEnableTkcc) return;
    if (!isAdmin || !K.wallet.address || !C.tkccToken) return;
    // ⚠️ 只有「链上明确回答：还没配置」才值得自动写。
    //
    // tkcc 查询失败（节点超时 / 5xx / 限流）时 configured 也是 false，
    // 以前这里只看 configured → 每次打开页面都会自动发一笔 set_tkcc_token
    // 交易弹钱包（实测可复现），而链上其实早就配置好了；交易还会因为
    // 重复写入 / 本地签名对不上而失败，最后甩出一句"自动启用未成功"。
    // chainOk 为 false 时一律不自动发交易，管理员可在管理页手动点一次。
    if (!tkccInfo.chainOk || tkccInfo.configured) return;
    autoTkccTried = true;
    log(T('msg.tkccAutoStart'));
    try {
      await L.setTkccToken(C.tkccToken);
      log(T('msg.tkccAutoOk', { addr: C.tkccToken }));
      await refreshTkcc(true);
      banner(T('msg.tkccAutoOk', { addr: C.tkccToken }), 'info');
    } catch (e) {
      log(T('msg.tkccAutoFail') + ' (' + (e && e.message ? e.message : e) + ')');
      banner(T('msg.tkccAutoFail'), 'warn');
    }
  }
  async function onSetTreasury() {
    try {
      if (!C.treasury) return banner(T('msg.noTreasuryInConfig'), 'err');
      await L.setTreasury(C.treasury);
      log(T('msg.treasuryWritten', { v: C.treasury }));
      await refreshContractInfo();
    } catch (e) { fail(e, T('err.setTreasury')); }
  }
  async function onSetBurnMode() {
    try {
      const mode = $('burnMode').value;
      await L.setTkccBurnMode(mode);
      log(T('msg.burnModeSet', { m: mode }));
      await refreshTkcc(true);
    } catch (e) { fail(e, T('err.setBurnMode')); }
  }
  async function onSetBurn() {
    const address = $('burnAddr').value.trim();
    if (!address) return banner(T('msg.burnAddrRequired'), 'warn');
    try {
      await L.setTkccBurnAddress(address);
      log(T('msg.burnSet', { a: address }));
      await refreshTkcc(true);
    } catch (e) { fail(e, T('err.setBurn')); }
  }

  // =====================================================================
  // 事件绑定（全部走 guardBusy，防手机连点）
  // =====================================================================
  $('btnConnect').onclick  = () => guardBusy($('btnConnect'), () => onConnect());
  $('btnSession').onclick  = () => guardBusy($('btnSession'), () => onSession());
  $('btnCreate').onclick   = () => guardBusy($('btnCreate'), () => onCreate());
  $('btnDeposit').onclick  = () => guardBusy($('btnDeposit'), () => onDeposit());
  $('btnWithdraw').onclick = () => guardBusy($('btnWithdraw'), () => onWithdraw());
  $('btnRefresh').onclick  = () => refreshPools().catch((e) => banner(e.message || String(e), 'err'));
  $('fStatus').onchange    = () => refreshPools().catch(() => {});
  $('btnSetTkcc').onclick     = () => guardBusy($('btnSetTkcc'), () => onSetTkcc());
  $('btnSetTreasury').onclick = () => guardBusy($('btnSetTreasury'), () => onSetTreasury());
  $('btnSetBurnMode').onclick = () => guardBusy($('btnSetBurnMode'), () => onSetBurnMode());
  $('btnSetBurn').onclick     = () => guardBusy($('btnSetBurn'), () => onSetBurn());

  // ---- 创建页：随机种子承诺 ----
  if ($('useSeed')) {
    $('useSeed').onchange = () => refreshSeedPreview();
    $('seedSecret').oninput = () => refreshSeedPreview();
    $('btnGenSeed').onclick = () => {
      const s = L.randomSecret();
      $('seedSecret').value = s;
      $('useSeed').checked = true;
      refreshSeedPreview();
      toast(T('create.seedGenOk'), 'info');
    };
  }

  // ---- 管理页：官方模板池 ----
  // 面板整块藏在 #tplSection 里（config.showTemplatePools 控制），绑定前先判空：
  // 将来若某站彻底删掉这块 DOM，这里不会 TypeError 打断后面所有初始化。
  if ($('btnGenTplSecret')) {
    $('btnGenTplSecret').onclick = () => {
      const s = L.randomSecret();
      $('tplSecret').value = s;
      const c = commitOf(s);
      $('tplCommit').value = c;
      $('tplCommitHint').textContent = c ? T('admin.tplCommitHint', { c }) : T('create.seedHashFail');
    };
  }
  if ($('btnCreateTpl')) $('btnCreateTpl').onclick = () => guardBusy($('btnCreateTpl'), () => onCreateTemplate());

  // ---- 管理页：多签提案 ----
  // 默认 config.showMultisig = false → 整块不显示；绑定照旧，改配置即恢复入口。
  if ($('msAction')) $('msAction').onchange = () => refreshMsHint();
  if ($('btnPropose'))         $('btnPropose').onclick         = () => guardBusy($('btnPropose'), () => onPropose());
  if ($('btnQueryProposal'))   $('btnQueryProposal').onclick   = () => guardBusy($('btnQueryProposal'), () => onQueryProposal());
  if ($('btnConfirmProposal')) $('btnConfirmProposal').onclick = () => guardBusy($('btnConfirmProposal'), () => onConfirmProposal());
  if (window.CJ_I18N) $('btnLang').onclick = () => window.CJ_I18N.toggle();

  // 语言切换：i18n.js 已自动套用静态 data-i18n 文案，这里重渲染动态内容
  // （卡片、横幅、倒计时、无感状态、TKCC 状态、费用框、档位卡片）
  window.addEventListener('lang-changed', () => {
    refreshSessionCard();
    refreshSessionStatus().catch(() => {});
    // 切语言是纯本地操作：只重渲 TKCC 文案，不再 await resolveTkcc() 打 LCD
    renderTkccUI();
    updateCostBox();
    refreshSeedPreview();
    renderTierList();
    renderStats();
    renderTemplateTierOptions();
    refreshTemplates().catch(() => {});
    refreshMultisig().catch(() => {});
    if (currentTab === 'pools')      refreshPools().catch(() => {});
    else if (currentTab === 'me')    refreshMyPage().catch(() => {});
    else if (currentTab === 'admin') refreshAdminPage().catch(() => {});
  });

  // 倒计时每秒就地刷新（只改文字，不重渲列表；跨过 1 小时自动变红）
  setInterval(() => {
    document.querySelectorAll('.left[data-expires]').forEach((el) => {
      const p = countdownParts(Number(el.dataset.expires));
      el.textContent = p.text;
      el.classList.toggle('soon', p.soon);
    });
  }, 1000);

  // =====================================================================
  // 初始化
  // =====================================================================
  // 奖池合约尚未部署的站点（config.deployed === false）：只给提示，不初始化。
  // 否则会对一个不存在的合约反复发查询，界面全是报错、看起来像"坏了"。
  if (C.deployed === false) {
    const nb = $('banner');
    if (nb) {
      nb.hidden = false;
      nb.className = 'banner warn';
      nb.textContent = C.notDeployedMsg || T('msg.siteNotDeployed');
    }
    return;
  }

  parseSharedPool();
  renderTierList();
  refreshSessionCard();
  refreshSessionStatus().catch(() => {});
  updateCostBox();
  switchTab('pools');
  refreshTkcc(true).catch(() => {});
  renderStats();

  // 合约版本 → 可用档位。
  // 初始渲染时版本未知，availableTiers() 只返回基础档（安全默认）；这里拉一次
  // 链上 contract_version 后再校正：线上 0.1.0 无变化，合约迁到 0.2.0(v2) 后
  // 会自动多出 tier 3/4，无需改代码。
  (async () => {
    try {
      await L.contractVersion();
      renderTierList();
      updateCostBox();
    } catch (_) { /* 版本拿不到就维持基础档 */ }
  })();

  const isWechat = /MicroMessenger/i.test(navigator.userAgent);
  if (isWechat) {
    setTimeout(() => {
      banner(T('msg.wechatTip'), 'warn');
    }, 1200);
  }

  // 轮询（仅前台 + 当前 tab）
  if (C.pollInterval > 0) {
    setInterval(() => {
      if (document.visibilityState !== 'visible' || !K.wallet.address) return;
      if (currentTab === 'pools') refreshPools().catch(() => {});
      if (currentTab === 'me')    refreshMyPage().catch(() => {});
    }, C.pollInterval);
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && K.wallet.address) {
      if (currentTab === 'pools') refreshPools().catch(() => {});
      if (currentTab === 'me')    refreshMyPage().catch(() => {});
    }
  });

  // ---------- PaxiHub 桥接异步注入 + 深链 ----------
  (async () => {
    const ok = await K.waitForWallet(6000);
    if (ok) { await onConnect().catch(() => {}); return; }

    // 已经在 PaxiHub 里（UA 或 bridge 残留）→ 不要再往外跳
    const inHub = /PaxiHub|paxihub/i.test(navigator.userAgent) || !!window.paxihub;
    if (inHub) {
      banner(T('msg.inHubWait'), 'warn');
      return;
    }

    if (/Mobi/i.test(navigator.userAgent)) {
      banner(T('msg.deepLinking'), 'warn');
      const b = $('banner');
      if (b) {
        b.style.cursor = 'pointer';
        b.onclick = () => {
          window.location.href = `paxi://hub/explorer?url=${encodeURIComponent(window.location.href)}`;
        };
      }

      let leftBrowser = false;
      const onVis = () => { if (document.hidden) leftBrowser = true; };
      document.addEventListener('visibilitychange', onVis);

      // 用隐藏 iframe 触发：未安装时 iOS 不会弹"无法打开页面"
      const deep = `paxi://hub/explorer?url=${encodeURIComponent(window.location.href)}`;
      const ifr = document.createElement('iframe');
      ifr.style.cssText = 'display:none;width:0;height:0;';
      ifr.src = deep;
      document.body.appendChild(ifr);
      setTimeout(() => { try { document.body.removeChild(ifr); } catch (_) {} }, 800);

      // 2.5s 后仍未离开浏览器 → 跳商店
      setTimeout(() => {
        document.removeEventListener('visibilitychange', onVis);
        if (!leftBrowser) {
          window.location.href = 'https://paxinet.io/paxi_docs/paxihub#paxihub-application';
        }
      }, 2500);
    } else {
      banner(T('msg.notInHub'), 'warn');
    }
  })();
})();

/* =====================================================================
 * lottery.js —— 抽奖合约调用封装（纯查询 / 交易，不含 UI）
 * ===================================================================== */
(function () {
  const C = window.CJ_CONFIG;
  const K = window.CJChain;
  // 轻量翻译：i18n 就绪前回退原文（防止合约未加载时 t 不存在）
  const ti = (k, p) => (window.CJ_I18N ? window.CJ_I18N.t(k, p) : k);

  // ---------- 元信息 ----------
  async function tkcc() {
    return K.queryContract({ tkcc: {} });
  }

  async function config() {
    return K.queryContract({ lottery_config: {} });
  }

  async function contractConfig() {
    return K.queryContract({ config: {} });
  }

  // ---------- 合约版本 / 档位门控 ----------
  /**
   * 链上合约版本号（`contract_version`），查询失败为空串。
   *
   * 【为什么需要】线上合约是 0.1.0，`tier_spec()` 只认 tier 0/1/2；
   * 而 config.js 里还有 v2 才新增的 tier 3/4。若前端不看版本就把 5 个档位
   * 全展示出来，用户选中 tier 3/4 后合约会以
   * "Invalid tier 3: must be 0 (5 people) / 1 (20 people) / 2 (50 people)"
   * 拒绝 —— 用户看到的是一句英文错误，钱和 gas 已经花了。
   * 这里读一次合约版本并缓存，由 availableTiers() 决定展示哪些档位。
   */
  let _contractVersion = '';
  async function contractVersion() {
    if (_contractVersion) return _contractVersion;
    try {
      const cfg = await contractConfig();
      _contractVersion = String((cfg && cfg.contract_version) || '');
    } catch (_) { _contractVersion = ''; }
    return _contractVersion;
  }

  /** 语义化版本比较：返回 a-b 的符号；解析不出的段按 0 处理 */
  function cmpSemver(a, b) {
    const pa = String(a || '').split('.').map((x) => parseInt(x, 10) || 0);
    const pb = String(b || '').split('.').map((x) => parseInt(x, 10) || 0);
    for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
      const d = (pa[i] || 0) - (pb[i] || 0);
      if (d) return d;
    }
    return 0;
  }

  /**
   * 当前合约真正支持的档位。
   * `tier.minVersion` = 该档位要求的最低合约版本（未标注 = 所有版本都支持）。
   * 版本未知（尚未查到 / 查询失败）时只返回基础档 —— 宁可少显示，
   * 也绝不让用户选中一个合约必然拒绝的档位。
   */
  function availableTiers() {
    return C.tiers.filter((t) =>
      !t.minVersion || (!!_contractVersion && cmpSemver(_contractVersion, t.minVersion) >= 0));
  }

  /** 单个档位是否被当前合约支持（建池前的最后一道闸） */
  function tierSupported(tier) {
    const t = C.tiers.find((x) => x.id === Number(tier));
    if (!t) return false;
    if (!t.minVersion) return true;
    return !!_contractVersion && cmpSemver(_contractVersion, t.minVersion) >= 0;
  }

  async function resolveTkcc() {
    const info = await tkcc().catch(() => null);
    const token = (info && info.token) || C.tkccToken || '';
    let dec = (info && info.decimals != null) ? Number(info.decimals) : null;
    let symbol = 'TKCC';

    if (dec == null && token) {
      // ⚠️ 变量名不能叫 ti —— 会遮蔽外层翻译助手 ti()
      const tinfo = await tkccTokenInfo(token);
      if (tinfo) {
        if (tinfo.decimals != null) dec = Number(tinfo.decimals);
        if (tinfo.symbol) symbol = tinfo.symbol;
      }
    }
    if (dec == null) dec = C.tkccDecimals;

    return {
      token,
      decimals: dec,
      symbol,
      configured: !!(info && info.configured),
      burnMode: (info && info.burn_mode) || null,
      burnAddress: (info && info.burn_address) || null,
    };
  }

  async function tkccTokenInfo(token) {
    const addr = token || C.tkccToken;
    if (!addr) return null;
    return K.queryContract({ token_info: {} }, addr).catch(() => null);
  }

  function tkccToRaw(human, decimals) {
    return K.toRaw(human, decimals == null ? C.tkccDecimals : decimals);
  }
  function paxiToRaw(human) {
    return K.toRaw(human, C.coinDecimals);
  }

  // ---------- 查询 ----------
  const lottery = (id) => K.queryContract({ lottery: { id: Number(id) } });
  // start_after：合约支持游标分页，翻下一页时传上一页最后一个 id
  const lotteries = (status, limit = 30, startAfter = null) =>
    K.queryContract({ lotteries: { status: status || null, start_after: startAfter, limit } });
  const participants = (id) => K.queryContract({ participants: { id: Number(id) } });
  const winners = (id) => K.queryContract({ winners: { id: Number(id) } });
  const payout = (id) => K.queryContract({ payout: { id: Number(id) } });
  const unclaimed = (id) => K.queryContract({ unclaimed: { id: Number(id) } });
  const balance = (addr, token) => K.queryContract({ balance: { address: addr, token: token || null } });
  const balances = (addr) => K.queryContract({ balances: { address: addr } });

  // ---------- 交易 ----------
  async function depositPaxi(humanAmount) {
    const amount = paxiToRaw(humanAmount);
    return K.execute({ deposit: {} }, [{ denom: C.coinMinimalDenom, amount }], {
      gas: 400000,
      memo: 'deposit paxi',
    });
  }

  async function depositTkcc(humanAmount) {
    const { token, decimals } = await resolveTkcc();
    if (!token) throw new Error(ti('err.tkccNotConfiguredLottery'));
    const amount = tkccToRaw(humanAmount, decimals);
    // hook 走 UTF-8 字节再 base64，避免多字节内容出现编码歧义
    const hook = K.toBase64(new TextEncoder().encode(JSON.stringify({ deposit: {} })));
    return K.execute(
      { send: { contract: C.contract, amount, msg: hook } },
      [],
      { gas: 500000, contract: token, memo: 'deposit tkcc' }
    );
  }

  async function withdraw(token, rawAmount) {
    return K.execute({ withdraw: { token: token || null, amount: String(rawAmount) } }, [], {
      gas: 450000,
      memo: 'withdraw',
    });
  }

  /** 建池：选档位 + 可选的随机种子承诺（commit-reveal）。
   *
   * Bug-5 修复：旧实现把 commit_hash 写死成 null，合约的 commit-reveal 分支
   * 成了永远走不到的死代码。现在 `commitHash` 为空才走区块熵兜底。 */
  async function createLottery(opts) {
    const { tier, commitHash } = opts;
    const t = C.tiers.find((x) => x.id === Number(tier));
    if (!t) throw new Error(ti('err.invalidTier'));
    // 合约版本门控：线上合约不支持的档位（如 0.1.0 上的 tier 3/4）提前拦下，
    // 给出可读提示，而不是让链上回一句英文 "Invalid tier" 白扣 gas。
    if (!tierSupported(tier)) throw new Error(ti('err.tierNotSupported', { v: t.minVersion }));
    const tkccInfo = await resolveTkcc();
    const feeTkccRaw = tkccToRaw(t.createTkcc, tkccInfo.decimals);
    const feePaxiRaw = paxiToRaw(t.createPaxi);
    const totalAmount = (BigInt(feeTkccRaw) + BigInt(feePaxiRaw)).toString();
    return K.execute(
      {
        create_lottery: {
          tier: Number(tier),
          commit_hash: commitHash || null,
        },
      },
      [],
      {
        gas: 700000,
        session: { action: 'create_lottery', roundId: '0', amount: totalAmount },
        memo: 'create lottery',
      }
    );
  }

  /** A 模式：建池者揭示建池时承诺的 secret（满员后、开奖前必须做） */
  function revealSecret(id, secret) {
    if (!secret) throw new Error(ti('err.secretRequired'));
    return K.execute({ reveal_secret: { id: Number(id), secret: String(secret) } }, [], {
      gas: 350000, memo: 'reveal secret',
    });
  }

  /** 生成一个 64 位 hex 随机 secret（模板哈希链要求 secret 本身是 64-hex） */
  function randomSecret() {
    const b = new Uint8Array(32);
    (globalThis.crypto || window.crypto).getRandomValues(b);
    return Array.from(b).map((x) => x.toString(16).padStart(2, '0')).join('');
  }

  /** 参与：joinTkccRaw / joinPaxiRaw 必须是链上 raw（用于无感签名原文） */
  async function joinLottery(id, joinTkccRaw, joinPaxiRaw) {
    const totalAmount = (BigInt(joinTkccRaw) + BigInt(joinPaxiRaw)).toString();
    return K.execute(
      { join_lottery: { id: Number(id) } },
      [],
      {
        gas: 600000,
        session: { action: 'join_lottery', roundId: String(id), amount: totalAmount },
        memo: 'join lottery',
      }
    );
  }

  const drawLottery = (id) =>
    K.execute({ draw_lottery: { id: Number(id) } }, [], { gas: 800000, memo: 'draw lottery' });

  const claim = (id) =>
    K.execute({ claim: { id: Number(id) } }, [], { gas: 500000, memo: 'claim prize' });

  const refund = (id) =>
    K.execute({ refund: { id: Number(id) } }, [], { gas: 500000, memo: 'refund' });

  // ---------- 管理员：官方模板池（Bug-6：前端此前完全没有入口）----------
  const poolTemplates = () => K.queryContract({ pool_templates: {} });
  const poolTemplate = (id) => K.queryContract({ pool_template: { id: Number(id) } });
  const activePoolOfTemplates = () => K.queryContract({ active_pool_of_templates: {} });

  /**
   * 创建官方模板。
   * `commitHash` = 平台 secret 的 sha256 hex（哈希链链头）。
   * 不提交的模板，其池子**永远无法开奖**（只能退款），这是合约的刻意设计。
   */
  function createPoolTemplate(name, tier, commitHash) {
    const n = String(name || '').trim();
    if (!n) throw new Error(ti('admin.tplNameRequired'));
    return K.execute(
      {
        create_pool_template: {
          name: n,
          tier: Number(tier),
          commit_hash: commitHash || null,
        },
      },
      [],
      { gas: 400000, memo: 'create pool template' }
    );
  }

  /** 启停模板（停用不影响已有活跃池，让当前池跑完） */
  function updatePoolTemplate(id, active) {
    return K.execute({ update_pool_template: { id: Number(id), active: !!active } }, [], {
      gas: 300000, memo: 'update pool template',
    });
  }

  /** 揭示模板的平台托管 secret（走 AdminCustom → 哈希链轮换） */
  function revealTemplateSecret(templateId, secret) {
    if (!secret) throw new Error(ti('err.secretRequired'));
    return K.execute(
      {
        admin_custom: {
          reveal_template_secret: {
            template_id: Number(templateId),
            secret: String(secret),
          },
        },
      },
      [],
      { gas: 400000, memo: 'reveal template secret' }
    );
  }

  // ---------- 管理员：多签提案（Bug-7）----------
  /**
   * 发起管理提案。`action` 是 paxi_common::AdminAction 的 JSON 形态，例如
   *   { set_treasury: { treasury: 'paxi1...' } }
   *   { set_paused: { paused: true } }
   * 合约特有动作走 custom：payload 为 **base64(LotteryAdminAction JSON)**。
   */
  function proposeAdminAction(action) {
    if (!action) throw new Error(ti('err.proposalActionRequired'));
    return K.execute({ propose_admin_action: { action } }, [], {
      gas: 400000, memo: 'propose admin action',
    });
  }

  /** 确认提案；达到阈值时合约在同一笔交易内原子执行该动作 */
  function confirmAdminAction(id) {
    return K.execute({ confirm_admin_action: { id: Number(id) } }, [], {
      gas: 600000, memo: 'confirm admin action',
    });
  }

  /** 查询单个提案（合约只有按 id 单查，没有列表接口） */
  const proposal = (id) => K.queryContract({ proposal: { id: Number(id) } });

  /** 合约特有动作打包成 AdminAction::Custom（payload 需 base64） */
  function customAdminAction(label, lotteryAction) {
    return {
      custom: {
        label,
        payload: K.toBase64(new TextEncoder().encode(JSON.stringify(lotteryAction))),
      },
    };
  }

  // ---------- 管理员：TKCC 集成 ----------
  function setTkccToken(token) {
    const t = token || C.tkccToken;
    if (!t) throw new Error(ti('err.noTkccParam'));
    return K.execute({ admin: { set_tkcc_token: { token: t } } }, [], {
      gas: 300000, memo: 'set tkcc token',
    });
  }
  function setTkccBurnAddress(address) {
    if (!address) throw new Error(ti('msg.burnAddrRequired'));
    return K.execute({ admin: { set_tkcc_burn_address: { address } } }, [], {
      gas: 300000, memo: 'set tkcc burn address',
    });
  }
  function setTkccBurnMode(mode) {
    return K.execute({ admin: { set_tkcc_burn_mode: { mode } } }, [], {
      gas: 300000, memo: 'set tkcc burn mode',
    });
  }
  function setTreasury(treasury) {
    const t = treasury || C.treasury;
    if (!t) throw new Error(ti('err.noTreasuryParam'));
    return K.execute({ admin: { set_treasury: { treasury: t } } }, [], {
      gas: 300000, memo: 'set treasury',
    });
  }

  // ---------- 展示辅助 ----------
  const statusKeys = {
    open: 'status.open',
    full: 'status.full',
    drawn: 'status.drawn',
    refunded: 'status.refunded',
    cancelled: 'status.cancelled',
    expired: 'status.expired',
  };

  /** 状态文案：i18n 就绪时翻译，未就绪/未知状态回退原文 */
  function statusText(status) {
    const k = statusKeys[status] || '';
    return (k && window.CJ_I18N ? window.CJ_I18N.t(k) : '') || k || status || '';
  }

  /** 去掉小数末尾多余的 0：1.000000 → 1，4.003889 → 4.003889，27.062733 → 27.062733 */
  function trimZeros(s) {
    const t = String(s);
    if (t.indexOf('.') < 0) return t;
    return t.replace(/0+$/, '').replace(/\.$/, '');
  }

  /** 整数个数 → 中文「万」：10000 → 1万，15000 → 1.5万，9999 → 9,999
   *  英文环境下不用「万」，直接千分位显示 */
  function fmtWan(count) {
    let n;
    try { n = BigInt(String(Math.trunc(Number(count)) || 0)); } catch (_) { n = 0n; }
    const en = !!(window.CJ_I18N && window.CJ_I18N.getLang() === 'en');
    if (en) return Number(n).toLocaleString('en-US');
    if (n < 10000n) return Number(n).toLocaleString('zh-CN');
    const wan = n / 10000n;
    const rest = n % 10000n;
    if (rest === 0n) return wan.toLocaleString('zh-CN') + '万';
    // 保留两位小数再去掉多余的 0
    const frac = rest.toString().padStart(4, '0').slice(0, 2);
    return trimZeros(wan.toLocaleString('zh-CN') + '.' + frac) + '万';
  }

  /** PAXI：整数显示，无小数就不带 .000000 */
  function fmtPaxi(raw) { return trimZeros(K.fmt(raw, C.coinDecimals)); }

  /** TKCC：≥ 1 万走「万」，否则正常显示（都去掉多余 0） */
  function fmtTkcc(raw, decimals) {
    const d = decimals == null ? C.tkccDecimals : decimals;
    const full = trimZeros(K.fmt(raw, d));
    let intPart;
    try {
      intPart = BigInt(String(raw || '0')) / (10n ** BigInt(d));
    } catch (_) { return full; }
    if (intPart < 10000n) return full;
    return fmtWan(intPart.toString());
  }

  /**
   * 判断一个 Uint128 序列化出来的字符串是否"非零"。
   *
   * 旧写法 `x && x !== '0'` 有两个漏洞：
   * 1. 前导零（"0000"）会被判成有效值，误用 settled 快照；
   * 2. 空字符串 / 非数字字符串的行为不明确。
   * 合约目前用 Uint128 序列化不会出现前导零，但按数值判定成本为零且永不出错。
   */
  function isNonZeroRaw(x) {
    try {
      const s = String(x == null ? '' : x).trim();
      if (!s) return false;
      return BigInt(s) > BigInt(0);
    } catch (_) { return false; }
  }

  function toView(l, tkccDecimals) {
    const tier = C.tiers.find((t) => t.id === Number(l.tier));
    const expiresAt = Number(l.expires_at) * 1000;
    // 开奖后 pool_* 归零，历史奖池在 settled_pool_*（按数值判定，不比字符串）
    const poolPaxiRaw = isNonZeroRaw(l.settled_pool_paxi) ? l.settled_pool_paxi : l.pool_paxi;
    const poolTkccRaw = isNonZeroRaw(l.settled_pool_tkcc) ? l.settled_pool_tkcc : l.pool_tkcc;
    const expired = expiresAt < Date.now();
    // 统一派生"可操作状态"：链上 open 只代表"未开奖"，一个正在收人的池
    // 与一个时间到了、没满员、只能退款的死池，链上状态都是 open。
    // 这里把它俩拆开，让排序 / 徽章 / 退款按钮全部由同一份派生状态驱动，不再自相矛盾。
    const statusView = (l.status === 'open' && expired) ? 'expired' : l.status;
    return {
      id: l.id,
      creator: l.creator,
      tier: l.tier,
      tierLabel: tier ? tier.label : ti('common.tier') + l.tier,
      joinPaxi: fmtPaxi(l.join_paxi),
      joinPaxiRaw: l.join_paxi,
      joinTkcc: fmtTkcc(l.join_tkcc, tkccDecimals),
      joinTkccRaw: l.join_tkcc,
      maxPeople: l.max_people,
      // 开奖后 pool_* 归零，历史奖池在 settled_pool_*
      poolPaxi: fmtPaxi(poolPaxiRaw),
      poolTkcc: fmtTkcc(poolTkccRaw, tkccDecimals),
      // raw 值：UI 里算"预计一等奖"必须用它，
      // 用格式化字符串反解会把 fmtWan 的「万」算成 NaN
      poolPaxiRaw,
      poolTkccRaw,
      count: l.participant_count,
      status: l.status,            // 链上原始状态（退款判定 / 过滤仍用它）
      statusView,                  // 派生"可操作状态"（排序 + 徽章用）
      statusText: statusText(statusView),
      expired,
      expiresAt,
      expiresText: new Date(expiresAt).toLocaleString(
        window.CJ_I18N && window.CJ_I18N.getLang() === 'en' ? 'en-US' : 'zh-CN'
      ),
      winners: l.winners,
      payout: l.payout,
      seed: l.seed,
      // A 模式：建池者承诺 / 已揭示的种子（前端据此显示"揭示种子"按钮）
      commitHash: l.commit_hash || null,
      revealed: l.revealed || null,
      randomSource: l.random_source,
      isTemplatePool: !!l.is_template_pool,
      templateId: l.template_id == null ? null : l.template_id,
    };
  }

  window.CJLottery = {
    tkcc, tkccTokenInfo, config, contractConfig, resolveTkcc,
    contractVersion, cmpSemver, availableTiers, tierSupported,
    lottery, lotteries, participants, winners, payout, unclaimed, balance, balances,
    poolTemplates, poolTemplate, activePoolOfTemplates, proposal,
    depositPaxi, depositTkcc, withdraw,
    createLottery, joinLottery, drawLottery, claim, refund, revealSecret, randomSecret,
    createPoolTemplate, updatePoolTemplate, revealTemplateSecret,
    proposeAdminAction, confirmAdminAction, customAdminAction,
    setTkccToken, setTkccBurnAddress, setTkccBurnMode, setTreasury,
    paxiToRaw, tkccToRaw, fmtPaxi, fmtTkcc, fmtWan, trimZeros, toView, statusText,
    isNonZeroRaw,
  };
})();

/* =====================================================================
 * chain.js —— 钱包连接 + 链上查询 / 交易（仅支持 PaxiHub App）
 *
 * ⚠️ signAndSendTransaction 只签名不广播：拿到 result.success 后需自行
 *    组装 TxRaw 再 POST 到 LCD（见 executeViaPaxihub）。
 * ===================================================================== */
(function () {
  const C = window.CJ_CONFIG;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function fetchWithTimeout(url, opt = {}, ms = 15000) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), ms);
    try {
      return await fetch(url, { ...opt, signal: ctrl.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  const toBase64 = (bytes) => {
    // bytes 可以是字符串（兼容旧代码）或 Uint8Array
    if (typeof bytes === 'string') {
      return btoa(unescape(encodeURIComponent(bytes)));
    }
    // Uint8Array → base64
    let binary = '';
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    return btoa(binary);
  };

  /** raw → 人类可读（整数/小数分段换算，raw > 2^53 也不丢精度） */
  function fmt(raw, dec) {
    // raw 是**最小单位整数**（如 upaxi），需要除以 10^dec 得到人类可读值。
    // 全程用字符串 + BigInt，避免浮点误差和 > 2^53 精度丢失。
    if (raw === null || raw === undefined || raw === '') return '0';
    let s = String(raw).trim();
    const neg = s.startsWith('-');
    if (neg) s = s.slice(1);
    // 补足到至少 dec+1 位（保证整数部分至少 1 位）
    s = s.padStart(dec + 1, '0');
    const intPart = s.slice(0, s.length - dec) || '0';
    const fracPart = dec > 0 ? s.slice(s.length - dec) : '';
    let out = BigInt(intPart).toLocaleString('zh-CN');
    if (fracPart) out += '.' + fracPart;
    return (neg ? '-' : '') + out;
  }

  /** public_key / pubkey 兼容：钱包可能返回数组（Uint8Array / Array），也可能返回 base64 字符串 */
  function pkToHex(pk) {
    if (pk == null) return '';
    if (typeof pk === 'string') {
      // getAddress() 可能直接返回 hex 字符串，此时 atob 会解出乱码。
      // 压缩公钥 33 字节 = 66 hex，非压缩 65 字节 = 130 hex。
      if (/^[0-9a-fA-F]+$/.test(pk) && (pk.length === 66 || pk.length === 130)) {
        return pk.toLowerCase();
      }
      // base64 字符串 → decode 后转 hex
      const bin = atob(pk);
      return Array.from(bin).map((c) => c.charCodeAt(0).toString(16).padStart(2, '0')).join('');
    }
    // Uint8Array / Array → 直接转
    return Array.from(pk).map((b) => b.toString(16).padStart(2, '0')).join('');
  }

  /** 人类可读 → raw（字符串拼接，避免浮点误差） */
  function toRaw(human, dec) {
    const s = String(human).trim();
    if (!s) return '0';
    const neg = s.startsWith('-');
    const body = neg ? s.slice(1) : s;
    const [int, frac = ''] = body.split('.');
    const f = (frac + '0'.repeat(dec)).slice(0, dec);
    const v = (BigInt(int || '0') * BigInt(Math.pow(10, dec)) + BigInt(f || '0')).toString();
    return neg ? '-' + v : v;
  }

  // =====================================================================
  // RPC 直查兜底（LCD 不可用时）
  //
  // Paxi 主网的 LCD 是**单点**：它一旦 5xx / 超时，下面所有读接口会一起失败，
  // 界面上表现为「奖池一直转圈」；更糟的是 buildCommon 拿不到 account_number
  // 就报「账户尚未在链上初始化」——把节点故障说成用户账户的问题，用户会白
  // 转一笔 PAXI 过来，而问题其实在节点侧。
  //
  // 但 RPC（config.rpc）的 /abci_query 走的是同一条链的应用层查询路由，
  // 不需要 LCD 就能取到：账户号 / 序号、余额、合约 smart 查询结果。
  // 这里做一层兜底：**只在 LCD 失败时才启用**，LCD 健康时行为完全不变。
  // 交易广播仍走原路径（签名后 POST LCD），本层只负责读。
  // =====================================================================
  const PB_TE = new TextEncoder();
  const PB_TD = new TextDecoder();

  /** 无符号整数 → protobuf varint（用 BigInt，account_number 可能超 2^53） */
  function pbVarint(n) {
    let v = BigInt(n);
    const out = [];
    do {
      let b = Number(v & 0x7fn);
      v >>= 7n;
      if (v > 0n) b |= 0x80;
      out.push(b);
    } while (v > 0n);
    return Uint8Array.from(out);
  }
  function pbCat(list) {
    let len = 0;
    for (const u of list) len += u.length;
    const out = new Uint8Array(len);
    let off = 0;
    for (const u of list) { out.set(u, off); off += u.length; }
    return out;
  }
  const pbTag = (no, wt) => pbVarint((BigInt(no) << 3n) | BigInt(wt));
  /** 编码 string 字段 */
  function pbStr(no, s) {
    const b = PB_TE.encode(s);
    return pbCat([pbTag(no, 2), pbVarint(b.length), b]);
  }
  /** 编码 bytes 字段 */
  function pbBytes(no, b) {
    return pbCat([pbTag(no, 2), pbVarint(b.length), b]);
  }
  /**
   * 极简 protobuf 解析：只解 varint(0) 与 length-delimited(2)，
   * 足够读 Account / Coin / QueryXxxResponse（其余 wire type 直接跳过）。
   * 返回 [{ no, wt, v }]：wt=2 时 v 是 Uint8Array，wt=0 时 v 是 BigInt。
   */
  function pbRead(buf) {
    const out = [];
    let i = 0;
    const uv = () => {
      let r = 0n, sh = 0n, x;
      do { x = buf[i++]; r |= BigInt(x & 0x7f) << sh; sh += 7n; } while (x & 0x80);
      return r;
    };
    while (i < buf.length) {
      const key = uv();
      const no = Number(key >> 3n);
      const wt = Number(key & 7n);
      if (wt === 0) out.push({ no, wt, v: uv() });
      else if (wt === 2) {
        const len = Number(uv());
        out.push({ no, wt, v: buf.subarray(i, i + len) });
        i += len;
      } else if (wt === 5) i += 4;
      else if (wt === 1) i += 8;
      else throw new Error('protobuf: 未知 wire type ' + wt);
    }
    return out;
  }
  const pbGet = (fields, no) => {
    const f = fields.find((x) => x.no === no);
    return f ? f.v : undefined;
  };

  const bytesToHex = (u8) => {
    let s = '';
    for (let i = 0; i < u8.length; i++) s += u8[i].toString(16).padStart(2, '0');
    return s;
  };
  const b64ToBytes = (b64) => {
    const bin = atob(b64);
    const u = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
    return u;
  };

  /**
   * 通过 RPC /abci_query 直接问应用层要数据。
   * path 必须是带引号的字符串字面量形式（Tendermint 参数解析要求），
   * data 是「请求消息」的 protobuf 字节（0x 前缀 hex）。
   * 返回 response.value 解码后的字节（查询结果消息的 protobuf）。
   */
  async function rpcAbciQuery(path, reqBytes) {
    const url = `${C.rpc}/abci_query?path=${encodeURIComponent(JSON.stringify(path))}`
      + `&data=0x${bytesToHex(reqBytes)}`;
    /** RPC 自身不可用（连不上 / 5xx / 参数被拒）→ 标 infra，调用方据此判断 */
    const infra = (msg) => { const e = new Error(msg); e.infra = true; return e; };
    let res;
    try {
      res = await fetchWithTimeout(url, {}, 12000);
    } catch (e) {
      throw infra('RPC 连接失败：' + (e.message || e));
    }
    if (!res.ok) throw infra('RPC 查询失败 HTTP ' + res.status);
    const j = await res.json();
    if (j && j.error) throw infra(j.error.message || 'RPC 查询失败');
    const r = (j && j.result && j.result.response) || {};
    if (r.code) {
      // code != 0 = 应用层拒绝了这次查询（合约报错 / 账户不存在…）→ 业务错误，
      // 原样抛出去；只有日志本身自述节点故障时才算 infra。
      const log = String(r.log || '').split('\n')[0] || ('RPC 查询失败 code=' + r.code);
      const e = new Error(log);
      e.infra = INFRA_ERR_RE.test(log);
      throw e;
    }
    return r.value ? b64ToBytes(r.value) : new Uint8Array(0);
  }

  /** RPC 兜底：合约 smart 查询 → 已解析的 JSON */
  async function rpcSmartQuery(address, queryJson) {
    const raw = await rpcAbciQuery(
      '/cosmwasm.wasm.v1.Query/SmartContractState',
      pbCat([pbStr(1, address), pbBytes(2, PB_TE.encode(queryJson))])
    );
    // QuerySmartContractStateResponse{ bytes data = 1 }
    const data = pbGet(pbRead(raw), 1);
    if (!data) throw new Error('RPC 兜底：合约未返回数据');
    return JSON.parse(PB_TD.decode(data));
  }

  /** RPC 兜底：账户号 / 序号（QueryAccountResponse{ Any account = 1 }） */
  async function rpcAccount(address) {
    const raw = await rpcAbciQuery('/cosmos.auth.v1beta1.Query/Account', pbStr(1, address));
    const any = pbGet(pbRead(raw), 1);
    if (!any) throw new Error('RPC 兜底：account not found（链上无此账户）');
    const value = pbGet(pbRead(any), 2);              // Any.value
    const ba = value ? pbRead(value) : [];            // BaseAccount
    const num = pbGet(ba, 3);                         // account_number
    if (num === undefined) throw new Error('RPC 兜底：账户缺少 account_number');
    return { accountNumber: String(num), sequence: String(pbGet(ba, 4) ?? 0n) };
  }

  /** RPC 兜底：全部余额（QueryAllBalancesResponse{ repeated Coin balances = 1 }） */
  async function rpcBalances(address) {
    const raw = await rpcAbciQuery('/cosmos.bank.v1beta1.Query/AllBalances', pbStr(1, address));
    return pbRead(raw)
      .filter((f) => f.no === 1)
      .map((f) => {
        const c = pbRead(f.v);                        // Coin{ denom = 1, amount = 2 }
        const d = pbGet(c, 1);
        const a = pbGet(c, 2);
        return { denom: d ? PB_TD.decode(d) : '', amount: a ? PB_TD.decode(a) : '0' };
      });
  }

  /** RPC 兜底：按 txhash 取交易结果（顶层补 events / logs，兼容 extractWasmAttrs） */
  async function rpcTxByHash(hash) {
    const res = await fetchWithTimeout(`${C.rpc}/tx?hash=0x${String(hash).replace(/^0x/, '')}`, {}, 10000);
    if (!res.ok) throw new Error(`RPC 查询交易失败 HTTP ${res.status}`);
    const j = await res.json();
    if (j && j.error) throw new Error(j.error.message || 'RPC 查询交易失败');
    const r = (j && j.result) || {};
    const tr = r.tx_result || {};
    if (tr.code === undefined) throw new Error('RPC：交易尚未上链');
    let logs = [];
    try { logs = JSON.parse(tr.log || '[]'); } catch (_) { logs = []; }
    return { ...tr, events: tr.events || [], logs, txhash: r.hash || hash };
  }

  /** 判断 LCD 的报错是否属于「节点侧故障」而不是「合约业务错误」 */
  const INFRA_ERR_RE = new RegExp([
    'invalid height', 'context did not contain', 'finalize block state',
    'connection refused', 'connection reset', 'no such host', 'timeout', 'timed out',
    'temporarily unavailable', 'service unavailable', 'bad gateway', 'gateway timeout',
    'internal server error', 'context canceled', 'EOF',
  ].join('|'), 'i');

  /** 节点侧故障 → 统一的「不是你的问题」提示（原文进 log，便于排查） */
  const nodeUnavailable = (detail) => {
    const e = new Error('链上节点暂时不可用，请稍后重试（与你的账户 / 余额无关）。');
    e.nodeDown = true;
    e.detail = detail || '';
    return e;
  };

  // ---------- 钱包 ----------
  const wallet = { address: '', pubkeyHex: '' };

  function detectWalletKind() {
    if (typeof window.paxihub !== 'undefined' && window.paxihub.paxi) return 'paxihub';
    return '';
  }

  const hasWallet = () => detectWalletKind() !== '';

  /**
   * PaxiHub 的桥接是**异步注入**的：脚本执行时 window.paxihub 可能还没挂上。
   * 直接同步判空会误判成"没钱包"，在 App 内也会把用户深链跳出去。
   */
  async function waitForWallet(timeoutMs = 6000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (detectWalletKind()) return true;
      await sleep(100);
    }
    return false;
  }

  async function connect() {
    if (!detectWalletKind()) await waitForWallet(2000);
    if (!detectWalletKind()) throw new Error('未检测到 PaxiHub 钱包。请在 PaxiHub App 内置浏览器打开本页面。');
    const info = await window.paxihub.paxi.getAddress();
    wallet.address = info.address;
    wallet.pubkeyHex = pkToHex(info.public_key);
    return wallet.address;
  }

  // ---------- 查询 ----------
  /**
   * 查询合约（默认查抽奖合约；传 contract 可查别的合约，如 TKCC）。
   *
   * LCD 失败时自动走 RPC 兜底（见文末「RPC 直查兜底」）。注意
   * **合约业务错误和 LCD 故障都会返回 HTTP 500**，光看状态码分不开，
   * 所以统一再问一次 RPC：RPC 成功 = LCD 的锅；RPC 也失败 = 业务错误。
   */
  async function queryContract(msg, contract) {
    const addr = contract || C.contract;
    if (!addr || addr.startsWith('PASTE_')) throw new Error('合约地址未配置（config.js）');
    const payload = JSON.stringify(msg);
    const url = `${C.lcd}/cosmwasm/wasm/v1/contract/${addr}/smart/${toBase64(payload)}`;
    let lcdErr = null;
    try {
      const res = await fetchWithTimeout(url);
      if (res.ok) {
        const json = await res.json();
        if (!json.code) return json.data;
        lcdErr = new Error(json.message || '查询返回错误');
        lcdErr.infra = INFRA_ERR_RE.test(String(json.message || ''));
      } else {
        let body = '';
        try { body = JSON.stringify(await res.json()); } catch (_) { body = ''; }
        lcdErr = new Error(`查询失败 HTTP ${res.status}${body ? '：' + body.slice(0, 200) : ''}`);
        // 只有 502/503/504 与「节点自述的故障」才算节点侧问题；
        // 普通 500 既可能是节点故障也可能是合约 revert，交给下面的 RPC 复核。
        lcdErr.infra = res.status === 502 || res.status === 503 || res.status === 504
          || res.status === 429 || INFRA_ERR_RE.test(body);
      }
    } catch (e) {
      lcdErr = e;
      lcdErr.infra = true;      // 网络层失败（超时 / DNS / 中断）
    }
    try {
      const data = await rpcSmartQuery(addr, payload);
      console.warn('[chain] LCD 查询失败，已用 RPC 兜底：', lcdErr.message);
      return data;
    } catch (e2) {
      // RPC 复核结果才是权威答案：它报的若是业务错误（合约 revert / 参数非法），
      // 原样抛给 mapContractError 去翻译；RPC 自己也挂了的话，退而用 LCD 的
      // 业务错误（若 LCD 给的是节点故障，才报"节点不可用"）。
      if (!e2.infra) throw e2;
      if (!lcdErr.infra) throw lcdErr;
      throw nodeUnavailable(lcdErr.message + ' / RPC: ' + (e2.message || e2));
    }
  }

  async function getBankBalances(address) {
    // 显式 10s 超时：余额查询在连接 / 轮询的关键路径上，连续弹窗时不能被
    // 单个慢 LCD 用默认 15s 拖死。
    try {
      const res = await fetchWithTimeout(`${C.lcd}/cosmos/bank/v1beta1/balances/${address}`, {}, 10000);
      const json = await res.json().catch(() => ({}));
      if (res.ok && Array.isArray(json.balances)) return json.balances;
    } catch (e) { /* 落到 RPC 兜底 */ }
    // ⚠️ 不能在这里静默 `return []`：LCD 抖动一次，"余额"就会显示成 0，
    // 用户会以为钱没了。查不到就抛，让调用方按"未知"处理。
    return await rpcBalances(address);
  }

  // ---------- paxihub 专属辅助 ----------
  /** §3.2 fetch accountNumber & sequence */
  async function buildCommon(chainId, address) {
    let accountNumber;
    let sequence;
    let notFound = false;
    let lcdErr = null;
    try {
      const res = await fetchWithTimeout(`${C.lcd}/cosmos/auth/v1beta1/accounts/${address}`);
      const json = await res.json().catch(() => ({}));
      const ba = json && json.account ? (json.account.base_account || json.account) : null;
      const raw = ba ? ba.account_number : undefined;
      if (raw !== undefined && raw !== null && raw !== '') {
        accountNumber = raw;
        sequence = ba.sequence;
      } else {
        // 只有 404 / "not found" 才是真的"这个账户还不存在"；
        // 其余（5xx、节点维护）是节点故障，绝不能甩锅给用户账户。
        notFound = res.status === 404 || /not found/i.test(String((json && json.message) || ''));
        lcdErr = notFound
          ? new Error('账户尚未在链上初始化（account_number 缺失）。请先接收一笔 PAXI 后重试。')
          : new Error(`账户查询失败 HTTP ${res.status}`);
      }
    } catch (e) {
      lcdErr = e;               // 网络层失败（超时 / DNS / 中断）
    }

    if (accountNumber === undefined) {
      try {
        const acc = await rpcAccount(address);
        accountNumber = acc.accountNumber;
        sequence = acc.sequence;
        console.warn('[chain] 账户查询走 RPC 兜底：', lcdErr && lcdErr.message);
      } catch (e2) {
        // RPC 说"没这个账户"= 链上确实没有，这才是真的没初始化（期间 LCD 可能
        // 只给了 500，分不出 404，所以以 RPC 的结论为准）。
        const m = String(e2.message || e2);
        if (notFound || /not ?found|key not found/i.test(m)) {
          throw new Error('账户尚未在链上初始化（account_number 缺失）。请先接收一笔 PAXI 后重试。');
        }
        // 地址本身非法之类：原样抛出，别包装成"节点故障"
        if (!e2.infra) throw new Error('账户查询失败：' + m);
        throw nodeUnavailable((lcdErr && lcdErr.message) + ' / RPC: ' + m);
      }
    }
    // ⚠️ Cosmos SDK 里 account_number 的合法值就是 0，旧实现用 String(...) !== '0'
    // 判断"未初始化"，会让 account_number=0 的真实账户（通常是新账户）直接报错。
    return {
      accountNumber: Number(accountNumber),
      sequence: Number(sequence || '0'),
    };
  }

  /** 从 tx_response 提取 wasm 事件的 key/value（数组形式，供前端按 key 查找事件属性）
   *
   * 兼容三种 LCD 形态：
   * 1) 顶层 txResponse.events（Cosmos SDK 0.47+ / 新版 LCD）——必须先查，
   *    否则 lottery_id / template_id 拿不到，模板池哈希链存不进 localStorage；
   * 2) txResponse.logs[].events（旧版）；
   * 3) 部分老版本把 attribute key 做 base64 —— wasm 事件 key 都是 [a-z_]，
   *    不匹配就尝试 atob 解码，解不动保底用原值。
   */
  function extractWasmAttrs(txResponse) {
    const out = [];
    const push = (evt) => {
      const t = evt && evt.type;
      if (!t || !(t === 'wasm' || t.startsWith('wasm-'))) return;
      for (const a of (evt.attributes || [])) {
        let k = a.key;
        try {
          if (k && !/^[a-z_]+$/.test(k)) k = atob(k);
        } catch (_) { /* 保底用原值 */ }
        out.push({ key: k, value: a.value });
      }
    };
    // 1) 顶层 events
    for (const evt of ((txResponse && txResponse.events) || [])) push(evt);
    // 2) logs[].events（旧版；部分 LCD 把 logs 返回成 JSON 字符串，先解析）
    let logs = (txResponse && txResponse.logs) || [];
    if (typeof logs === 'string') {
      try { logs = JSON.parse(logs); } catch (e) { logs = []; }
    }
    for (const log of logs) {
      for (const evt of (log.events || [])) push(evt);
    }
    return out;
  }

  // ---------- 交易 ----------
  /** hex → Uint8Array（会话公钥 / 会话签名用） */
  const bytesOf = (hex) => Uint8Array.from((hex || '').match(/.{1,2}/g).map((b) => parseInt(b, 16)));

  /** 构造 wasm ExecuteContract 的 Any 消息 */
  function buildExecAny(sender, contract, execMsg, funds) {
    return PaxiCosmJS.Any.fromPartial({
      typeUrl: '/cosmwasm.wasm.v1.MsgExecuteContract',
      value: PaxiCosmJS.MsgExecuteContract.encode({
        sender,
        contract,
        msg: new TextEncoder().encode(JSON.stringify(execMsg)),
        funds: funds || [],
      }).finish(),
    });
  }

  /** 构造 Bank MsgSend 的 Any 消息（给会话账户充 gas 用） */
  function buildMsgSendAny(from, to, amount, denom) {
    return PaxiCosmJS.Any.fromPartial({
      typeUrl: '/cosmos.bank.v1beta1.MsgSend',
      value: PaxiCosmJS.MsgSend.encode({
        fromAddress: from,
        toAddress: to,
        amount: [{ denom, amount }],
      }).finish(),
    });
  }

  /** 查某地址的链上 upaxi 余额（raw 字符串） */
  async function getBankUpaxi(address) {
    const bs = await getBankBalances(address);
    const c = bs.find((b) => b.denom === C.coinMinimalDenom);
    return c ? c.amount : '0';
  }

  function calcFee(gasOpt) {
    const gas = String(gasOpt || C.defaultGas);
    // gasPrice 是浮点（如 0.05 / 0.123）；放大到 1e9 再取整，
    // 避免小数精度被截断导致手续费算错
    const gpScaled = Math.round(C.gasPrice * 1e9);
    return {
      gas,
      fee: {
        amount: [{ denom: C.coinMinimalDenom, amount: String(Math.max(1, Math.ceil(Number(gas) * gpScaled / 1e9))) }],
        gasLimit: gas,
      },
    };
  }

  async function waitForTx(hash, timeoutMs = 60000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      let txr = null;
      try {
        const res = await fetchWithTimeout(`${C.lcd}/cosmos/tx/v1beta1/txs/${hash}`, {}, 10000);
        if (res.ok) {
          txr = (await res.json()).tx_response || {};
        }
      } catch (e) {
        /* 瞬时错误，继续轮询 */
      }
      if (!txr) {
        // LCD 不可用 → 用 RPC 按 hash 查（交易可能已经上链）
        try { txr = await rpcTxByHash(hash); } catch (e) { /* 还没上链，继续等 */ }
      }
      if (txr) {
        if (txr.code === 0) return { ok: true, raw: txr };
        if (txr.code) return { ok: false, raw: txr, log: txr.raw_log || txr.log };
      }
      await sleep(1500);
    }
    // 超时≠失败：交易可能已经上链。标记为 txPending，
    // 让上层知道**不要**回滚会话 nonce（否则本地比链上少 1，下一笔会被判重放）。
    const e = new Error(`交易确认超时（txhash=${hash}）。链上可能已成功，请稍后刷新列表确认。`);
    e.txPending = true;
    throw e;
  }

  /** 钱包签名路径：SignDoc → 钱包签名 → TxRaw → 广播 */
  async function executeViaPaxihub(execMsg, funds, opts) {
    if (typeof PaxiCosmJS === 'undefined') {
      throw new Error('PaxiCosmJS 库未加载，请检查网络');
    }

    const chainId = await getChainId();

    const { accountNumber, sequence } = await buildCommon(chainId, wallet.address);

    // TxBody：rawMsgs（多消息，如 注册会话+充gas）优先；否则单条 ExecuteContract
    const msgs = opts.rawMsgs || [
      buildExecAny(wallet.address, opts.contract || C.contract, execMsg, funds),
    ];
    const txBody = PaxiCosmJS.TxBody.fromPartial({
      messages: msgs,
      memo: opts.memo || '',
    });

    // Fee
    const { gas, fee } = calcFee(opts.gas);

    // PubKey Any
    const pubkeyBytes = new Uint8Array(wallet.pubkeyHex.match(/.{1,2}/g).map((b) => parseInt(b, 16)));
    const pubkeyAny = {
      typeUrl: '/cosmos.crypto.secp256k1.PubKey',
      value: PaxiCosmJS.PubKey.encode({ key: pubkeyBytes }).finish(),
    };

    // AuthInfo
    const authInfo = PaxiCosmJS.AuthInfo.fromPartial({
      signerInfos: [{
        publicKey: pubkeyAny,
        modeInfo: { single: { mode: 1 } },
        sequence: BigInt(sequence),
      }],
      fee,
    });

    // SignDoc
    const signDoc = PaxiCosmJS.SignDoc.fromPartial({
      bodyBytes: PaxiCosmJS.TxBody.encode(txBody).finish(),
      authInfoBytes: PaxiCosmJS.AuthInfo.encode(authInfo).finish(),
      chainId,
      accountNumber: BigInt(accountNumber),
    });

    const txObj = {
      bodyBytes: toBase64(signDoc.bodyBytes),
      authInfoBytes: toBase64(signDoc.authInfoBytes),
      chainId,
      accountNumber: String(signDoc.accountNumber),
    };
    const result = await window.paxihub.paxi.signAndSendTransaction(txObj);

    if (!result || !result.success) {
      throw new Error('paxihub 签名失败：' + JSON.stringify(result));
    }

    const sigBytes = Uint8Array.from(atob(result.success), (c) => c.charCodeAt(0));
    const txRaw = PaxiCosmJS.TxRaw.fromPartial({
      bodyBytes: signDoc.bodyBytes,
      authInfoBytes: signDoc.authInfoBytes,
      signatures: [sigBytes],
    });
    return await broadcastAndWait(toBase64(PaxiCosmJS.TxRaw.encode(txRaw).finish()));
  }

  /** 广播 base64 交易（SYNC）→ 准入校验 → waitForTx 等最终执行结果 → 提取 wasm 事件 */
  async function broadcastAndWait(base64Tx) {
    const broadcastRes = await fetchWithTimeout(`${C.lcd}/cosmos/tx/v1beta1/txs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tx_bytes: base64Tx, mode: 'BROADCAST_MODE_SYNC' }),
    });
    if (!broadcastRes.ok) {
      // 广播只能走 LCD（签名后 POST TxRaw），这里没有 RPC 兜底。
      // 至少把"节点故障"和"签名/格式错误"分开，别让用户以为是自己操作错了。
      if (broadcastRes.status >= 500) {
        throw nodeUnavailable('广播 HTTP ' + broadcastRes.status);
      }
      throw new Error('广播失败：HTTP ' + broadcastRes.status);
    }
    let broadcast;
    try { broadcast = await broadcastRes.json(); }
    catch { throw new Error('LCD 返回异常（HTTP ' + broadcastRes.status + '）'); }
    const txr = broadcast.tx_response || {};

    // BROADCAST_MODE_SYNC 返回的 code 是准入检查结果（序列号错误、签名错误会在这里报）
    if (txr.code !== undefined && txr.code !== 0) {
      throw new Error(txr.raw_log || '广播失败：code=' + txr.code);
    }

    // SYNC 只等 mempool 准入，不等合约执行 → 必须 waitForTx 二次确认，
    // 否则合约报错会被误判成成功
    const txhash = txr.txhash;
    if (!txhash) {
      throw new Error('广播未返回 txhash，无法确认链上执行结果，请稍后刷新列表核对。');
    }
    const confirmed = await waitForTx(txhash);
    if (!confirmed.ok) {
      throw new Error(confirmed.log || '交易执行失败');
    }
    const attrs = extractWasmAttrs(confirmed.raw);
    return { code: 0, transactionHash: txhash, raw: confirmed.raw, attributes: attrs };
  }

  // ---------- 真无感：会话私钥本地签名 + 直接广播（不弹钱包） ----------
  /**
   * 适用范围：create_lottery / join_lottery / activate_template 三个操作 ——
   * 合约里的资金身份全部来自 auth（主钱包），与 tx 签名者无关。
   * gas 由会话账户支付（enable 时随注册一笔 BankSend 预存）。
   *
   * 前提：会话账户已在链上初始化（账户号存在）。没初始化 → 抛
   * sessUnfunded，上层回退钱包签名路径（兼容本版之前开启的旧会话）。
   */
  /**
   * 会话私钥本地签名 + 广播（通用版：接收任意已编码的 Any 消息数组）
   *
   * 前提：会话账户已在链上初始化（账户号存在）。没初始化 → 抛
   * sessUnfunded，上层回退钱包签名路径（兼容本版之前开启的旧会话）。
   */
  async function broadcastViaSession(msgs, opts = {}) {
    if (typeof PaxiCosmJS === 'undefined') {
      throw new Error('PaxiCosmJS 库未加载，请检查网络');
    }
    const S = window.CJSession;
    if (!S || !S.state.enabled || !S.state.sessPriv) {
      throw new Error('无感会话未开启');
    }
    const chainId = await getChainId();

    let acc;
    try {
      acc = await buildCommon(chainId, S.state.sessAddr);
    } catch (e) {
      // 节点故障不是「会话没 gas」：不置 sessUnfunded，否则上层会白跑一遍
      // 钱包签名路径（同样会失败），还给出错误的方向性提示。
      const err = new Error('会话账户尚未初始化（无 gas）：' + (e.message || e));
      err.sessUnfunded = !e.nodeDown;
      err.nodeDown = !!e.nodeDown;
      throw err;
    }

    const txBody = PaxiCosmJS.TxBody.fromPartial({
      messages: msgs,
      memo: opts.memo || 'session tx',
    });
    const { gas, fee } = calcFee(opts.gas);
    const pubkeyAny = {
      typeUrl: '/cosmos.crypto.secp256k1.PubKey',
      value: PaxiCosmJS.PubKey.encode({ key: bytesOf(S.state.sessPubHex) }).finish(),
    };
    const authInfo = PaxiCosmJS.AuthInfo.fromPartial({
      signerInfos: [{
        publicKey: pubkeyAny,
        modeInfo: { single: { mode: 1 } },
        sequence: BigInt(acc.sequence),
      }],
      fee,
    });
    const signDoc = PaxiCosmJS.SignDoc.fromPartial({
      bodyBytes: PaxiCosmJS.TxBody.encode(txBody).finish(),
      authInfoBytes: PaxiCosmJS.AuthInfo.encode(authInfo).finish(),
      chainId,
      accountNumber: BigInt(acc.accountNumber),
    });

    // 会话私钥本地签名：Sign(SHA256(SignDoc 编码字节))，64 字节 compact
    const sigHex = await window.CJHash.signBytes(
      PaxiCosmJS.SignDoc.encode(signDoc).finish(),
      S.state.sessPriv,
    );
    const txRaw = PaxiCosmJS.TxRaw.fromPartial({
      bodyBytes: signDoc.bodyBytes,
      authInfoBytes: signDoc.authInfoBytes,
      signatures: [bytesOf(sigHex)],
    });
    return await broadcastAndWait(toBase64(PaxiCosmJS.TxRaw.encode(txRaw).finish()));
  }

  /** 会话签名执行合约（wasm 要求 msg.sender == tx 签名者 → sender 用会话地址） */
  async function executeViaSessionKey(execMsg, opts = {}) {
    const S = window.CJSession;
    if (!S || !S.state.enabled || !S.state.sessAddr) {
      throw new Error('无感会话未开启');
    }
    const msgs = [buildExecAny(S.state.sessAddr, opts.contract || C.contract, execMsg, [])];
    return broadcastViaSession(msgs, opts);
  }

  /**
   * 会话签名发原生消息（BankSend 等）。
   * 用途：关闭无感时把会话账户里没用完的 gas 扫回主钱包 —— 每次开启无感
   * 都是全新密钥对 / 新地址，不扫回这笔钱就永远沉睡在一次性地址上。
   */
  async function executeRawViaSession(rawMsgs, opts = {}) {
    return broadcastViaSession(rawMsgs, opts);
  }

  /** 多消息钱包交易（注册会话 + 充 gas 一笔完成）；rawMsgs 为已编码的 Any 数组 */
  function executeRaw(rawMsgs, opts = {}) {
    if (!Array.isArray(rawMsgs) || !rawMsgs.length) {
      return Promise.reject(new Error('executeRaw：rawMsgs 为空'));
    }
    return serializeTx(() => executeViaPaxihub(null, [], { ...opts, rawMsgs }));
  }

  // ---------- chainId ----------
  /**
   * 链上 chainId（**会话签名原文的第一段，必须与交易签名用同一个值**）。
   *
   * 之前 session.js 用 config.js 的硬编码值、chain.js 用链上动态值，两者目前
   * 恰好都是 `paxi-mainnet` 所以没暴露问题；一旦链改名或切链，交易能发出去、
   * 但会话验签会**全量失败**（签名原文第一段就对不上），而且错误定位极难。
   * 这里统一由 chain.js 取一次并缓存，两个用途共用同一个值。
   */
  let cachedChainId = '';
  let cachedChainIdAt = 0;
  const CHAIN_ID_TTL = 5 * 60 * 1000; // 5 分钟：链改名/切链最多 5 分钟内感知
  async function getChainId() {
    if (cachedChainId && Date.now() - cachedChainIdAt < CHAIN_ID_TTL) {
      return cachedChainId;
    }
    let onchain = '';
    try {
      const r = await fetchWithTimeout(`${C.lcd}/cosmos/base/tendermint/v1beta1/node_info`, {}, 5000);
      const j = await r.json();
      onchain = (j && j.default_node_info && j.default_node_info.network) || '';
    } catch (e) { /* 下面走 RPC 兜底 */ }
    if (!onchain) {
      // LCD 不可用 → 从 RPC /status 拿 network（签名原文第一段不能猜错）
      try {
        const r = await fetchWithTimeout(`${C.rpc}/status`, {}, 5000);
        const j = await r.json();
        onchain = (j && j.result && j.result.node_info && j.result.node_info.network) || '';
      } catch (e) { /* 查不到就用 config 兜底 */ }
    }
    if (onchain) {
      if (onchain !== C.chainId) {
        console.warn(`chainId 不一致：config=${C.chainId}，链上=${onchain}，改用链上值`);
      }
      cachedChainId = onchain;
      cachedChainIdAt = Date.now();
      return cachedChainId;
    }
    cachedChainId = C.chainId;
    cachedChainIdAt = Date.now();
    return cachedChainId;
  }

  /**
   * 发送执行交易。
   * @param {object} execMsg ExecuteMsg，如 { join_lottery: { id: 1, auth } }
   * @param {Array}  funds   原生币 [{ denom, amount }]
   * @param {object} opts    { gas, memo, contract, session:{action,roundId,amount} }
   */
  /**
   * 交易串行队列。
   *
   * 每笔交易都会各自去 LCD 取一次 sequence。如果用户连点两下，两笔交易会拿到
   * **同一个 sequence**，第二笔必然被节点以 "account sequence mismatch" 拒绝。
   * 这里用一个 promise 链把所有发交易的动作串起来，保证前一笔落地后再取下一个
   * sequence。前一笔失败不能阻塞后续，所以 then/catch 两边都放行。
   */
  let txQueue = Promise.resolve();
  function serializeTx(fn) {
    const run = txQueue.then(fn, fn);
    txQueue = run.then(
      () => {},
      () => {}
    );
    return run;
  }

  async function execute(execMsg, funds = [], opts = {}) {
    return serializeTx(async () => {
      if (!wallet.address) await connect();

      // P1-1：合约里 CreateLottery / JoinLottery / ActivateTemplate 的 `auth`
      // 是**必填**字段（非 Option），而只有开启会话才会由 signPayload 注入。
      // 未开启时消息会缺 auth，链上反序列化直接拒绝（missing field auth），
      // 报错对普通用户完全不可读。这里提前拦下，给出能照做的提示。
      const needAuth = !!opts.session;
      if (needAuth && !(window.CJSession && window.CJSession.state.enabled)) {
        const err = new Error(
          '该操作需要「无感会话」签名：请先点右上角「开启无感」（只需一次），成功后再重试。'
        );
        err.needSession = true;
        throw err;
      }

      if (needAuth) {
        // ---- 真无感路径 ----
        // 会话私钥本地签名 + 直接广播，不弹钱包、gas 由会话账户支付。
        // 合约侧资金身份来自 auth（主钱包），与 tx 签名者无关。
        const { payload } = await window.CJSession.signPayload(
          execMsg,
          opts.session.action,
          opts.session.roundId,
          opts.session.amount
        );
        try {
          return await executeViaSessionKey(payload, opts);
        } catch (e) {
          if (e && e.sessUnfunded) {
            // 兼容旧版开启的会话（会话账户没充过 gas）：
            // 回退钱包签名路径 —— 本地 nonce 未上链，回滚后重签新 nonce
            window.CJSession.rollbackNonce();
            console.warn('会话账户无 gas，本次回退钱包签名路径');
            const { payload: p2 } = await window.CJSession.signPayload(
              execMsg,
              opts.session.action,
              opts.session.roundId,
              opts.session.amount
            );
            try {
              return await executeViaPaxihub(p2, funds, opts);
            } catch (e2) {
              if (!e2.txPending) window.CJSession.rollbackNonce();
              throw e2;
            }
          }
          // 以链上为准恢复 nonce：合约回滚时 nonce 未消费、txPending 但实际
          // 成功时链上已 +1 —— 盲回滚在这两种场景下各错一次，链上同步永远对。
          await window.CJSession.syncNonce().catch(() => {});
          // nonce 漂移（如上次 txPending 实际成功）会让本笔预签的 nonce 无效
          // → 换新 nonce 自动重试一次，避免用户手动重开无感
          if (e && /nonce/i.test(String(e.message || e))) {
            const { payload: p2 } = await window.CJSession.signPayload(
              execMsg,
              opts.session.action,
              opts.session.roundId,
              opts.session.amount
            );
            try {
              return await executeViaSessionKey(p2, opts);
            } catch (e2) {
              await window.CJSession.syncNonce().catch(() => {});
              throw e2;
            }
          }
          throw e;
        }
      }

      // 非会话操作（充值 / 提现 / 领奖 / 退款 / 开奖 / 管理员）：钱包签名路径
      return await executeViaPaxihub(execMsg, funds, opts);
    });
  }

  window.CJChain = {
    C,
    wallet,
    hasWallet,
    waitForWallet,
    connect,
    getChainId,
    queryContract,
    getBankBalances,
    getBankUpaxi,
    buildExecAny,
    buildMsgSendAny,
    executeRaw,
    execute,
    executeViaSessionKey,
    executeRawViaSession,
    waitForTx,
    extractWasmAttrs,
    fmt,
    toRaw,
    toBase64,
    fetchWithTimeout,
    // 调试 / 自检用：LCD 挂掉时可以直接在控制台验证 RPC 兜底是否生效
    buildCommon,
    rpcAbciQuery,
  };
})();

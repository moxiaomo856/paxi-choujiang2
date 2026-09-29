/* =====================================================================
 * config.js —— 抽奖前端配置（本站点：TKCC）
 *
 * 【四站共用同一份代码】
 * 本仓库 tkcc/ orion/ pick/ leo/ 是同一套前端，只有本文件、manifest.json
 * 和 5 个图标文件（icon-128 / icon-192 / icon-512 / icon-maskable-512 /
 * apple-touch-icon）在各站之间不同。
 * 下次改代码：四个目录一起改；只有改「站点标识」段时才分别对待。
 * ===================================================================== */
window.CJ_CONFIG = {
  // ======== 站点标识（四站各不相同）========
  // appKey：Service Worker 缓存名前缀。
  //   GitHub Pages 的**所有项目站点共享同一个 origin**，Cache Storage 是
  //   跨目录共享的 —— 四站若用同一个缓存名，任一站升版本时 activate 里的
  //   清理逻辑会把另外三站的缓存一起删掉。所以必须各用各的。
  appKey: 'tkcc',
  // storageNs：localStorage 命名空间。同一个 origin 下 localStorage 也是
  //   共享的，四站的会话私钥 / 统计 / 提案记录键名完全相同，不加命名空间
  //   会互相覆盖（在 A 站开的无感会话被 B 站顶掉）。
  //   ⚠️ 本站必须留空字符串：这是已经在线上跑了一年多的站点，留空 = 老用户的
  //      会话键（cj_sess_priv__<地址>）保持不变，本次改版不会让他们掉线。
  //      另外三站必须填各自的 appKey。
  storageNs: '',
  appTitle: 'Paxi 抽奖 · TKCC',
  // tokenName：本应用的抽奖代币展示名。语言包里所有 "TKCC" 都是占位符，
  // 加载时会被整体替换成这个名字（见 i18n.js 的 localizeTokenName）。
  tokenName: 'TKCC',
  accent: '#ff6b35',       // 主色（覆盖 CSS 变量 --pri）
  accent2: '#ff8f5e',      // 主色浅阶（覆盖 CSS 变量 --pri2）
  // deployed：奖池合约是否已部署。false 时前端只显示提示，不发任何链上查询。
  deployed: true,
  notDeployedMsg: '',      // 留空使用语言包默认文案

  // ---- 链 ----
  chainId: 'paxi-mainnet',
  rpc: 'https://mainnet-rpc.paxinet.io',
  lcd: 'https://mainnet-lcd.paxinet.io',
  bech32Prefix: 'paxi',
  coinDenom: 'PAXI',
  coinMinimalDenom: 'upaxi',
  coinDecimals: 6,          // 1 PAXI = 10^6 upaxi
  gasPrice: 0.05,           // upaxi / gas
  defaultGas: 600000,

  // ---- 签名域名（必须与合约 state.rs 的 SIGN_DOMAIN 一致）----
  signDomain: 'lottery',

  // ==== 合约（本站专属）====
  // 奖池合约：必须是与本代币绑定的那一个实例（一个合约只认一个代币）。
  contract: 'paxi183js7jj7lceqpw6v2j9yagwet673gyeqvy9k5d58nwtjp0p9azpqsctvms',

  // 抽奖代币：外部 PRC-20 合约地址。字段名保留 tkcc* 前缀（历史原因，
  // 全站代码都读这两个名字），含义就是"本站的第二个代币"。
  tkccToken: 'paxi1s353hkvev2xtv5076wr5l2v6wy4tl9ph872g0puupakcx2p6rkls8q3vms',
  tkccDecimals: 6,

  // ---- 管理员 / 运营 ----
  admins: [
    'paxi1rdarmm997hqwfdgl9wvnpffe28zmex3kfyg7xd',
    'paxi1qvrmsftn402cumn0axqjc4dgvmkge6lhp0y39j',
  ],
  multisigThreshold: 1,
  treasury: 'paxi194kpjqhyz7re2g749lc2030cgeg4sql5ldvyem',

  // ---- 档位规格（必须与合约 tier_spec 一致）----
  // joinPaxi/joinTkcc 每人参与费；createPaxi/createTkcc 建池费（代币为"个数"）
  //
  // minVersion：该档位要求的最低合约版本（不写 = 所有版本都支持）。
  // 前端会读链上 contract_version 自动门控。线上合约是 0.1.0（只有 tier 0/1/2），
  // 若把 tier 3/4 也展示出来，用户选中后合约会直接以
  // "Invalid tier 3: must be 0 (5 people) / 1 (20 people) / 2 (50 people)" 拒绝。
  //
  // 【注意】线上合约的 CosmWasm contract admin 为空（不可变），**无法 migrate**。
  // 要启用 tier 3/4 必须：编译 0.2.0 → store → instantiate 新合约（带 --admin），
  // 然后把上面的 contract 改成新地址。合约版本变为 0.2.0 后这两档自动出现。
  tiers: [
    { id: 0, label: '5 人档',  people: 5,  joinPaxi: 1,  joinTkcc: 10000,  createPaxi: 1,  createTkcc: 20000 },
    { id: 1, label: '20 人档', people: 20, joinPaxi: 2,  joinTkcc: 20000,  createPaxi: 15, createTkcc: 100000 },
    { id: 2, label: '50 人档', people: 50, joinPaxi: 10, joinTkcc: 100000, createPaxi: 60, createTkcc: 600000 },
    // v2 新增档位（合约 tier 3/4，合约版本 >= 0.2.0 才可用）
    { id: 3, label: '5 人高档',  people: 5,  joinPaxi: 10, joinTkcc: 100000, createPaxi: 15, createTkcc: 120000, minVersion: '0.2.0' },
    { id: 4, label: '50 人纯 P 档', people: 50, joinPaxi: 10, joinTkcc: 0, createPaxi: 75, createTkcc: 0, minVersion: '0.2.0' },
  ],
  defaultTier: 0,

  // 官方模板池：彻底隐藏（合约仍支持，前端不展示）
  showTemplatePools: false,

  // ---- 无感会话 ----
  sessionDailyLimit: '1000000000000',
  // 开启无感时随注册一笔转入会话账户的 gas（upaxi），耗尽后自动回退钱包签名。
  // 2 PAXI ≈ 每笔 0.03 PAXI（60 万 gas × 0.05）可跑约 66 笔；
  // 关闭无感时剩余部分会自动扫回主钱包（见 session.js 的 sweepGasBack）。
  sessionGasFund: '2000000',
  keepSeamless: true,
  sessionTtlHours: 24,

  // 列表轮询（毫秒）；切到后台自动暂停
  pollInterval: 10000,

  // 管理员连接后，若合约尚未写入代币地址则自动发起启用（仍需钱包确认一次）
  autoEnableTkcc: true,
};

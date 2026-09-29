/* =====================================================================
 * config.js —— 抽奖前端配置（本站点：LEO）
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
  appKey: 'leo',
  // storageNs：localStorage 命名空间。同一个 origin 下 localStorage 也是
  //   共享的，四站的会话私钥 / 统计 / 提案记录键名完全相同，不加命名空间
  //   会互相覆盖（在 A 站开的无感会话被 B 站顶掉）。
  //   ⚠️ 只有 tkcc 站留空（为了不踢掉老用户的历史会话）；本站是新站，
  //      必须填自己的 appKey，否则会和 tkcc 站抢同一批键。
  storageNs: 'leo',
  appTitle: 'Paxi 抽奖 · LEO',
  // tokenName：本应用的抽奖代币展示名。语言包里所有 "TKCC" 都是占位符，
  // 加载时会被整体替换成这个名字（见 i18n.js 的 localizeTokenName）。
  tokenName: 'LEO',
  accent: '#f5a623',       // 主色（覆盖 CSS 变量 --pri）
  accent2: '#ffd166',      // 主色浅阶（覆盖 CSS 变量 --pri2）
  // deployed：奖池合约是否已部署。false 时前端只显示提示，不发任何链上查询。
  //   本站已于 2026-09-29 实例化上线（code_id 32，第 4 个实例）。
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
  // 本站奖池合约（code_id 32 的独立实例，只绑定 LEO；admin = paxi1rdarmm…g7xd）。
  contract: 'paxi147548gly44g0ty3uyssw6qxj3tn5hl3hmpsa99mtxhfcju0xwn5sk72u6f',

  // 抽奖代币：外部 PRC-20 合约地址。字段名保留 tkcc* 前缀（历史原因，
  // 全站代码都读这两个名字），含义就是"本站的第二个代币"。
  // Leo Wong（symbol: LEO，decimals: 6，Paxi Pump Token 标准 PRC-20）
  tkccToken: 'paxi1fl9glyfffr8kewueguj6jsnex3whxrhn44ucsv7djgec6prdp7jqenytw2',
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
  // 前端会读链上 contract_version 自动门控：0.1.0 只有 tier 0/1/2，
  // 若把 tier 3/4 也展示出来，用户选中后合约会直接以
  // "Invalid tier 3: must be 0 (5 people) / 1 (20 people) / 2 (50 people)" 拒绝。
  // 用 0.2.0 的新合约时这两档会自动出现，无需改代码。
  tiers: [
    { id: 0, label: '5 人档',  people: 5,  joinPaxi: 1,  joinTkcc: 10000,  createPaxi: 1,  createTkcc: 20000 },
    { id: 1, label: '20 人档', people: 20, joinPaxi: 2,  joinTkcc: 20000,  createPaxi: 15, createTkcc: 100000 },
    { id: 2, label: '50 人档', people: 50, joinPaxi: 10, joinTkcc: 100000, createPaxi: 60, createTkcc: 600000 },
    { id: 3, label: '5 人高档',  people: 5,  joinPaxi: 10, joinTkcc: 100000, createPaxi: 15, createTkcc: 120000, minVersion: '0.2.0' },
    { id: 4, label: '50 人纯 P 档', people: 50, joinPaxi: 10, joinTkcc: 0, createPaxi: 75, createTkcc: 0, minVersion: '0.2.0' },
  ],
  defaultTier: 0,

  // ==== 官方模板池 / 多签提案 的可见性（只控制前端展示，合约能力一直都在）====
  // showTemplatePools：
  //   'admin' —— 仅管理员地址可见（当前设置）：
  //              奖池列表里的官方池卡片 + 管理页的「官方模板池」面板都只对管理员开放
  //   true    —— 所有人可见（官方池会出现在奖池列表里）
  //   false   —— 彻底关闭：列表不显示，管理页那块面板也一并隐藏
  showTemplatePools: 'admin',
  // showMultisig：管理页的「🧾 多签提案」面板。
  //   false —— 隐藏（当前设置；合约仍支持 Propose/Confirm/Query，改成 true 即恢复入口）
  //   true  —— 显示
  showMultisig: false,

  // ---- 无感会话 ----
  sessionDailyLimit: '1000000000000',
  // 开启无感时随注册一笔转入会话账户的 gas（upaxi），耗尽后自动回退钱包签名。
  sessionGasFund: '2000000',
  keepSeamless: true,
  sessionTtlHours: 24,

  // 列表轮询（毫秒）；切到后台自动暂停
  pollInterval: 10000,

  // 管理员连接后，若合约尚未写入代币地址则自动发起启用（仍需钱包确认一次）
  autoEnableTkcc: true,
};

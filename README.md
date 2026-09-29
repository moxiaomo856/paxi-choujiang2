# Paxi 抽奖（多代币版）

一个仓库、一个域名，承载 **四种代币的抽奖大厅**。主站（`paxi-game-hub`）的抽奖入口
指向本仓库根路径，所以门户放在根目录，主站无需任何改动。

## 目录结构

```
paxi-choujiang/                ← 仓库根 = GitHub Pages 发布目录
├── index.html                 ← 门户：4 张卡片（手机上一行两个），选择代币进入
├── sw.js                      ← ⚠️ 一次性"自杀"脚本：清掉旧版根 SW 后自我注销
├── .nojekyll                  ← 必须保留！见下方说明
├── icon.svg                   ← 门户自己的图标
├── brand/                     ← 四张代币原图（图标源图，换图从这里改）
├── tools/make-icons.py        ← 由 brand/ 导出各站的 5 张图标
├── tools/instantiate-lotteries.sh ← 实例化 ORION/PICK/LEO 三个奖池合约
├── tkcc/                      ← TKCC 抽奖（当前线上业务，已上线）
├── orion/                     ← ORION 抽奖
├── pick/                      ← PICK 抽奖
└── leo/                       ← LEO 抽奖
```

**四个子目录是同一套代码**，逐文件校验过：`app.js`、`chain.js`、`i18n.js`、`index.html`、
`lottery.js`、`session.js`、`styles.css`、`sw.js`、`hash.js` 以及整个 `vendor/`
**全部字节相同**。**只有 `config.js`、`manifest.json` 和图标文件各站不同**：

| 文件 | 差异内容 |
|---|---|
| `config.js` | 站点标识（appKey / storageNs / appTitle / tokenName / accent）、奖池合约地址、代币合约地址、`deployed` |
| `manifest.json` | PWA 名称与短名 |
| `icon-128.png` | 门户卡片上的方图标（各站自己的代币图） |
| `icon-192.png` | 顶栏品牌标记 + favicon + SW 预缓存 |
| `icon-512.png` / `icon-maskable-512.png` | Android 桌面图标（maskable 四周留白，防圆形遮罩切到主体） |
| `apple-touch-icon.png` | iOS「添加到主屏幕」图标（180×180，iOS 不认 SVG 也不认 maskable） |

> 图标源图在 `brand/`，五张图都是同一张原图按不同尺寸/留白导出。
> 换图时把新图覆盖到 `brand/<站点>.jpg`，跑 `python tools/make-icons.py` 重新导出到四个目录，
> 再改 `index.html` / `manifest.json` 里的引用（一般不用改，路径是固定的）；
> `sw.js` 的 `CACHE` 版本号记得同步 `+1`（SHELL 清单变了就必须升，否则老用户
> 会一直命中旧缓存）。

改代码时**四个目录一起改**（`cp` 覆盖即可），只有改「站点标识」段时才分别对待。

## 为什么必须这样隔离（三个坑）

GitHub Pages 的**所有项目站点共享同一个 origin** —— `localStorage` 与
`Cache Storage` 都是跨目录共享的，不隔离会互相破坏：

1. **SW 缓存名**：四站若同名，任一站升版本时 `activate` 里的清理会把另外三站的缓存删掉。
   → `sw.js` 从自身路径推导应用名（`/paxi-choujiang/tkcc/sw.js` → `paxi-lottery-tkcc-v2`），
   并且只清理**自己前缀**的缓存。
2. **localStorage**：四站会话键名原本完全相同（`cj_sess_priv__<地址>`），
   在 A 站开的「无感会话」会被 B 站顶掉。
   → 由 `config.storageNs` 加命名空间。**tkcc 站刻意留空**，老用户的键名不变，
   本次改版不会让他们掉线；其余三站用各自前缀。
3. **旧根 SW 劫持**：旧版整个应用在根目录，注册了 scope 覆盖全站的 SW。
   改版后它仍留在用户浏览器里，离线时会把 `/tkcc/` 的导航请求塞回**旧的根 index.html**。
   → 根目录保留同名 `sw.js`（自杀脚本）：只删旧版缓存 `paxi-lottery-v<N>`、
   注销自己。门户页**故意不注册** SW（详见根 `sw.js` 注释）。

## .nojekyll 是必须的（不是可选）

`vendor/hashes/_md.js`、`_assert.js` 以 `_` 开头，**Jekyll 会把它们排除**。
线上实测这两个文件返回 **404**，本地加密栈（sha256 / ripemd160）因此加载失败，
只能靠 `index.html` 里的 jsDelivr CDN 兜底 —— CDN 在国内一旦不可达，签名就会整体失效。
`.nojekyll` 让 Pages 原样发布所有文件，根治此问题。

## 每个站需要两样东西

1. **奖池合约**（`paxi-lottery-contract-simple`，code_id 32）—— 一个合约只绑定
   一个代币，所以四站需要**四个独立实例**。用同一个 code_id 实例化即可，
   不需要重新编译（`instantiate_permission = Everybody`）。
2. **抽奖代币合约**（PRC-20，`Paxi Pump Token`，decimals 6）。

| 站点 | 抽奖代币 | symbol |
|---|---|---|
| tkcc | `paxi1s353hkvev2xtv5076wr5l2v6wy4tl9ph872g0puupakcx2p6rkls8q3vms` | TKCC |
| orion | `paxi1y0vna6d25hmgpsl63w2v2ks7j4tj7mwplr0pzfjmes5yqld59egsc7ahnz` | ORION |
| pick | `paxi1wh57kws25k7qz235x3u98r7tkgq2saxfl7z8nk7mnhhqtszwptsqye7fpx` | PICK |
| leo | `paxi1fl9glyfffr8kewueguj6jsnex3whxrhn44ucsv7djgec6prdp7jqenytw2` | LEO |

三个新站的奖池合约**已部署上线**（地址见下表 / 上节），`config.js` 里
`deployed: true` + 真实地址，四站均可正常创建 / 参与 / 开奖。
（`deployed: false` 时前端只显示提示、不发任何链上查询——新站复制时记得改。）

**三个新合约怎么开**：`tools/instantiate-lotteries.sh` 一条命令搞定
（= 三次 `paxid tx wasm instantiate 32`，参数与 TKCC 站逐字段相同，只有 `tkcc_token` 不同；
实例化后自动辨认新地址、统一设成 burn 模式、打印回填用的配置行）。
先 `DRY_RUN=1 bash tools/instantiate-lotteries.sh` 预览，再正式跑。
逐条命令版见仓库外的《ORION-PICK-LEO-实例化-WSL-20260929.md》。

> ⚠️ 实例化时**务必带 `--admin <地址>`**。旧 TKCC 合约当年用了 `--no-admin`，
> `admin` 为空 → 永久不可 `migrate`，这是它只能重开的唯一原因。

### 线上合约一览（2026-09-29 全部实例化完成）

四个站都是 `code_id 32` 的独立实例，一个合约只绑一个代币。三个新实例的
框架 `admin` 均为 `paxi1rdarmm997hqwfdgl9wvnpffe28zmex3kfyg7xd`（**可 upgrade**，
不再是旧合约那样的死锁状态），业务管理员为
`paxi1rdarmm997hqwfdgl9wvnpffe28zmex3kfyg7xd` + `paxi1qvrmsftn402cumn0axqjc4dgvmkge6lhp0y39j`
（阈值 1），与各站 `config.js` 的 `admins` / `multisigThreshold` 一致。

| 站点 | 奖池合约 | 抽奖代币 | burn_mode |
|---|---|---|---|
| tkcc | `paxi183js7jj7lceqpw6v2j9yagwet673gyeqvy9k5d58nwtjp0p9azpqsctvms` | `paxi1s353hkvev2xtv5076wr5l2v6wy4tl9ph872g0puupakcx2p6rkls8q3vms` | （上线时的口径） |
| orion | `paxi1s2a2xytfw0486efp7yskjw6xtghcq28lqsqcsygtcdwqsynrwthq3hne8f` | `paxi1y0vna6d25hmgpsl63w2v2ks7j4tj7mwplr0pzfjmes5yqld59egsc7ahnz` | burn |
| pick | `paxi10cggcpld3qgfuuv7t5gl3t6utk6f6udjzj3khm7m9dqurqdyln4q2y79u9` | `paxi1wh57kws25k7qz235x3u98r7tkgq2saxfl7z8nk7mnhhqtszwptsqye7fpx` | burn |
| leo | `paxi147548gly44g0ty3uyssw6qxj3tn5hl3hmpsa99mtxhfcju0xwn5sk72u6f` | `paxi1fl9glyfffr8kewueguj6jsnex3whxrhn44ucsv7djgec6prdp7jqenytw2` | burn |

已链上复核：四站 `deployed: true`、`contract` 与上表一致、`burn_mode=burn`、
`paused=false`、`contract_version=0.1.0`（故前端只展示 3 档，tier 3/4 由版本门控自动隐藏）。

---

# 🎰 choujiang-simple —— 抽奖前端（三档简化版）

纯静态站点，可直接推到 GitHub Pages。对应合约：`contracts/paxi-lottery-contract-simple`。
（完整自由参数版保留在 `choujiang/` + `contracts/paxi-lottery-contract/`，两者独立部署。）

## 三档规格（simple 版核心）

| 档位 | 人数 | 每人参与费 | 建池费（进奖池） |
|---|---|---|---|
| 5 人档（tier 0） | 5 | 1 PAXI + 1 万 TKCC | 1 PAXI + 2 万 TKCC |
| 20 人档（tier 1） | 20 | 2 PAXI + 2 万 TKCC | 15 PAXI + 10 万 TKCC |
| 50 人档（tier 2） | 50 | 10 PAXI + 10 万 TKCC | 60 PAXI + 60 万 TKCC |

* 分配比例三档一致：TKCC 38/28/14/14/6（一/二/建池者/运营/销毁），PAXI 40/30/15/15。
* simple 版**只看满员开奖**：超时未满员一律退款，不存在"过期能凑数开奖"。
* 金额/人数全部由合约内 `tier_spec()` 静态决定，管理员改不了任何费用。
* 建池者**不能参与自己建的池**（合约强制；他已拿 14%/15% 建池者分成）。

## 双模式说明

### 官方奖池（推荐）
管理员预设模板（只选档位），用户点击"参与"即可，金额由档位决定。
池子满员自动开奖，同时自动用同模板开下一个池子。
**第一个参与的人与后面的人待遇完全一致，没有任何特殊奖励。**

官方池随机性由**平台托管 secret + 哈希链**提供：管理员创建模板时前端自动生成
一条随机哈希链（存本机 localStorage，`cj_tpl_chain_<模板id>`），提交链头承诺；
每次开奖前管理员点"揭示下一个秘密"，合约验证 sha256 后把承诺推进到揭示值。
揭示值记录在链上 `template_secrets` 查表（池子创建时的承诺 → 该池用的 secret），
因此**满员之后再揭示同样对该池生效**，多个并行池各用链上不同位置的值，互不干扰。
开奖后 `seed` 与随机源写入链上事件，**任何人可复算验证**。
⚠️ 秘密链只存本机：换设备/清缓存会永久丢失，届时该模板的池子只能退款，务必备份。

### 玩家自建池
玩家选一档建池（付对应建池费），可附加 commit-reveal 秘密增强随机性；
不填则用区块熵 + 参与者加入时间兜底（页面上会标明随机源）。

## 外部依赖风险（务必知悉）

* **TKCC 是外部 PRC-20**（`TK Card Coin`，decimals 6，总量固定、minter 为空）。
  我们已解码其链上字节码确认：实现为 `cw20_base`，支持 `transfer / send /
  burn / increase_allowance`，因此默认销毁方式可用黑洞转账，`Burn` 亦可真销毁。
* ⚠️ **该 TKCC 合约带有非标准的 `freeze / unfreeze` 扩展**：有权者理论上可冻结
  抽奖合约地址，导致合约内 TKCC 无法转出（开奖 / 提现失败）。TKCC 由本项目方发行，
  该风险由项目方自担；若未来 TKCC 控制权移交，需重新评估。
* 合约默认销毁方式是 `BlackHole`（需先配置黑洞地址）；页面上销毁方式默认项已与
  合约对齐。未配置黑洞地址时开奖会报 `BurnAddressNotConfigured`，奖池不会卡死
  （配置后即可开奖）。

## 一、文件

```
index.html    页面结构
config.js     链参数 / 合约地址 / 三档规格（tiers）
hash.js       加密工具（secp256k1 / sha256 / ripemd160 / bech32，走 CDN 库）
chain.js      钱包连接 + 合约查询 / 交易
session.js    无感会话密钥（domain = "lottery"）
lottery.js    抽奖合约调用封装（含哈希链生成）
app.js        UI 逻辑
styles.css    样式
```

## 二、部署前必做

1. 打开 `config.js`，把 `contract` 改成部署后的抽奖合约地址：

```js
contract: 'paxi1...（paxi-lottery-contract-simple 地址）',
```

2. **TKCC 地址已内置**，无需改动：

```js
tkccToken: 'paxi1s353hkvev2xtv5076wr5l2v6wy4tl9ph872g0puupakcx2p6rkls8q3vms',
```

这是主网 TKCC（`TK Card Coin` / decimals 6 / `cw20-base`）。
运行时优先用合约 `{"tkcc":{}}` 的返回值；合约尚未 `SetTkccToken` 时用这一条兜底，
并**直接向 TKCC 合约查 `token_info`** 拿 symbol 与 decimals（所以余额、精度在管理员启用前就能正确显示）。

3. **管理员 / 运营金库已内置**（写入合约时用；前端据此判断管理员）：

```js
admins: [
  'paxi1rdarmm997hqwfdgl9wvnpffe28zmex3kfyg7xd',
  'paxi1qvrmsftn402cumn0axqjc4dgvmkge6lhp0y39j',
],
multisigThreshold: 1,
treasury: 'paxi194kpjqhyz7re2g749lc2030cgeg4sql5ldvyem', // 运营分成收款地址
```

> 前端判断管理员时**优先用链上 `{"admins":{}}`**；合约还没部署/查询失败时回落到这份白名单，
> 所以本地联调也能看到管理面板。

4. **管理员启用**（一次性，页面按钮即可）：

* 「管理员：运营配置」→ 点 **写入运营金库**，把 `treasury` 写进合约；
* 「管理员：TKCC 集成」→ 点 **启用 TKCC（写入合约）**，写入 TKCC 地址；
* 6% 销毁建议选 **`burn`**（该 TKCC 是标准 cw20-base，支持 `burn`，真减少总供应）；
  不想真销毁就选 `black_hole` 并填黑洞地址；
* 习惯用 CLI：`SOCIAL_ADDR=… LOTTERY_ADDR=… ./scripts/set-tkcc.sh`（含运营金库）。

5. 推到 GitHub，Settings → Pages → 选分支根目录（或 `/choujiang`），用 **HTTPS** 访问
   （钱包注入只在 https 生效）。

> **精度**：PAXI 与 TKCC 都是 **6**（1 个 = `10^6` raw）。10000 TKCC = `10000000000` raw。

## 三、页面功能

| 区块 | 能力 |
| --- | --- |
| 顶部 | 连接钱包（PaxiHub App 内置浏览器）、开启 / 关闭无感 |
| 余额 | 内部 PAXI / TKCC 余额、链上 PAXI；充值 / 提现 |
| **官方奖池** | 展示各活跃模板的报名进度，一键参与；满员自动开新池 |
| **管理员：运营配置** | 仅管理员可见；查看管理员白名单 / 多签阈值，写入运营金库 |
| **管理员：TKCC 集成** | 仅管理员可见；一键写入 TKCC 地址、设置销毁方式 / 黑洞地址 |
| **管理员：模板管理** | 仅管理员可见；创建 / 启停模板，查看模板列表 |
| 创建抽奖 | 玩家自建池：**只选档位**（5 / 20 / 50 人档），建池费、参与费、人数全部由合约 `tier_spec()` 静态决定；可选填"随机秘密"（commit-reveal） |
| 列表 | 按状态筛选；参与 / 开奖 / 领取 / 退款 / 揭示秘密；每条带"官方池 / 玩家建池"标签 |

## 四、无感签名

开启"无感"时会弹**一次**钱包注册会话，之后参与 / 建池由会话密钥本地签名：

```
{chainId}:{contractAddr}:lottery:{action}:{roundId}:{amount}:{nonce}:{pubkeyHex}
```

| 操作 | action | roundId | amount |
| --- | --- | --- | --- |
| 建池（A 模式） | `create_lottery` | `0` | 建池费 **PAXI + TKCC 的 raw 总和**（PAXI 同样计入日限额） |
| 参与玩家池（A 模式） | `join_lottery` | 抽奖 ID | 参与费 **PAXI + TKCC 的 raw 总和** |
| 激活模板（B2 模式） | `activate_template` | 模板 ID | 参与费 **PAXI + TKCC 的 raw 总和** |

> B2 模式的 `roundId` 用 **template_id**（不是 pool_id）：池子可能在本笔交易里才被创建，
> 前端签名时并不知道 pool id。金额一律以链上池子为准，前端传的 amount 只用于签名匹配。

会话 24 小时过期；交易失败会自动回滚本地 nonce，并从链上重新同步。

### 真无感：会话私钥签名 + 直接广播（不弹钱包）

「开启无感」的一笔交易里同时完成 **RegisterSession + 给会话地址转入 gas**
（`sessionGasFund`，默认 0.3 PAXI）。之后：

* **参与 / 建池 / 官方池参与** —— 由会话私钥本地构造 SignDoc 签名并直接广播，
  **不弹钱包**，gas 从会话账户扣（约 3 万 upaxi/次，够 10 次左右）。
  合约侧资金身份来自 auth（主钱包内部余额），与 tx 签名者无关。
* **充值 / 提现 / 领奖 / 退款 / 管理操作** —— 仍走钱包签名（涉及主钱包身份或链上转账）。
* 会话 gas 耗尽 → 参与自动回退钱包签名路径（弹一次钱包），重新「开启无感」即可再充。
* 会话账户的 gas 余额可随时在区块浏览器查（开启无感时日志会打印该地址）；
  「关闭无感」只撤销授权，旧会话账户里未用完的少量 gas 不退（金额很小）。

### 会话私钥存储与安全边界

会话私钥存 `localStorage`，键名格式为 `cj_sess_priv__<主钱包地址>`
（抽奖前缀 `cj_`，社交前缀 `pt_`）。**明文存储，未加密。**

这是**有意**的选择：

- 手机端 `sessionStorage` 在切后台 / 锁屏 / 内存紧张时会被系统清空，
  导致"开一次无感只能用几分钟"，体验不可用；
- `sessionStorage` 与 `localStorage` 在 XSS / 同域脚本 / 浏览器扩展这三种
  主要攻击面前是**等价**的（都能被读），加密只能防"设备文件被物理窃取"这一种场景，
  而那种场景下攻击者可直接打开钱包 App 转走资产，无需偷会话私钥；
- 因此不做 AES-GCM 加密（复杂度高、保护面窄）。

**缓解措施**：

- 会话私钥 **≠** 主钱包私钥，泄漏只影响 `daily_limit`（默认 1e12 raw）额度内资金；
- 可随时在链上 `RevokeSession`（前端"关闭无感"按钮会触发）；
- 主钱包私钥从不落地。

**若你的威胁模型包含"设备被物理接触且浏览器未锁定"**：请勿开启无感，
或联系运营将 `daily_limit` 设为更小值。

## 五、TKCC 未配置时

* 页面顶部黄条提示"TKCC 尚未配置"
* 创建 / 参与抽奖会失败并返回 `TkccNotConfigured`
* 管理员在「管理员：TKCC 集成」点一次 **启用 TKCC**（或两个合约各调一次 `SetTkccToken`），刷新即可恢复正常

## 六、费用速查

| 项 | A 玩家建池 | B2 模板池 |
| --- | --- | --- |
| 建池费 | 按档位：**1 / 15 / 60 PAXI** + 2万 / 10万 / 60万 TKCC（全额进奖池） | 0 |
| 参与费 | 按档位：**1 / 2 / 10 PAXI** + 1万 / 2万 / 10万 TKCC | 同左（由模板所选档位决定） |
| 人数 | 按档位：**5 / 20 / 50**（满员即开） | 同左 |
| 触发者奖励 | — | **无**（与普通参与者完全一致） |
| 一等奖 | 1 人，TKCC 38% / PAXI 40% | 同左 |
| 二等奖 | 2 人，TKCC 共 28% / PAXI 共 30% | 同左 |
| 建池者 | TKCC 14% / PAXI 15% | 0 |
| 运营 | TKCC 14% / PAXI 15% | **28% / 30%**（含建池者那份） |
| 销毁 | TKCC 6% | TKCC 6% |

## 七、依赖

**本地 vendor 优先，CDN 兜底**（index.html 加载器自动按序尝试）：

| 库 | 本地文件（vendor/） | CDN 兜底 |
| --- | --- | --- |
| long（PaxiCosmJS 的 UMD 前置依赖） | `long.umd.js` | jsdelivr |
| PaxiCosmJS（交易构建，§3.1） | `paxi-cosmjs.umd.js` | mainnet-api.paxinet.io |
| @noble/secp256k1@2.1.0 | `secp256k1.mjs` | jsdelivr / esm.sh |
| @noble/hashes@1.4.0（sha256 / ripemd160） | `hashes/*.js`（**ESM 版**，已修补裸包导入） | jsdelivr `/esm/` 路径 / esm.sh |
| bech32@2.0.0 | `bech32.mjs`（本地 CJS→ESM 包装） | esm.sh |

⚠️ **为什么必须本地 vendor**（历史教训，勿删）：

1. jsdelivr 的 `/npm/@noble/hashes@x/sha256.js` 与 bech32 的 `dist/index.min.js` 都是 **CJS**，浏览器 `import()` 直接报错 —— noble-hashes 的 ESM 在 `/esm/` 子目录，bech32@2.0.0 根本没有 ESM 构建（本地文件是手工包装的）；
2. noble-hashes ESM 里有裸包导入 `@noble/hashes/crypto`，浏览器解析不了，index.html 的 **importmap** 负责指到本地文件；
3. `paxi-cosmjs.umd.js` 是 UMD 且依赖全局 `Long`，加载顺序必须 long 在前。

部署时 **vendor/ 目录必须随站点一起上传**。node 下已对 sha256 / ripemd160 / bech32 地址编码 / secp256k1 签名 / 哈希链轮转做了全量用例验证。

钱包：**仅支持** `window.paxihub`（PaxiHub App 内置浏览器）。
      PaxiHub 的 signAndSendTransaction 只签名，客户端自行组装 TxRaw
      并 POST 到 LCD（BROADCAST_MODE_SYNC）广播，然后 waitForTx 轮询最终结果。

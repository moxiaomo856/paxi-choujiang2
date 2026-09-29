#!/usr/bin/env bash
# =====================================================================
#  instantiate-lotteries.sh
#  为 ORION / PICK / LEO 各实例化一个抽奖合约。
#
#  【为什么不用编译、不用 store】
#  链上 code_id = 32 就是 TKCC 站正在用的那份 wasm（paxi-lottery-contract-simple，
#  contract_version 0.1.0），实测它的 instantiate_permission = Everybody ——
#  任何人都可以拿这个 code 再实例化新合约。所以三个新站**直接 instantiate** 即可，
#  ORION/PICK/LEO 与 TKCC 的合约逻辑完全一致，只有绑定的代币合约地址不同。
#
#  【参数完全照搬 TKCC 站那一个实例】
#  admins / treasury / multisig_threshold / lottery_config 四项与 TKCC 逐字段相同，
#  唯一变化的就是 tkcc_token（本站的抽奖代币）。
#
#  用法（在装了 paxid 的机器 / WSL 里）：
#      bash tools/instantiate-lotteries.sh
#  只想先看命令不执行：
#      DRY_RUN=1 bash tools/instantiate-lotteries.sh
# =====================================================================
set -euo pipefail

# ---------- ↓↓↓ 只需要改这一段 ↓↓↓ -----------------------------------
KEY="mykey"                    # paxid keys list 里的 NAME
ADMIN_ADDR="paxi1REPLACE_ME"   # 合约框架管理员：以后签 migrate 用，填你自己的钱包地址
KEYRING="os"                   # 当年建 key 用的 backend：os / file / test
# ---------- ↑↑↑ 只需要改这一段 ↑↑↑ -----------------------------------

DRY_RUN="${DRY_RUN:-0}"

# ===== 以下与 TKCC 站一致，通常不要动 =====
CODE_ID=32
CHAIN_ID="paxi-mainnet"
LCD="https://mainnet-lcd.paxinet.io"
NODE_ARG=""                                       # 需要时写 --node tcp://xxx:26657
GAS_ARG="--gas auto --gas-adjustment 1.4 --gas-prices 0.05upaxi"
# 若报 insufficient fee / out of gas，把上面一行换成当年部署 TKCC 时的同一档：
#   GAS_ARG="--gas auto --fees 6000000upaxi"

TREASURY="paxi194kpjqhyz7re2g749lc2030cgeg4sql5ldvyem"
ADMIN1="paxi1rdarmm997hqwfdgl9wvnpffe28zmex3kfyg7xd"
ADMIN2="paxi1qvrmsftn402cumn0axqjc4dgvmkge6lhp0y39j"
OLD_TKCC_LOTTERY="paxi183js7jj7lceqpw6v2j9yagwet673gyeqvy9k5d58nwtjp0p9azpqsctvms"

# 站点 → 代币合约（已链上核实，decimals=6 的标准 PRC-20）
declare -A TOKEN=(
  [orion]="paxi1y0vna6d25hmgpsl63w2v2ks7j4tj7mwplr0pzfjmes5yqld59egsc7ahnz"
  [pick]="paxi1wh57kws25k7qz235x3u98r7tkgq2saxfl7z8nk7mnhhqtszwptsqye7fpx"
  [leo]="paxi1fl9glyfffr8kewueguj6jsnex3whxrhn44ucsv7djgec6prdp7jqenytw2"
)
LABELS=(orion pick leo)

msg() {  # $1 = 本站代币合约地址
  cat <<JSON
{
  "admins": ["$ADMIN1", "$ADMIN2"],
  "treasury": "$TREASURY",
  "tkcc_token": "$1",
  "tkcc_burn_address": null,
  "lottery_config": {
    "first_prize_count": 1,
    "second_prize_count": 2,
    "duration_secs": 86400,
    "refund_creator_on_timeout": true
  },
  "multisig_threshold": 1
}
JSON
}

# 预览模式：不查链、不发交易，只把三条命令打印出来（便于先核对参数）
if [ "$DRY_RUN" = "1" ]; then
  echo "==== DRY_RUN：以下是要执行的命令，未发送任何交易 ===="
  echo
  echo "# 0) 确认 code 32 允许任何人实例化"
  echo "curl -s \"$LCD/cosmwasm/wasm/v1/code/$CODE_ID\" | head -c 400"
  echo
  for s in "${LABELS[@]}"; do
    echo "# --- $s ---"
    echo "paxid tx wasm instantiate $CODE_ID '$(msg "${TOKEN[$s]}")' \\"
    echo "  --from \"$KEY\" --label \"paxi-lottery-$s-v1\" --admin \"$ADMIN_ADDR\" \\"
    echo "  --keyring-backend \"$KEYRING\" --chain-id \"$CHAIN_ID\" $NODE_ARG $GAS_ARG -y"
    echo
  done
  echo "# 1) 取回三个新地址"
  echo "curl -s \"$LCD/cosmwasm/wasm/v1/code/$CODE_ID/contracts?pagination.limit=100\""
  echo
  echo "# 2) 每个新合约把销毁方式设成 burn（与 TKCC 一致）"
  echo "paxid tx wasm execute <新合约地址> '{\"admin\":{\"set_tkcc_burn_mode\":{\"mode\":\"burn\"}}}' \\"
  echo "  --from \"$KEY\" --keyring-backend \"$KEYRING\" --chain-id \"$CHAIN_ID\" \\"
  echo "  $NODE_ARG --gas auto --gas-adjustment 1.4 --gas-prices 0.05upaxi -y"
  exit 0
fi

for c in paxid curl python3; do
  command -v "$c" >/dev/null 2>&1 || { echo "缺少 $c，请先装好再跑"; exit 1; }
done

if [ "$ADMIN_ADDR" = "paxi1REPLACE_ME" ]; then
  echo "请先把脚本顶部的 ADMIN_ADDR 改成你自己的 paxi 地址"; exit 1
fi

# ---------------------------------------------------------------- 0. 前置自检
echo "==== 0. 自检 ===="
echo "code $CODE_ID 的 instantiate_permission / 现有实例:"
curl -sf "$LCD/cosmwasm/wasm/v1/code/$CODE_ID" \
  | python3 -c 'import json,sys; d=json.load(sys.stdin)["code_info"]; print("  permission:", d.get("instantiate_permission") or "Everybody（未限制）")' \
  || echo "  （LCD 查询失败，可忽略，继续）"

before=""
before=$(curl -sf "$LCD/cosmwasm/wasm/v1/code/$CODE_ID/contracts?pagination.limit=100" \
  | python3 -c 'import json,sys; print("\n".join(json.load(sys.stdin).get("contracts") or []))') || before=""
echo "  现有实例数: $(printf '%s\n' "$before" | grep -c . || true)"

# ---------------------------------------------------------------- 1. 实例化
echo
echo "==== 1. 实例化三个抽奖合约 ===="
for s in "${LABELS[@]}"; do
  echo "--> $s"
  if [ "$DRY_RUN" = "1" ]; then
    echo "paxid tx wasm instantiate $CODE_ID '<JSON>' --from \"$KEY\" \\"
    echo "  --label \"paxi-lottery-$s-v1\" --admin \"$ADMIN_ADDR\" \\"
    echo "  --keyring-backend \"$KEYRING\" --chain-id \"$CHAIN_ID\" $NODE_ARG $GAS_ARG -y"
  else
    paxid tx wasm instantiate "$CODE_ID" "$(msg "${TOKEN[$s]}")" \
      --from "$KEY" \
      --label "paxi-lottery-$s-v1" \
      --admin "$ADMIN_ADDR" \
      --keyring-backend "$KEYRING" \
      --chain-id "$CHAIN_ID" \
      $NODE_ARG $GAS_ARG \
      -y
  fi
  sleep 2
done

if [ "$DRY_RUN" = "1" ]; then
  echo
  echo "(DRY_RUN，未发送任何交易)"
  exit 0
fi

# ---------------------------------------------------------------- 2. 取回新地址
echo
echo "==== 2. 取回新建的 3 个合约地址 ===="
echo "等 6 秒让交易上链…"
sleep 6

after=""
after=$(curl -sf "$LCD/cosmwasm/wasm/v1/code/$CODE_ID/contracts?pagination.limit=100" \
  | python3 -c 'import json,sys; print("\n".join(json.load(sys.stdin).get("contracts") or []))') || after=""

newaddrs=""
newaddrs=$(comm -13 <(printf '%s\n' "$before" | sort) <(printf '%s\n' "$after" | sort) 2>/dev/null) || newaddrs=""
if [ -z "$(printf '%s' "$newaddrs" | tr -d '[:space:]')" ]; then
  echo "没检测到新实例。用下面这条自己看："
  echo "  paxid query wasm list-contract-by-code $CODE_ID --output json"
  exit 1
fi

declare -A NEW
for a in $newaddrs; do
  lbl=$(curl -sf "$LCD/cosmwasm/wasm/v1/contract/$a" \
    | python3 -c 'import json,sys; print(json.load(sys.stdin)["contract_info"].get("label",""))')
  site="${lbl#paxi-lottery-}"; site="${site%-v1}"
  NEW[$site]="$a"
  echo "  $site  ->  $a   (label=$lbl)"
done

# ---------------------------------------------------------------- 3. 销毁方式改 burn
# instantiate 时 tkcc_burn_address 传 null，合约会把销毁方式默认成 Skip（销毁份额进金库）。
# TKCC 站用的是 burn，这里补一条管理员动作对齐（threshold=1，直接执行，不用走提案）。
echo
echo "==== 3. 把三个新合约的销毁方式设成 burn（与 TKCC 一致）===="
for s in "${LABELS[@]}"; do
  a="${NEW[$s]:-}"
  if [ -z "$a" ]; then echo "  $s: 没识别到地址，跳过"; continue; fi
  echo "--> $s  $a"
  paxid tx wasm execute "$a" '{"admin":{"set_tkcc_burn_mode":{"mode":"burn"}}}' \
    --from "$KEY" \
    --keyring-backend "$KEYRING" \
    --chain-id "$CHAIN_ID" \
    $NODE_ARG --gas auto --gas-adjustment 1.4 --gas-prices 0.05upaxi \
    -y
  sleep 2
done

echo
echo "==== 完成。请把下面三行填回各站 config.js，并把 deployed 改成 true ===="
for s in "${LABELS[@]}"; do
  a="${NEW[$s]:-TODO}"
  echo "  $s/config.js :  contract: '$a',   deployed: true,"
done
echo
echo "核对（应显示 configured=true / burn_mode=burn）："
for s in "${LABELS[@]}"; do
  a="${NEW[$s]:-}"
  if [ -z "$a" ]; then continue; fi
  echo "  paxid query wasm contract-state smart $a '{\"tkcc\":{}}' --output json    # $s"
done

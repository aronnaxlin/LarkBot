#!/usr/bin/env bash
# Put the LarkBot sandbox behind a one-way firewall.
#
# The sandbox container may reach the public internet (package installs, git,
# curl, DNS through the resolvers configured in docker-compose.yml) but must
# not reach the host's LAN, its own bridge neighbours, the host itself,
# Tailscale (100.64/10), link-local (including cloud metadata at
# 169.254.169.254), or loopback. Docker's FORWARD rules bypass the usual
# INPUT/FORWARD layout, so the egress rules live in DOCKER-USER; traffic
# addressed *to the host* is filtered in INPUT.
#
# Usage:
#   sudo ./deploy/firewall.sh            # add/refresh the rules (idempotent)
#   sudo ./deploy/firewall.sh --check    # exit non-zero if any rule is missing
#   sudo ./deploy/firewall.sh --remove   # delete this script's rules
#   SUBNET=10.99.0.0/24 DNS_RESOLVERS="10.0.0.53" sudo -E ./deploy/firewall.sh
#
# Settings come from /etc/default/larkbot-firewall when that file exists, and
# from the environment otherwise: SUBNET, DNS_RESOLVERS, ALLOW_PROXY,
# BYPASS_TUN, BYPASS_TUN_PREF, NO_TUN. An already-set environment variable
# wins over the file, so manual `--check`/`--remove` runs see exactly what the
# systemd unit saw. See deploy/larkbot-firewall.env.example.
#
# Every rule this script owns carries `-m comment --comment larkbot-sandbox`.
# Applying and removing rewrites that whole set, so changing SUBNET,
# DNS_RESOLVERS, ALLOW_PROXY or BYPASS_TUN never leaves stale ACCEPTs behind.
#
# DNS_RESOLVERS must match the `dns:` list in deploy/docker-compose.yml. The
# sandbox's own DNS goes through those addresses; Docker's embedded resolver
# (127.0.0.11) is inside the container's network namespace and is not routed.
#
# ALLOW_PROXY=<ipv4>:<port> punches exactly one hole for a filtering proxy the
# sandbox may talk to. It requires BYPASS_TUN=1 (so direct traffic stays under
# this firewall) or NO_TUN=1 (an explicit acknowledgement that the host has no
# transparent proxy). The proxy environment the Bash tool sets
# (SANDBOX_HTTP_PROXY) is a policy hint, not a confinement: a command can
# ignore it, which is exactly why the firewall must be authoritative.
#
# Transparent proxy / TUN on the host: with BYPASS_TUN=1 the script also adds
#   ip rule add from $SUBNET lookup main pref $BYPASS_TUN_PREF
# so sandbox traffic skips a fake-IP TUN (mihomo/clash/sing-box) and the
# iptables rules above see real destination addresses. Without it, a fake-IP
# TUN resolves and dials on the host's behalf, which can expose host-loopback
# services and the LAN under names like 127.0.0.1.nip.io. docs/deploy.md has
# the full explanation and the three supported layouts.
#
# Fail-closed details: the DOCKER-USER chain is created when missing (Docker
# reuses an existing chain), and the script refuses to run when Docker is
# configured with the nftables firewall backend (daemon.json) or when
# dockerd's unit starts with --firewall-backend=nftables, because neither
# traverses DOCKER-USER.
#
# Persistence: install deploy/larkbot-firewall.service (see docs/deploy.md).
# The unit runs Before=docker.service, so the rules exist before any container
# starts; deploy/larkbot-firewall-check.timer re-runs --check every 5 minutes
# and shows up in the journal.
#
# IPv6: this covers IPv4 only. Compose does not enable IPv6 for sandbox-net,
# so the sandbox has no IPv6 connectivity to reach anything with.
#
# Verify from inside the sandbox (docs/deploy.md has the full list). On a
# correctly configured host every one of these must fail:
#   docker compose exec -T sandbox curl -sS -m 5 http://192.168.1.1/         ; echo "exit=$?"   # LAN
#   docker compose exec -T sandbox curl -sS -m 5 http://192-168-1-1.nip.io/  ; echo "exit=$?"   # LAN via a fake-IP TUN
#   docker compose exec -T sandbox curl -sS -m 5 http://127.0.0.1.nip.io:3425/ ; echo "exit=$?"  # host loopback
#   docker compose exec -T sandbox curl -sS -m 5 http://172.31.250.1/        ; echo "exit=$?"   # host gateway
#   docker compose exec -T sandbox curl -sS -m 5 http://100.64.0.1/          ; echo "exit=$?"   # Tailscale
#   docker compose exec -T sandbox curl -sS -m 5 http://169.254.169.254/     ; echo "exit=$?"   # metadata
# and this one must succeed:
#   docker compose exec -T sandbox curl -fsS -m 10 https://example.com >/dev/null && echo egress-ok

set -euo pipefail
# No globbing: settings are word-split (DNS_RESOLVERS), and a stray `*` must
# fail validation instead of expanding to file names.
set -f

# Every rule of ours carries `larkbot-sandbox:<generation>`, where the
# generation hashes the settings (see below). Apply inserts the current
# generation first and only then deletes older ones, so there is never a
# moment without the drops, and no stale rule survives a settings change.
# One sandbox per host: cleanup removes every `larkbot-sandbox:` rule,
# whatever subnet it was generated for.
TAG=larkbot-sandbox

# Settings keys accepted from the env file; keep in sync with the example.
SETTING_KEYS="SUBNET DNS_RESOLVERS ALLOW_PROXY BYPASS_TUN BYPASS_TUN_PREF NO_TUN"

die() { echo "firewall: $*" >&2; exit 2; }

# Minimal, eval-free dotenv reader: KEY=value lines, optional quotes, comments.
# A variable that is already set in the environment wins over the file.
load_env_file() {
  local file=$1 line key value
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in ''|'#'*) continue ;; esac
    key=${line%%=*}
    [ "$key" = "$line" ] && continue
    value=${line#*=}
    key=${key#export }
    key=${key%%[[:space:]]*}
    value=${value#"${value%%[![:space:]]*}"}
    value=${value%"${value##*[![:space:]]}"}
    case "$value" in
      \"*\") value=${value#\"}; value=${value%\"} ;;
      \'*\') value=${value#\'}; value=${value%\'} ;;
    esac
    case " $SETTING_KEYS " in
      *" $key "*)
        # An explicit environment variable wins over the file.
        if ! declare -p "$key" >/dev/null 2>&1; then printf -v "$key" '%s' "$value"; fi
        ;;
      *) echo "firewall: warning: ignoring unknown setting '$key' in $file" >&2 ;;
    esac
  done < "$file"
}

ENV_FILE=${FIREWALL_ENV_FILE:-/etc/default/larkbot-firewall}
if [ -f "$ENV_FILE" ]; then load_env_file "$ENV_FILE"; fi

SUBNET=${SUBNET:-172.31.250.0/24}
DNS_RESOLVERS=${DNS_RESOLVERS:-"1.1.1.1 8.8.8.8"}
ALLOW_PROXY=${ALLOW_PROXY:-}
BYPASS_TUN=${BYPASS_TUN:-0}
BYPASS_TUN_PREF=${BYPASS_TUN_PREF:-8999}
NO_TUN=${NO_TUN:-0}
IPTABLES=${IPTABLES:-iptables}
IP=${IP:-ip}
DAEMON_JSON=${DAEMON_JSON:-/etc/docker/daemon.json}
SYSTEMCTL=${SYSTEMCTL:-systemctl}
DOCKER=${DOCKER:-docker}

[ "$(id -u)" -eq 0 ] || die "must run as root"
command -v "$IPTABLES" >/dev/null 2>&1 || die "$IPTABLES not found"

# `1`, `true`, `yes`, `on` (any case) mean on; `0`, `false`, `no`, `off` mean off.
# Anything else is a configuration error, not a silent default — for BYPASS_TUN a
# typo would otherwise turn the bypass off.
as_bool() {
  case "$1" in
    1|true|TRUE|yes|YES|on|ON) echo 1 ;;
    0|false|FALSE|no|NO|off|OFF|'') echo 0 ;;
    *) die "$2 must be 1 or 0 (or true/false), got '$1'" ;;
  esac
}
BYPASS_TUN=$(as_bool "$BYPASS_TUN" BYPASS_TUN)
NO_TUN=$(as_bool "$NO_TUN" NO_TUN)

if [ "$BYPASS_TUN" = 1 ]; then
  command -v "$IP" >/dev/null 2>&1 || die "$IP not found (BYPASS_TUN=1 needs the ip command)"
fi

mode=apply
case "${1:-}" in
  --check) mode=check ;;
  --remove) mode=remove ;;
  "") ;;
  *) die "unknown argument '${1}' (use --check or --remove)" ;;
esac

[[ "$BYPASS_TUN_PREF" =~ ^[1-9][0-9]{0,4}$ ]] && [ "$BYPASS_TUN_PREF" -le 32765 ] \
  || die "BYPASS_TUN_PREF must be an ip-rule preference 1-32765, got '$BYPASS_TUN_PREF'"

# --- address helpers ---------------------------------------------------------

# Strict dotted quad: rejects leading zeros ("010.1.1.1" is octal to some
# tools) and out-of-range octets.
is_ipv4() {
  [[ "$1" =~ ^((25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9]?[0-9])\.){3}(25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9]?[0-9])$ ]]
}

ipv4_to_int() {
  local a b c d
  IFS=. read -r a b c d <<< "$1"
  printf '%s' "$(( (a << 24) + (b << 16) + (c << 8) + d ))"
}

ipv4_in_subnet() {
  local ip=$1 cidr=$2 base=${2%/*} prefix=${2#*/} mask
  is_ipv4 "$ip" || return 1
  is_ipv4 "$base" || return 1
  [[ "$prefix" =~ ^[0-9]{1,2}$ ]] || return 1
  { [ "$prefix" -ge 1 ] && [ "$prefix" -le 32 ]; } || return 1
  mask=$(( 32 - prefix ))
  [ "$(( $(ipv4_to_int "$ip") >> mask ))" -eq "$(( $(ipv4_to_int "$base") >> mask ))" ]
}

case "$SUBNET" in
  */*) ;;
  *) die "SUBNET must be <ipv4>/<prefix>, got '$SUBNET'" ;;
esac
is_ipv4 "${SUBNET%/*}" || die "SUBNET must be an IPv4 network (0-255 per octet, no leading zeros), got '$SUBNET'"
[[ "${SUBNET#*/}" =~ ^[0-9]{1,2}$ ]] || die "SUBNET prefix must be numeric, got '$SUBNET'"
{ [ "${SUBNET#*/}" -ge 1 ] && [ "${SUBNET#*/}" -le 32 ]; } \
  || die "SUBNET prefix must be 1-32, got '$SUBNET'"

# Validated before any state is touched: an iptables error halfway through an
# apply must never be the first sign of a bad setting.
for resolver in $DNS_RESOLVERS; do
  is_ipv4 "$resolver" || die "DNS_RESOLVERS must be space-separated IPv4 addresses, got '$resolver'"
done
[ -n "${DNS_RESOLVERS// /}" ] || die "DNS_RESOLVERS must list at least one IPv4 resolver"

# --- Docker firewall-backend checks ------------------------------------------

# Docker's nftables backend does not use the DOCKER-USER chain at all, so the
# rules below would be dead and the sandbox would fail open. Checked in both
# places it can be configured: daemon.json (whitespace-insensitive, so
# pretty-printed files match too) and dockerd's own unit/drop-ins.
if [ -f "$DAEMON_JSON" ] \
  && tr -d ' \t\n\r' < "$DAEMON_JSON" | grep -q '"firewall-backend":"nftables"'; then
  die "$DAEMON_JSON sets \"firewall-backend\": \"nftables\", which bypasses DOCKER-USER. Set it to \"iptables\" and restart Docker, or port this script to nftables."
fi
if command -v "$SYSTEMCTL" >/dev/null 2>&1 \
  && "$SYSTEMCTL" cat docker 2>/dev/null | grep -Eq -- '--firewall-backend[= ][[:space:]]*nftables'; then
  die "dockerd is started with --firewall-backend=nftables (see: $SYSTEMCTL cat docker), which bypasses DOCKER-USER. Remove the flag and restart Docker, or port this script to nftables."
fi

# --- optional filtered proxy --------------------------------------------------

# ALLOW_PROXY=<ipv4>:<port>: one hole for a filtering proxy. Traffic to a
# host-local address (or anywhere inside $SUBNET, which is where the bridge
# gateway lives) is filtered by INPUT; traffic to anything else (a proxy on
# the LAN) is forwarded and filtered by DOCKER-USER.
PROXY_IP=""
PROXY_PORT=""
PROXY_HOST_LOCAL=0
if [ -n "$ALLOW_PROXY" ]; then
  case "$ALLOW_PROXY" in
    *:*) PROXY_IP=${ALLOW_PROXY%:*}; PROXY_PORT=${ALLOW_PROXY##*:} ;;
    *) die "ALLOW_PROXY must be <ipv4-address>:<port>, got '$ALLOW_PROXY'" ;;
  esac
  is_ipv4 "$PROXY_IP" || die "ALLOW_PROXY must be an IPv4 address (0-255 per octet, no leading zeros), got '$ALLOW_PROXY'"
  [[ "$PROXY_PORT" =~ ^[0-9]{1,5}$ ]] || die "ALLOW_PROXY port must be numeric, got '$ALLOW_PROXY'"
  { [ "$PROXY_PORT" -ge 1 ] && [ "$PROXY_PORT" -le 65535 ]; } \
    || die "ALLOW_PROXY port must be 1-65535, got '$ALLOW_PROXY'"
  # The proxy environment alone confines nothing: a command can ignore it. The
  # firewall has to be authoritative for direct traffic, which means the
  # sandbox must not be routed through a host TUN (BYPASS_TUN=1), or the
  # operator must state that the host has no TUN at all.
  if [ "$mode" != remove ] && [ "$BYPASS_TUN" != 1 ] && [ "$NO_TUN" != 1 ]; then
    die "ALLOW_PROXY needs BYPASS_TUN=1 (keep the firewall authoritative for direct traffic) or NO_TUN=1 (this host has no transparent proxy); a proxy environment variable does not stop a sandbox command from bypassing it"
  fi
  # $SUBNET works even before the bridge exists: the unit runs before
  # docker.service, so the gateway address is not assigned yet at boot.
  if ipv4_in_subnet "$PROXY_IP" "$SUBNET" \
    || "$IP" -4 addr show 2>/dev/null | grep -q "inet $PROXY_IP/"; then
    PROXY_HOST_LOCAL=1
  fi
fi

# --- rule construction --------------------------------------------------------

GENERATION=$(printf '%s|%s|%s|%s' "$SUBNET" "$DNS_RESOLVERS" "$ALLOW_PROXY" "$PROXY_HOST_LOCAL" | sha256sum | cut -c1-12)
COMMENT_SPEC="-m comment --comment $TAG:$GENERATION"

proxy_rule() {
  printf -- '-s %s -d %s -p tcp --dport %s %s -j ACCEPT\n' \
    "$SUBNET" "$PROXY_IP" "$PROXY_PORT" "$COMMENT_SPEC"
}

# Rules for traffic the sandbox originates, read top-to-bottom. The Docker
# chain already ends in `-j RETURN`, so these are inserted at position 1 (the
# loop walks the list backwards to keep this order). Anything not listed here
# is internet egress and stays allowed.
rules() {
  printf -- '-s %s -m conntrack --ctstate ESTABLISHED,RELATED %s -j ACCEPT\n' "$SUBNET" "$COMMENT_SPEC"
  if [ -n "$ALLOW_PROXY" ] && [ "$PROXY_HOST_LOCAL" != 1 ]; then proxy_rule; fi
  for resolver in $DNS_RESOLVERS; do
    printf -- '-s %s -d %s -p udp --dport 53 %s -j ACCEPT\n' "$SUBNET" "$resolver" "$COMMENT_SPEC"
    printf -- '-s %s -d %s -p tcp --dport 53 %s -j ACCEPT\n' "$SUBNET" "$resolver" "$COMMENT_SPEC"
  done
  printf -- '-s %s -d 127.0.0.0/8 %s -j DROP\n' "$SUBNET" "$COMMENT_SPEC"
  printf -- '-s %s -d 169.254.0.0/16 %s -j DROP\n' "$SUBNET" "$COMMENT_SPEC"
  printf -- '-s %s -d 10.0.0.0/8 %s -j DROP\n' "$SUBNET" "$COMMENT_SPEC"
  printf -- '-s %s -d 172.16.0.0/12 %s -j DROP\n' "$SUBNET" "$COMMENT_SPEC"
  printf -- '-s %s -d 192.168.0.0/16 %s -j DROP\n' "$SUBNET" "$COMMENT_SPEC"
  printf -- '-s %s -d 100.64.0.0/10 %s -j DROP\n' "$SUBNET" "$COMMENT_SPEC"
  printf -- '-s %s -m addrtype --dst-type LOCAL %s -j DROP\n' "$SUBNET" "$COMMENT_SPEC"
}

# INPUT sees traffic addressed to the host itself: the Docker gateway, a
# host-local proxy or any host service. The sandbox has no other legitimate
# host-local destination (DNS goes to the public resolvers through FORWARD),
# so everything else from its subnet is dropped here.
input_rules() {
  printf -- '-s %s -m conntrack --ctstate ESTABLISHED,RELATED %s -j ACCEPT\n' "$SUBNET" "$COMMENT_SPEC"
  if [ -n "$ALLOW_PROXY" ] && [ "$PROXY_HOST_LOCAL" = 1 ]; then proxy_rule; fi
  printf -- '-s %s %s -j DROP\n' "$SUBNET" "$COMMENT_SPEC"
}

rule_missing() {
  local chain=$1 rule=$2
  local -a args
  read -r -a args <<< "$rule"
  ! "$IPTABLES" -C "$chain" "${args[@]}" 2>/dev/null
}

# Delete rules of ours in the chain; with an argument, keep that generation.
# Reads the chain back from the kernel (`iptables -S` prints one canonical rule
# per line) so it also finds rules left by an earlier setting.
flush_tagged() {
  local chain=$1 keep=${2:-} line prefix tag
  local -a args
  prefix="-A $chain "
  while IFS= read -r line; do
    case "$line" in
      "$prefix"*) ;;
      *) continue ;;
    esac
    # iptables -S may quote the comment; drop the quotes so the token matches.
    line=$(sed -E "s/\"($TAG:[0-9a-f]+)\"/\\1/" <<< "$line")
    tag=$(grep -oE "$TAG:[0-9a-f]+" <<< "$line" || true)
    if [ -n "$keep" ] && [ "$tag" = "$TAG:$keep" ]; then continue; fi
    read -r -a args <<< "${line#"$prefix"}"
    "$IPTABLES" -D "$chain" "${args[@]}"
  done < <("$IPTABLES" -S "$chain" 2>/dev/null | grep -F -- "$TAG:" || true)
}

stale_tagged() {
  local chain
  for chain in DOCKER-USER INPUT; do
    "$IPTABLES" -S "$chain" 2>/dev/null | grep -F -- "$TAG:" | grep -vF -- "$TAG:$GENERATION" || true
  done
}

apply_current() {
  local chain=$1 source=$2 rule
  local -a args
  while IFS= read -r rule; do
    [ -n "$rule" ] || continue
    read -r -a args <<< "$rule"
    "$IPTABLES" -C "$chain" "${args[@]}" 2>/dev/null \
      || "$IPTABLES" -I "$chain" 1 "${args[@]}"
  done < <(tac <<< "$($source)")
}

# --- optional TUN bypass policy rule ------------------------------------------

# A fake-IP TUN proxy is selected by an ip-rule preference that sits before the
# main table. Our rule points the sandbox subnet at `main` with a lower pref,
# so its packets are routed normally and the iptables rules above see the real
# destination address.

tun_rule_present() {
  "$IP" -4 rule show 2>/dev/null \
    | grep -Eq "^${BYPASS_TUN_PREF}:[[:space:]]+from ${SUBNET} lookup main([[:space:]]|\$)"
}

tun_pref_taken_by_other() {
  "$IP" -4 rule show 2>/dev/null \
    | grep -Eq "^${BYPASS_TUN_PREF}:" && ! tun_rule_present
}

apply_tun_rule() {
  if tun_pref_taken_by_other; then
    die "ip rule preference $BYPASS_TUN_PREF is already used by another rule; set BYPASS_TUN_PREF to a free preference lower than the proxy's rules"
  fi
  "$IP" -4 rule add from "$SUBNET" lookup main pref "$BYPASS_TUN_PREF"
}

# Removes our bypass rule at whatever preference it was added, so a changed
# BYPASS_TUN_PREF does not leave one behind; with an argument, keep that pref.
remove_tun_rule() {
  local keep=${1:-} pref
  for pref in $("$IP" -4 rule show 2>/dev/null \
    | awk -v s="$SUBNET" '$0 ~ ("^[0-9]+:.*from " s " lookup main") { sub(":", "", $1); print $1 }'); do
    [ "$pref" = "$keep" ] && continue
    "$IP" -4 rule del from "$SUBNET" lookup main pref "$pref"
  done
}

# --- checks -------------------------------------------------------------------

check() {
  local missing=0 chain source rule
  for chain in DOCKER-USER INPUT; do
    source=rules
    [ "$chain" = INPUT ] && source=input_rules
    while IFS= read -r rule; do
      [ -n "$rule" ] || continue
      if rule_missing "$chain" "$rule"; then
        echo "firewall: MISSING in $chain: $rule" >&2
        missing=1
      fi
    done < <(tac <<< "$($source)")
  done
  if [ -n "$(stale_tagged)" ]; then
    echo "firewall: STALE rules from an earlier setting are still installed (re-run the script):" >&2
    stale_tagged >&2
    missing=1
  fi
  if [ "$BYPASS_TUN" = 1 ] && ! tun_rule_present; then
    echo "firewall: MISSING TUN bypass: ip -4 rule add from $SUBNET lookup main pref $BYPASS_TUN_PREF" >&2
    missing=1
  fi
  if [ "$missing" -ne 0 ]; then
    echo "firewall: rules are NOT fully applied — the sandbox may reach the LAN" >&2
    return 1
  fi
  if ! "$IP" -4 route show 2>/dev/null | grep -q "$(echo "$SUBNET" | cut -d/ -f1)"; then
    echo "firewall: note: no route for $SUBNET yet (sandbox network not created); rules are in place but verify egress once it is up" >&2
  fi
  echo "firewall: all rules present for $SUBNET" >&2
  if [ -n "$ALLOW_PROXY" ]; then
    echo "firewall: proxy ACCEPT present ($PROXY_IP tcp/$PROXY_PORT via $([ "$PROXY_HOST_LOCAL" = 1 ] && echo INPUT || echo DOCKER-USER))" >&2
  fi
  if [ "$BYPASS_TUN" = 1 ]; then
    echo "firewall: TUN bypass rule present (from $SUBNET lookup main pref $BYPASS_TUN_PREF)" >&2
  fi
}

if [ "$mode" = check ]; then
  check
  exit $?
fi

if [ "$mode" = remove ]; then
  for chain in DOCKER-USER INPUT; do flush_tagged "$chain"; done
  if command -v "$IP" >/dev/null 2>&1; then remove_tun_rule; fi
  echo "firewall: removed sandbox rules for $SUBNET" >&2
  exit 0
fi

# The chain normally exists once the Docker daemon has started at least once;
# the service unit runs before that, so create it. Docker reuses an existing
# DOCKER-USER chain and appends its own RETURN rules to it.
if ! "$IPTABLES" -n -L DOCKER-USER >/dev/null 2>&1; then
  "$IPTABLES" -N DOCKER-USER
  if "$DOCKER" info >/dev/null 2>&1; then
    echo "firewall: WARNING: DOCKER-USER was missing although Docker is running." >&2
    echo "firewall: This usually means Docker's nftables firewall backend is active;" >&2
    echo "firewall: the sandbox would NOT be filtered. Verify egress from inside it." >&2
  fi
fi

# New generation first, old ones after: the drops are never absent.
apply_current DOCKER-USER rules
apply_current INPUT input_rules
for chain in DOCKER-USER INPUT; do flush_tagged "$chain" "$GENERATION"; done
if [ "$BYPASS_TUN" = 1 ]; then
  if ! tun_rule_present; then apply_tun_rule; fi
  remove_tun_rule "$BYPASS_TUN_PREF"
  echo "firewall: ip rule from $SUBNET lookup main pref $BYPASS_TUN_PREF (TUN bypass) in place" >&2
elif command -v "$IP" >/dev/null 2>&1; then
  remove_tun_rule
fi
echo "firewall: sandbox $SUBNET can reach the internet (DNS: $DNS_RESOLVERS), not the LAN or the host" >&2
if [ -n "$ALLOW_PROXY" ]; then
  echo "firewall: sandbox may also reach the filtered proxy $PROXY_IP:$PROXY_PORT" >&2
fi
check

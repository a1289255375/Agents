#!/usr/bin/env bash
# Idempotent deploy of the Cursor bridge relay onto a public Linux server. Re-runnable: it installs
# Node 22, the relay code, a systemd service that runs the relay as an unprivileged user, and (in TLS
# mode) a Let's Encrypt certificate for the server's bare IP via lego plus a daily renewal timer. It
# never writes any secret; the bridge token is only ever held by the plugin on the user's own machine.
#
# Two modes:
#   TLS (default): a trusted bare-IP cert via HTTP-01 on port 80, relay on port 443. Needs inbound 80
#     and 443 reachable from the internet. On Chinese networks these are usually blocked for an
#     unregistered (未备案) IP, so this mode only works after ICP 备案 opens 80/443.
#   --insecure-http: no certificate, relay serves plain HTTP on --port. Works on a high port when
#     80/443 are blocked, but the bearer token and all traffic travel UNENCRYPTED. See README.
#
# Usage (run as root on the server, with cloud/src and cloud/relay present beside it):
#   ./deploy.sh --ip <public-ip> [--email you@example.com]                 # TLS on 443
#   ./deploy.sh --ip <public-ip> --insecure-http --port 18443             # plain HTTP on a high port
#
# Pre-placed binaries (for a server without outbound access) are honoured:
#   NODE_TARBALL=/path/node-v22.x-linux-x64.tar.xz LEGO_TARBALL=/path/lego_vX_linux_amd64.tar.gz ./deploy.sh ...
set -euo pipefail

NODE_VERSION="${NODE_VERSION:-22.11.0}"
LEGO_VERSION="${LEGO_VERSION:-4.19.2}"
PORT=""
EMAIL=""
IP=""
INSECURE=0
MAX_LINKS="${RELAY_MAX_LINKS:-16}"

PREFIX=/opt/cursor-bridge-relay
ETC=/etc/cursor-bridge-relay
LEGO_DIR="$ETC/lego"
LIVE_DIR="$ETC/live"
SERVICE_USER=cursor-relay

say() { printf '\n==> %s\n' "$*"; }
die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

while [ $# -gt 0 ]; do
  case "$1" in
    --ip) IP="$2"; shift 2;;
    --email) EMAIL="$2"; shift 2;;
    --port) PORT="$2"; shift 2;;
    --insecure-http) INSECURE=1; shift;;
    --node-version) NODE_VERSION="$2"; shift 2;;
    *) die "未知参数：$1";;
  esac
done

[ "$(id -u)" = "0" ] || die "请用 root 运行"
[ -n "$IP" ] || die "必须用 --ip 指定服务器公网 IP"
[ -n "$PORT" ] || PORT=$([ "$INSECURE" = "1" ] && echo 18443 || echo 443)
[ -n "$EMAIL" ] || EMAIL="cursor-bridge-relay@example.com" # LE 不校验，仅作联系邮箱占位，可用 --email 覆盖
SCHEME=$([ "$INSECURE" = "1" ] && echo http || echo https)

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC_DIR="$SCRIPT_DIR/../src"
[ -f "$SRC_DIR/relay-mux.mjs" ] || die "找不到 cloud/src（期望在 $SRC_DIR）。把 cloud/src 和 cloud/relay 一起放到服务器再运行。"
[ -f "$SCRIPT_DIR/server.mjs" ] || die "找不到 relay/server.mjs（期望在 $SCRIPT_DIR）"

install_node() {
  if command -v node >/dev/null 2>&1 && node -e 'process.exit(process.versions.node.split(".")[0] >= 22 ? 0 : 1)' 2>/dev/null; then
    say "已有 Node $(node -v)，跳过安装"; return
  fi
  local arch tarball tmp
  case "$(uname -m)" in x86_64) arch=x64;; aarch64|arm64) arch=arm64;; *) die "不支持的架构：$(uname -m)";; esac
  tmp="$(mktemp -d)"
  if [ -n "${NODE_TARBALL:-}" ]; then
    say "使用预置 Node 包 $NODE_TARBALL"; tarball="$NODE_TARBALL"
  else
    tarball="$tmp/node.tar.xz"
    say "下载 Node v$NODE_VERSION（$arch）"
    curl -fsSL "https://nodejs.org/dist/v$NODE_VERSION/node-v$NODE_VERSION-linux-$arch.tar.xz" -o "$tarball" \
      || die "下载 Node 失败。可在能联网的机器下好后用 NODE_TARBALL=... 重跑"
  fi
  rm -rf "$PREFIX/node"
  mkdir -p "$PREFIX/node"
  tar -xJf "$tarball" -C "$PREFIX/node" --strip-components=1
  ln -sf "$PREFIX/node/bin/node" /usr/local/bin/node
  rm -rf "$tmp"
  say "Node 安装为 $("$PREFIX/node/bin/node" -v)"
}

install_lego() {
  if [ -x "$PREFIX/bin/lego" ]; then say "已有 lego，跳过安装"; return; fi
  local arch tarball tmp
  case "$(uname -m)" in x86_64) arch=amd64;; aarch64|arm64) arch=arm64;; *) die "不支持的架构：$(uname -m)";; esac
  tmp="$(mktemp -d)"
  if [ -n "${LEGO_TARBALL:-}" ]; then
    say "使用预置 lego 包 $LEGO_TARBALL"; tarball="$LEGO_TARBALL"
  else
    tarball="$tmp/lego.tar.gz"
    say "下载 lego v$LEGO_VERSION（$arch）"
    curl -fsSL "https://github.com/go-acme/lego/releases/download/v$LEGO_VERSION/lego_v${LEGO_VERSION}_linux_${arch}.tar.gz" -o "$tarball" \
      || die "下载 lego 失败。可在能联网的机器下好后用 LEGO_TARBALL=... 重跑"
  fi
  mkdir -p "$PREFIX/bin"
  tar -xzf "$tarball" -C "$PREFIX/bin" lego
  chmod +x "$PREFIX/bin/lego"
  rm -rf "$tmp"
  say "lego 安装为 $("$PREFIX/bin/lego" --version | head -n1)"
}

copy_code() {
  say "复制中继代码到 $PREFIX"
  mkdir -p "$PREFIX/src" "$PREFIX/relay"
  install -m 0644 "$SRC_DIR"/relay-mux.mjs "$PREFIX/src/"
  install -m 0644 "$SCRIPT_DIR"/relay.mjs "$SCRIPT_DIR"/server.mjs "$PREFIX/relay/"
}

ensure_user() {
  id "$SERVICE_USER" >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin "$SERVICE_USER"
}

# Copy lego's output into a stable live/ dir the relay reads, with the key readable only by its group.
# Written as a standalone script so the renewal timer's hook reuses it. The relay fs.watches live/.
write_install_cert() {
  cat > "$PREFIX/install-cert.sh" <<EOF
#!/usr/bin/env bash
set -euo pipefail
install -d -m 0755 "$LIVE_DIR"
install -m 0644 "$LEGO_DIR/certificates/$IP.crt" "$LIVE_DIR/fullchain.pem"
install -m 0640 -g "$SERVICE_USER" "$LEGO_DIR/certificates/$IP.key" "$LIVE_DIR/privkey.pem"
EOF
  chmod 0755 "$PREFIX/install-cert.sh"
}

obtain_cert() {
  install -d -m 0755 "$ETC" "$LEGO_DIR"
  local common=(--accept-tos --email "$EMAIL" --path "$LEGO_DIR" --http --http.port ":80" --domains "$IP")
  if [ -f "$LEGO_DIR/certificates/$IP.crt" ]; then
    say "续期证书（HTTP-01，端口 80）"
    "$PREFIX/bin/lego" "${common[@]}" renew --days 2 --no-random-sleep --renew-hook "$PREFIX/install-cert.sh" \
      || die "续期失败：确认 LE 能从公网访问本机 80 端口（云安全组需放行入站 80），且 80 未被占用"
  else
    say "首次申请裸 IP 证书（short-lived profile，HTTP-01，端口 80）"
    "$PREFIX/bin/lego" "${common[@]}" --disable-cn run --profile shortlived \
      || die "申请失败：确认 LE 能从公网访问本机 80 端口（云安全组需放行入站 80），且 80 未被占用"
  fi
  "$PREFIX/install-cert.sh"
  say "证书就绪：$LIVE_DIR/fullchain.pem"
}

write_units() {
  install -d -m 0755 "$ETC"
  {
    echo "RELAY_PORT=$PORT"
    echo "RELAY_HOST=0.0.0.0"
    echo "RELAY_MAX_LINKS=$MAX_LINKS"
    if [ "$INSECURE" = "0" ]; then
      echo "RELAY_CERT=$LIVE_DIR/fullchain.pem"
      echo "RELAY_KEY=$LIVE_DIR/privkey.pem"
    fi
  } > "$ETC/relay.env"
  cat > /etc/systemd/system/cursor-bridge-relay.service <<EOF
[Unit]
Description=Cursor bridge relay
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$SERVICE_USER
EnvironmentFile=$ETC/relay.env
ExecStart=/usr/local/bin/node $PREFIX/relay/server.mjs
AmbientCapabilities=CAP_NET_BIND_SERVICE
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
ReadOnlyPaths=$ETC
Restart=always
RestartSec=2

[Install]
WantedBy=multi-user.target
EOF
  [ "$INSECURE" = "0" ] || return 0
  # Renewal: a daily timer runs lego renew; the hook refreshes live/ and the relay reloads in place.
  cat > /etc/systemd/system/cursor-bridge-relay-renew.service <<EOF
[Unit]
Description=Renew the Cursor bridge relay certificate

[Service]
Type=oneshot
ExecStart=$PREFIX/bin/lego --accept-tos --email $EMAIL --path $LEGO_DIR --http --http.port :80 --domains $IP renew --days 2 --no-random-sleep --renew-hook $PREFIX/install-cert.sh
EOF
  cat > /etc/systemd/system/cursor-bridge-relay-renew.timer <<EOF
[Unit]
Description=Daily renewal check for the Cursor bridge relay certificate

[Timer]
OnCalendar=daily
RandomizedDelaySec=1h
Persistent=true

[Install]
WantedBy=timers.target
EOF
}

open_firewall() {
  local ports="$PORT"
  [ "$INSECURE" = "0" ] && ports="80 $PORT" # TLS mode also needs 80 for the ACME challenge
  if command -v firewall-cmd >/dev/null 2>&1 && firewall-cmd --state >/dev/null 2>&1; then
    say "firewalld：放行 $ports"
    for p in $ports; do firewall-cmd --permanent --add-port="$p"/tcp >/dev/null; done
    firewall-cmd --reload >/dev/null
  elif command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q "Status: active"; then
    say "ufw：放行 $ports"
    for p in $ports; do ufw allow "$p"/tcp >/dev/null; done
  else
    say "未检测到启用的本机防火墙，跳过（云平台安全组需另在控制台放行入站 $ports）"
  fi
}

install_node
copy_code
ensure_user
if [ "$INSECURE" = "0" ]; then
  install_lego
  write_install_cert
  obtain_cert
fi
write_units
open_firewall

say "启用并启动服务"
systemctl daemon-reload
systemctl enable --now cursor-bridge-relay.service
[ "$INSECURE" = "0" ] && systemctl enable --now cursor-bridge-relay-renew.timer
sleep 1
systemctl --no-pager --full status cursor-bridge-relay.service | sed -n '1,8p' || true

ADDR="$SCHEME://$IP:$PORT"
cat <<EOF

完成。中继已在 $ADDR 上监听（$([ "$INSECURE" = "1" ] && echo "明文 HTTP，令牌与流量未加密" || echo "TLS")）。
  • 健康检查（本机）：curl -sS $ADDR/__relay_health__
  • 插件里把“服务器地址”填 $ADDR，云端 MCP 的 URL 用 $ADDR/mcp
  • 服务：systemctl status cursor-bridge-relay ；日志：journalctl -u cursor-bridge-relay -f
EOF
[ "$INSECURE" = "1" ] && echo "  • 注意：这是明文 HTTP。Bearer 令牌和所有 MCP 流量都未加密，详见 README 的安全说明。"

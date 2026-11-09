#!/usr/bin/env bash
# LearnGPT 一键安装：npm 依赖、.env.local、render2img 用的浏览器和中文字体、生产构建，最后渲染一张图自检。
# 用法：bash install.sh [--skip-browser] [--skip-fonts] [--skip-build] [--skip-check]
#       OPENAI_API_KEY=sk-... bash install.sh    # 同时把密钥写入 .env.local
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")"
ROOT=$(pwd)

skip_browser=0
skip_fonts=0
skip_build=0
skip_check=0
for arg in "$@"; do
  case "$arg" in
    --skip-browser) skip_browser=1 ;;
    --skip-fonts) skip_fonts=1 ;;
    --skip-build) skip_build=1 ;;
    --skip-check) skip_check=1 ;;
    -h | --help)
      sed -n '2,4p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "未知参数：${arg}（--help 查看用法）" >&2
      exit 1
      ;;
  esac
done

step() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
note() { printf '    %s\n' "$*"; }
warn() { printf '\033[33m    警告：%s\033[0m\n' "$*" >&2; }
die() {
  printf '\033[31m错误：%s\033[0m\n' "$*" >&2
  exit 1
}

# 系统软件包需要 root。非 root 时只使用免密码 sudo，避免在无人值守的环境里卡在密码提示上。
if [ "$(id -u)" -eq 0 ]; then
  ROOT_CMD=""
elif command -v sudo >/dev/null 2>&1 && sudo -n true 2>/dev/null; then
  ROOT_CMD="sudo"
else
  ROOT_CMD="none"
fi
can_root() { [ "$ROOT_CMD" != "none" ]; }
as_root() {
  if [ -z "$ROOT_CMD" ]; then "$@"; else sudo env "PATH=$PATH" "$@"; fi
}
is_linux() { [ "$(uname -s)" = "Linux" ]; }

find_browser() {
  node --experimental-strip-types --no-warnings -e \
    'import("./src/server/render/chrome.ts").then((m) => console.log(m.findChrome() ?? ""))' 2>/dev/null || true
}

step "检查 Node.js"
command -v node >/dev/null 2>&1 || die "没有找到 node，请先安装 Node.js 24。"
command -v npm >/dev/null 2>&1 || die "没有找到 npm。"
node_major=$(node -p 'process.versions.node.split(".")[0]')
node_minor=$(node -p 'process.versions.node.split(".")[1]')
# node:sqlite 从 22.13 起无需命令行开关。
if [ "$node_major" -lt 22 ] || { [ "$node_major" -eq 22 ] && [ "$node_minor" -lt 13 ]; }; then
  die "Node.js $(node -v) 太旧，至少需要 22.13，推荐 24。"
fi
note "Node.js $(node -v)，npm $(npm -v)"
if [ "$node_major" -lt 24 ]; then
  warn "项目要求 Node.js 24，部分依赖要求至少 22.19。当前版本通常能运行，但 npm 会提示 EBADENGINE。建议升级：nvm install 24"
fi

step "安装 npm 依赖"
if [ -f package-lock.json ]; then
  npm ci --no-audit --no-fund
else
  npm install --no-audit --no-fund
fi

step "配置 .env.local"
if [ ! -f .env.local ]; then
  cp .env.example .env.local
  note "已从 .env.example 创建 .env.local"
fi
if [ -n "${OPENAI_API_KEY:-}" ]; then
  tmp=$(mktemp)
  awk '/^OPENAI_API_KEY=/ { if (!done) print "OPENAI_API_KEY=" ENVIRON["OPENAI_API_KEY"]; done = 1; next } { print } END { if (!done) print "OPENAI_API_KEY=" ENVIRON["OPENAI_API_KEY"] }' .env.local >"$tmp"
  mv "$tmp" .env.local
  note "已写入 OPENAI_API_KEY"
elif ! grep -qE '^OPENAI_API_KEY=.+' .env.local; then
  warn "还没有设置 OPENAI_API_KEY。编辑 .env.local，或启动后在「设置 → 模型服务」中配置。"
fi
chmod 600 .env.local

browser=""
if [ "$skip_browser" -eq 0 ]; then
  step "检查 render2img 使用的浏览器"
  browser=$(find_browser)
  if [ -z "$browser" ]; then
    note "没有找到 Chrome、Chromium 或 Edge，安装 Playwright 的 chromium-headless-shell"
    if is_linux; then
      if can_root; then
        as_root npx --yes playwright install-deps chromium || warn "浏览器依赖的系统库没有装全，Chrome 可能无法启动。"
      else
        warn "没有 root 或免密码 sudo，跳过浏览器依赖的系统库。缺库时请让管理员运行：npx playwright install-deps chromium"
      fi
    fi
    npx --yes playwright install chromium-headless-shell || warn "浏览器下载失败。"
    browser=$(find_browser)
  fi
  if [ -n "$browser" ]; then
    note "浏览器：${browser}"
  else
    warn "仍然没有可用的浏览器。render2img 和 npm run render 不可用，聊天不受影响。"
  fi
fi

if [ "$skip_fonts" -eq 0 ] && is_linux; then
  step "检查中文字体"
  if command -v fc-list >/dev/null 2>&1 && [ -n "$(fc-list :lang=zh 2>/dev/null | head -n 1)" ]; then
    note "已有中文字体"
  elif ! can_root; then
    warn "没有 root 或免密码 sudo，跳过。缺少中文字体时，截图里的中文会显示成方块。"
  else
    if command -v apt-get >/dev/null 2>&1; then
      as_root apt-get update -y && as_root env DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends fontconfig fonts-noto-cjk fonts-noto-color-emoji
    elif command -v dnf >/dev/null 2>&1; then
      as_root dnf install -y fontconfig google-noto-sans-cjk-ttc-fonts || as_root dnf install -y fontconfig google-noto-sans-cjk-fonts
    elif command -v yum >/dev/null 2>&1; then
      as_root yum install -y fontconfig google-noto-sans-cjk-ttc-fonts
    elif command -v apk >/dev/null 2>&1; then
      as_root apk add --no-cache fontconfig font-noto-cjk font-noto-emoji
    elif command -v pacman >/dev/null 2>&1; then
      as_root pacman -Sy --noconfirm fontconfig noto-fonts-cjk noto-fonts-emoji
    else
      warn "无法识别的包管理器，请手动安装 Noto CJK 字体。"
    fi || warn "字体安装失败，截图里的中文可能显示成方块。"
    if command -v fc-cache >/dev/null 2>&1; then fc-cache -f >/dev/null 2>&1 || true; fi
  fi
fi

if [ "$skip_build" -eq 0 ]; then
  step "构建生产版本"
  npm run build
fi

if [ "$skip_check" -eq 0 ]; then
  step "自检：渲染一张示例图"
  if [ -z "$browser" ] && [ -z "$(find_browser)" ]; then
    warn "没有可用的浏览器，跳过。"
  elif [ ! -f .next/BUILD_ID ]; then
    warn "没有生产构建，跳过。去掉 --skip-build 重新运行即可自检。"
  else
    sample_dir=$(mktemp -d)
    cat >"$sample_dir/install-check.oui" <<'OUI'
root = Col([title, intro, chart])
title = Title("安装自检 Install check 123", "lg")
intro = Text("看到这段中文和下面的柱状图，说明渲染正常。", "md", "muted")
chart = Chart("bar", [{"科目": "数学", "分数": 92}, {"科目": "语文", "分数": 88}, {"科目": "英语", "分数": 95}], "科目", ["分数"], "number", null, false, 200)
OUI
    mkdir -p .learnev
    if npm run --silent render -- "$sample_dir/install-check.oui" --out "$ROOT/.learnev/install-check.png"; then
      note "请打开 .learnev/install-check.png 确认中文和图表显示正常。"
    else
      rm -rf "$sample_dir"
      die "自检渲染失败，见上方输出。"
    fi
    rm -rf "$sample_dir"
  fi
fi

step "安装完成"
note "启动服务：npm start          （http://127.0.0.1:3000，只接受本机访问）"
note "开发模式：npm run dev"
note "渲染图片：npm run render -- page.oui --width 480"
if ! grep -qE '^OPENAI_API_KEY=.+' .env.local; then
  note "别忘了在 .env.local 填写 OPENAI_API_KEY。"
fi

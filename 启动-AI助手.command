#!/bin/bash
# ============================================
#  个人AI助手 · Mac 启动器（双击运行）
#  如被系统拦截：右键本文件 → 打开 → 打开
# ============================================
cd "$(dirname "$0")" || exit 1

echo "======================================"
echo "   个人AI助手 · 启动检查"
echo "======================================"

# ---- 1. 检查 Node.js ----
if ! command -v node >/dev/null 2>&1; then
  echo ""
  echo "[缺少环境] 你的电脑还没有安装 Node.js"
  echo "正在为你打开下载页面，请下载 LTS 版并安装（一路下一步即可）"
  echo "安装完成后，重新双击本文件。"
  open "https://nodejs.org/zh-cn/download" 2>/dev/null || open "https://nodejs.org/"
  exit 1
fi

# Node 版本需 >= 18
node -e "process.exit(+process.version.slice(1).split('.')[0] >= 18 ? 0 : 1)" 2>/dev/null
if [ $? -ne 0 ]; then
  echo ""
  echo "[版本过低] 当前 Node $(node -v)，需要 18 或更高版本"
  echo "正在打开下载页，请安装最新 LTS 版后重新双击本文件。"
  open "https://nodejs.org/zh-cn/download" 2>/dev/null || open "https://nodejs.org/"
  exit 1
fi
echo "[1/4] Node.js 已就绪：$(node -v)"

# ---- 2. 检查 .env（API Key）----
if [ ! -f .env ]; then
  cp .env.example .env
  echo ""
  echo "[2/4] 首次运行：已为你创建配置文件 .env"
  echo "--------------------------------------"
  echo "  还需要一步：填入你的 DeepSeek API Key"
  echo "  获取地址：https://platform.deepseek.com/"
  echo "  （注册 → API Keys → 创建，复制 sk- 开头那串）"
  echo "--------------------------------------"
  echo "正在打开配置文件，请把 Key 粘贴到 DEEPSEEK_API_KEY= 后面，"
  echo "保存并关闭编辑器后，回到本窗口按【回车】继续..."
  open -e .env 2>/dev/null || open -a TextEdit .env 2>/dev/null || open .env
  read -r
fi

# 校验 Key
KEY=$(grep -E '^DEEPSEEK_API_KEY=' .env | head -1 | cut -d= -f2- | tr -d ' \r')
if [ -z "$KEY" ] || [ "$KEY" = "sk-xxx" ]; then
  echo ""
  echo "[Key 未配置] .env 里的 DEEPSEEK_API_KEY 还是空的"
  echo "正在重新打开配置文件，填好保存后，回到本窗口按【回车】..."
  open -e .env 2>/dev/null || open -a TextEdit .env 2>/dev/null || open .env
  read -r
  KEY=$(grep -E '^DEEPSEEK_API_KEY=' .env | head -1 | cut -d= -f2- | tr -d ' \r')
  if [ -z "$KEY" ] || [ "$KEY" = "sk-xxx" ]; then
    echo "[退出] 仍未检测到 Key。下次双击本文件可继续。"
    exit 1
  fi
fi
echo "[2/4] DeepSeek Key 已配置"

# ---- 3. 安装依赖 ----
if [ ! -d node_modules ]; then
  echo ""
  echo "[3/4] 首次运行：安装依赖中（约 1-3 分钟，取决于网速）..."
  if ! npm install --no-audit --no-fund --loglevel=error; then
    echo "默认源失败，切换国内镜像源重试..."
    npm install --no-audit --no-fund --loglevel=error --registry=https://registry.npmmirror.com || {
      echo "[失败] 依赖安装失败，请检查网络后重新双击本文件。"
      exit 1
    }
  fi
else
  echo "[3/4] 依赖已就绪"
fi

# ---- 4. 打印地址并启动 ----
LAN_IP=$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || echo "")
PORT=$(grep -E '^PORT=' .env 2>/dev/null | head -1 | cut -d= -f2- | tr -d ' \r'); PORT=${PORT:-3000}

echo ""
echo "[4/4] 启动服务..."
echo "======================================"
echo "  本机访问：http://localhost:${PORT}"
if [ -n "$LAN_IP" ]; then
echo "  手机访问：http://${LAN_IP}:${PORT}  (手机需连同一WiFi)"
fi
echo "  停止服务：直接关闭本窗口，或按 Ctrl+C"
echo "======================================"

# 2 秒后自动打开浏览器
( sleep 2; open "http://localhost:${PORT}" ) &

exec node server.js

@echo off
chcp 65001 >nul
setlocal EnableDelayedExpansion
cd /d "%~dp0"

echo ======================================
echo    个人AI助手 · 启动检查
echo ======================================

REM ---- 1. 检查 Node.js ----
where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo [缺少环境] 你的电脑还没有安装 Node.js
  echo 正在为你打开下载页面，请下载 LTS 版并安装（一路下一步即可）
  echo 安装完成后，重新双击本文件。
  start https://nodejs.org/zh-cn/download
  pause
  exit /b 1
)

node -e "process.exit(+process.version.slice(1).split('.')[0] >= 18 ? 0 : 1)" >nul 2>nul
if errorlevel 1 (
  echo.
  echo [版本过低] Node 版本需要 18 或更高，正在打开下载页...
  echo 安装最新 LTS 版后，重新双击本文件。
  start https://nodejs.org/zh-cn/download
  pause
  exit /b 1
)
for /f "delims=" %%v in ('node -v') do set NODEV=%%v
echo [1/4] Node.js 已就绪：%NODEV%

REM ---- 2. 检查 .env（API Key）----
if not exist .env (
  copy /y .env.example .env >nul
  echo.
  echo [2/4] 首次运行：已为你创建配置文件 .env
  echo --------------------------------------
  echo   还需要一步：填入你的 DeepSeek API Key
  echo   获取地址：https://platform.deepseek.com/
  echo   （注册 → API Keys → 创建，复制 sk- 开头那串）
  echo --------------------------------------
  echo 正在用记事本打开配置文件，请把 Key 粘贴到 DEEPSEEK_API_KEY= 后面，
  echo 保存并关闭记事本后，回到本窗口按任意键继续...
  notepad .env
  pause >nul
)

set "KEY="
for /f "usebackq tokens=1,* delims==" %%a in (".env") do (
  if /i "%%a"=="DEEPSEEK_API_KEY" set "KEY=%%b"
)
set "KEY=%KEY: =%"

if "%KEY%"=="" goto :needkey
if "%KEY%"=="sk-xxx" goto :needkey
goto :keyok

:needkey
echo.
echo [Key 未配置] .env 里的 DEEPSEEK_API_KEY 还是空的
echo 正在重新打开配置文件，填好保存后，回到本窗口按任意键...
notepad .env
pause >nul
set "KEY="
for /f "usebackq tokens=1,* delims==" %%a in (".env") do (
  if /i "%%a"=="DEEPSEEK_API_KEY" set "KEY=%%b"
)
set "KEY=%KEY: =%"
if "%KEY%"=="" exit /b 1
if "%KEY%"=="sk-xxx" exit /b 1

:keyok
echo [2/4] DeepSeek Key 已配置

REM ---- 3. 安装依赖 ----
if not exist node_modules (
  echo.
  echo [3/4] 首次运行：安装依赖中（约 1-3 分钟，取决于网速）...
  call npm install --no-audit --no-fund --loglevel=error
  if errorlevel 1 (
    echo 默认源失败，切换国内镜像源重试...
    call npm install --no-audit --no-fund --loglevel=error --registry=https://registry.npmmirror.com
    if errorlevel 1 (
      echo [失败] 依赖安装失败，请检查网络后重新双击本文件。
      pause
      exit /b 1
    )
  )
) else (
  echo [3/4] 依赖已就绪
)

REM ---- 4. 打印地址并启动 ----
set PORT=3000
for /f "usebackq tokens=1,* delims==" %%a in (".env") do (
  if /i "%%a"=="PORT" set "PORT=%%b"
)
set "PORT=%PORT: =%"

echo.
echo [4/4] 启动服务...
echo ======================================
echo   本机访问：http://localhost:%PORT%
echo   手机访问（同一WiFi），看下面 IPv4 地址：
ipconfig | findstr /C:"IPv4"
echo   把上面任一 IPv4 地址拼成 http://地址:%PORT% 用手机浏览器打开
echo   停止服务：直接关闭本窗口
echo ======================================

start "" "http://localhost:%PORT%"
node server.js
pause

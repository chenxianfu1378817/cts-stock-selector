#!/bin/zsh
set -e
cd "$(dirname "$0")"
KEY_FILE="$HOME/.config/iwencai/api_key"
if [[ ! -r "$KEY_FILE" ]]; then
  echo "未找到本机问财凭据：$KEY_FILE"
  read -k 1 "?按任意键退出..."
  exit 1
fi
export IWENCAI_API_KEY="$(<"$KEY_FILE")"
export IWENCAI_BASE_URL="${IWENCAI_BASE_URL:-https://openapi.iwencai.com}"
open "http://localhost:3000"
npm run dev

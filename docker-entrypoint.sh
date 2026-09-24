#!/bin/bash
# wait -n 是 bashism，node:*-slim 的 Debian base image 有內建 bash，用
# #!/bin/sh（多半連到 dash）的話這個指令會直接不存在。
set -e

# 單一 container 跑兩個 process（Express Gateway/Admin API + Next.js
# Web UI）——這個專案定位是個人單機使用，不需要為了「架構上比較標準」而
# 拆成兩個 container，見 README「Docker 部署」段落的說明。

echo "Applying database migrations..."
node dist/migrate.js

node dist/server.js &
BACKEND_PID=$!

(cd frontend && PORT="${FRONTEND_PORT:-3000}" node_modules/.bin/next start) &
FRONTEND_PID=$!

# 任一個 process 掛掉就讓整個 container 一起結束退出，而不是留著另一個
# process 半死不活地繼續跑——這樣 docker 的 restart policy／健康檢查才能
# 正確接手。
wait -n "$BACKEND_PID" "$FRONTEND_PID"
exit $?

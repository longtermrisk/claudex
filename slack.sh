#!/bin/bash
# Entrypoint for manage.sh: ~/manage.sh slack start|stop|restart|status|logs
set -e
cd "$(dirname "${BASH_SOURCE[0]}")"

# Kill any existing instances of the bot
pkill -f 'node.*dist/index.js' 2>/dev/null && echo "Killed existing bot process(es)" && sleep 1 || true

npm run build
exec node --env-file=.env dist/index.js

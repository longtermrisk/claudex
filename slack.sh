#!/bin/bash
# Entrypoint for manage.sh: ~/manage.sh slack start|stop|restart|status|logs
set -e
cd "$(dirname "${BASH_SOURCE[0]}")"

npm run build
exec node --env-file=.env dist/index.js

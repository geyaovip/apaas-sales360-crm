#!/bin/sh
set -eu
cd /workspace/apps/sales360-crm/backend
./node_modules/.bin/prisma migrate deploy
node dist/bootstrap-admin.js
exec node dist/main.js

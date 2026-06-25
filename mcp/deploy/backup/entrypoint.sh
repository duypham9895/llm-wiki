#!/bin/sh
set -eu

cat > /etc/crontabs/root <<EOF
0 3 * * * /usr/local/bin/backup.sh >> /var/log/backup.log 2>&1
EOF

exec crond -f -L /dev/stdout

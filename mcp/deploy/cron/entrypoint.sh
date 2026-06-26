#!/bin/sh
# entrypoint.sh — start busybox crond in foreground; logs stream to container stdout.
# Must run as root — busybox crond only reads /etc/crontabs/root for the root user.
set -eu

# Scripts are bind-mounted read-only at /etc/cron.d/. Copy to /tmp (writable) and chmod
# +x so crond can exec them. /tmp copy is ephemeral — regenerated on every container start.
cp /etc/cron.d/cron-pipeline.sh /tmp/cron-pipeline.sh
cp /etc/cron.d/cron-reindex.sh /tmp/cron-reindex.sh
chmod +x /tmp/cron-pipeline.sh /tmp/cron-reindex.sh

# crond -f = foreground, -L /dev/stdout = stream cron logs to docker logs.
exec crond -f -L /dev/stdout

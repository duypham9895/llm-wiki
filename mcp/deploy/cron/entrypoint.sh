#!/bin/sh
# entrypoint.sh — start busybox crond in foreground; logs stream to container stdout.
# Must run as root — busybox crond only reads /etc/crontabs/root for the root user.
set -eu

# Make sure cron scripts are executable (bind-mounted files keep host perms;
# the host umask may strip +x even though git tracked it).
chmod +x /usr/local/bin/cron-pipeline.sh /usr/local/bin/cron-reindex.sh

# crond -f = foreground, -L /dev/stdout = stream cron logs to docker logs.
exec crond -f -L /dev/stdout

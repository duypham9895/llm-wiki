#!/bin/sh
set -eu

# Wait for docker.sock to be ready (compose-side mount may race).
while [ ! -S /var/run/docker.sock ]; do sleep 1; done

while true; do
  sh /usr/local/bin/poll.sh || echo "poll error (continuing)"
  sleep 21600
done

FROM docker:27-cli

RUN apk add --no-cache bash curl

COPY poll.sh /usr/local/bin/poll.sh
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/poll.sh /usr/local/bin/entrypoint.sh

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]

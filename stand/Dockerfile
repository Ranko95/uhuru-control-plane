FROM node:24.11.0-bookworm-slim AS node
FROM uhuru-node-agent-stand:ticket-01
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN ln -s ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
 && apt-get update && apt-get install -y --no-install-recommends postgresql \
 && rm -rf /var/lib/apt/lists/* \
 && useradd --system --no-create-home --shell /usr/sbin/nologin uhuru
WORKDIR /opt/uhuru
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund
COPY src ./src
COPY schema.sql ./schema.sql
COPY deploy ./deploy
COPY stand/e2e.py /control-plane-e2e.py
RUN install -m 0644 deploy/uhuru-control-plane.service /etc/systemd/system/ \
 && mkdir -p /etc/systemd/system/postgresql@.service.d \
 && printf '[Service]\nLimitCORE=0\n' > /etc/systemd/system/postgresql@.service.d/no-core.conf

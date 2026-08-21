DEPLOY_DIR = deploy
ANSIBLE = ansible-playbook -i $(DEPLOY_DIR)/inventory.ini -e @$(DEPLOY_DIR)/vars.yml
DEPLOY = $(ANSIBLE) $(DEPLOY_DIR)/deploy.yml
BUILD_HOST = $(ANSIBLE) $(DEPLOY_DIR)/build-host.yml

WABOT_DIR = /opt/wabot
# corre um comando na app já em execução no host (via ansible, sem ssh manual)
REMOTE = $(ANSIBLE) $(DEPLOY_DIR)/run.yml -e wabot_dir=$(WABOT_DIR)

.PHONY: deploy build-host server bot install-postgresql backfill-presence backfill-presence-dry logs-bot

deploy:
	$(DEPLOY)

build-host:
	$(BUILD_HOST)

server:
	$(DEPLOY) --tags server

bot:
	$(DEPLOY) --tags bot

install-postgresql:
	$(BUILD_HOST) --tags postgresql

# --- backfill da presença a partir do histórico de eventos ---
# BACKFILL_ARGS permite recortar: make backfill-presence BACKFILL_ARGS="--from=2026-01-01"
backfill-presence-dry:
	$(REMOTE) -e 'cmd="node backfill-presence.js --dry-run $(BACKFILL_ARGS)"'

backfill-presence:
	$(REMOTE) -e 'cmd="node backfill-presence.js $(BACKFILL_ARGS)"'

logs-bot:
	$(REMOTE) -e 'cmd_raw="docker compose logs --tail=100 bot"'

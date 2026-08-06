DEPLOY_DIR = deploy
ANSIBLE = ansible-playbook -i $(DEPLOY_DIR)/inventory.ini -e @$(DEPLOY_DIR)/vars.yml
DEPLOY = $(ANSIBLE) $(DEPLOY_DIR)/deploy.yml
BUILD_HOST = $(ANSIBLE) $(DEPLOY_DIR)/build-host.yml

.PHONY: deploy build-host server bot install-postgresql

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

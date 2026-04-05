DEPLOY_DIR = deploy
PLAYBOOK = ansible-playbook -i $(DEPLOY_DIR)/inventory.ini $(DEPLOY_DIR)/playbook.yml -e @$(DEPLOY_DIR)/vars.yml

.PHONY: deploy server bot

deploy:
	$(PLAYBOOK)

server:
	$(PLAYBOOK) --tags server

bot:
	$(PLAYBOOK) --tags bot

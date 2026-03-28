ALTER TABLE contacts ADD COLUMN type TEXT NOT NULL DEFAULT 'person';

-- marca grupos existentes baseado no JID
UPDATE contacts SET type = 'group' WHERE jid LIKE '%@g.us';
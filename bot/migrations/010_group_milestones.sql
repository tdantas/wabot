-- Marcos (milestones) são opt-in por grupo: nascem desligados e só são
-- ligados na UI de definições.
ALTER TABLE group_settings
  ADD COLUMN IF NOT EXISTS milestones BOOLEAN NOT NULL DEFAULT FALSE;

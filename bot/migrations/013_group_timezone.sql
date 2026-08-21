-- Fuso horário de apresentação, por grupo. Grupos portugueses ficam no default;
-- grupos brasileiros passam a ver os dados no fuso deles (ex.: America/Recife).
ALTER TABLE group_settings
  ADD COLUMN IF NOT EXISTS timezone TEXT NOT NULL DEFAULT 'Europe/Lisbon';

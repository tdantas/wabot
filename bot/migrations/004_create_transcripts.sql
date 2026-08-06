CREATE TABLE IF NOT EXISTS transcripts (
  audio_hash TEXT PRIMARY KEY,
  transcription TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

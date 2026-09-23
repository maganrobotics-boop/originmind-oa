CREATE TABLE newbie_agreement_acceptances (
  email TEXT NOT NULL,
  agreement_version TEXT NOT NULL,
  signer_name TEXT NOT NULL,
  content_sha256 TEXT NOT NULL,
  accepted_at INTEGER NOT NULL,
  review_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (review_status IN ('pending', 'approved', 'rejected')),
  reviewed_by TEXT NOT NULL DEFAULT '',
  reviewed_at INTEGER,
  review_note TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (email, agreement_version)
);

CREATE INDEX idx_newbie_agreement_acceptances_email_time
  ON newbie_agreement_acceptances (email, accepted_at DESC);

CREATE INDEX idx_newbie_agreement_acceptances_review_queue
  ON newbie_agreement_acceptances (review_status, accepted_at ASC);


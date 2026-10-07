-- Preserve user-authorized bill-name assignments across later CSV imports.
ALTER TABLE expense_people ADD COLUMN aliases_json TEXT NOT NULL DEFAULT '[]';

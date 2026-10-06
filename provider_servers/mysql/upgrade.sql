-- Upgrade for a database created from an earlier copy of this kit (published
-- on or before September 16, 2026). Back up the database and attachment files
-- first, run this once against the gateway database, then restart the sync
-- service.
--
-- It adds team record protocol 2: every team item is stored and authorized on
-- its own, with paired-device principals and per-member edit and delete flags.
-- A workspace that already holds team snapshots answers "migration_required"
-- until an administrator has reviewed that data; this script neither converts
-- nor deletes it.
ALTER TABLE workspaces
  ADD COLUMN record_protocol INT NOT NULL DEFAULT 1 AFTER owner_user_id;

ALTER TABLE workspace_members
  ADD COLUMN principal_id CHAR(36) NULL AFTER role,
  ADD COLUMN can_edit BOOLEAN NOT NULL DEFAULT TRUE AFTER principal_id,
  ADD COLUMN can_delete BOOLEAN NOT NULL DEFAULT FALSE AFTER can_edit;

ALTER TABLE workspace_invites
  ADD COLUMN delegated_principal CHAR(36) NULL AFTER created_by;

CREATE TABLE IF NOT EXISTS team_records (
  workspace_id VARCHAR(100) NOT NULL,
  id VARCHAR(128) NOT NULL,
  record_json JSON NOT NULL,
  PRIMARY KEY(workspace_id,id),
  FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
) ENGINE=InnoDB;

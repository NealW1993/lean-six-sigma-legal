CREATE DATABASE IF NOT EXISTS six_sigma_sync
  CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
USE six_sigma_sync;

CREATE TABLE IF NOT EXISTS sync_users (
  id CHAR(36) PRIMARY KEY,
  refresh_token_hash CHAR(64) NOT NULL UNIQUE,
  refresh_expires_at DATETIME(6) NOT NULL,
  revoked_at DATETIME(6) NULL,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
    ON UPDATE CURRENT_TIMESTAMP(6),
  INDEX idx_sync_users_refresh_expiry (refresh_expires_at)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS personal_vaults (
  id VARCHAR(100) PRIMARY KEY,
  owner_user_id CHAR(36) NOT NULL UNIQUE,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  CONSTRAINT fk_personal_vault_owner FOREIGN KEY (owner_user_id)
    REFERENCES sync_users(id) ON DELETE RESTRICT
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS personal_members (
  user_id CHAR(36) PRIMARY KEY,
  vault_id VARCHAR(100) NOT NULL,
  role ENUM('owner','member') NOT NULL,
  device_name VARCHAR(120) NOT NULL,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  joined_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  last_seen_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  revoked_at DATETIME(6) NULL,
  CONSTRAINT fk_personal_member_user FOREIGN KEY (user_id)
    REFERENCES sync_users(id) ON DELETE CASCADE,
  CONSTRAINT fk_personal_member_vault FOREIGN KEY (vault_id)
    REFERENCES personal_vaults(id) ON DELETE CASCADE,
  INDEX idx_personal_members_vault (vault_id, active)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS personal_invites (
  invite_hash CHAR(64) PRIMARY KEY,
  vault_id VARCHAR(100) NOT NULL,
  created_by CHAR(36) NOT NULL,
  expires_at DATETIME(6) NOT NULL,
  consumed_at DATETIME(6) NULL,
  consumed_by CHAR(36) NULL,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  CONSTRAINT fk_personal_invite_vault FOREIGN KEY (vault_id)
    REFERENCES personal_vaults(id) ON DELETE CASCADE,
  CONSTRAINT fk_personal_invite_creator FOREIGN KEY (created_by)
    REFERENCES sync_users(id) ON DELETE CASCADE,
  INDEX idx_personal_invites_expiry (expires_at, consumed_at)
) ENGINE=InnoDB;

-- Keys the primary device sealed for its connected devices. Ciphertext only:
-- the passphrase that opens it never reaches the server.
CREATE TABLE IF NOT EXISTS personal_key_updates (
  vault_id VARCHAR(100) PRIMARY KEY,
  update_id CHAR(64) NOT NULL,
  sealed_keys TEXT NOT NULL,
  created_by CHAR(36) NOT NULL,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  expires_at DATETIME(6) NOT NULL,
  CONSTRAINT fk_personal_key_update_vault FOREIGN KEY (vault_id)
    REFERENCES personal_vaults(id) ON DELETE CASCADE,
  CONSTRAINT fk_personal_key_update_creator FOREIGN KEY (created_by)
    REFERENCES sync_users(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS personal_key_receipts (
  vault_id VARCHAR(100) NOT NULL,
  user_id CHAR(36) NOT NULL,
  update_id CHAR(64) NOT NULL,
  received_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (vault_id, user_id),
  CONSTRAINT fk_personal_key_receipt_vault FOREIGN KEY (vault_id)
    REFERENCES personal_vaults(id) ON DELETE CASCADE,
  CONSTRAINT fk_personal_key_receipt_user FOREIGN KEY (user_id)
    REFERENCES sync_users(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS personal_snapshots (
  vault_id VARCHAR(100) NOT NULL,
  user_id CHAR(36) NOT NULL,
  payload JSON NOT NULL,
  updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
    ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (vault_id, user_id),
  CONSTRAINT fk_personal_snapshot_member FOREIGN KEY (user_id)
    REFERENCES personal_members(user_id) ON DELETE CASCADE,
  CONSTRAINT fk_personal_snapshot_vault FOREIGN KEY (vault_id)
    REFERENCES personal_vaults(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS workspaces (
  id VARCHAR(100) PRIMARY KEY,
  name VARCHAR(200) NOT NULL,
  owner_user_id CHAR(36) NOT NULL,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  CONSTRAINT fk_workspace_owner FOREIGN KEY (owner_user_id)
    REFERENCES sync_users(id) ON DELETE RESTRICT
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS workspace_members (
  workspace_id VARCHAR(100) NOT NULL,
  user_id CHAR(36) NOT NULL,
  role ENUM('owner','member') NOT NULL,
  can_invite BOOLEAN NOT NULL DEFAULT FALSE,
  display_name VARCHAR(120) NOT NULL,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  joined_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  revoked_at DATETIME(6) NULL,
  PRIMARY KEY (workspace_id, user_id),
  CONSTRAINT fk_workspace_member_workspace FOREIGN KEY (workspace_id)
    REFERENCES workspaces(id) ON DELETE CASCADE,
  CONSTRAINT fk_workspace_member_user FOREIGN KEY (user_id)
    REFERENCES sync_users(id) ON DELETE CASCADE,
  INDEX idx_workspace_members_user (user_id, active)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS workspace_invites (
  invite_hash CHAR(64) PRIMARY KEY,
  workspace_id VARCHAR(100) NOT NULL,
  created_by CHAR(36) NOT NULL,
  expires_at DATETIME(6) NOT NULL,
  consumed_at DATETIME(6) NULL,
  consumed_by CHAR(36) NULL,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  CONSTRAINT fk_workspace_invite_workspace FOREIGN KEY (workspace_id)
    REFERENCES workspaces(id) ON DELETE CASCADE,
  CONSTRAINT fk_workspace_invite_creator FOREIGN KEY (created_by)
    REFERENCES sync_users(id) ON DELETE CASCADE,
  INDEX idx_workspace_invites_expiry (expires_at, consumed_at)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS shared_snapshots (
  workspace_id VARCHAR(100) NOT NULL,
  user_id CHAR(36) NOT NULL,
  payload JSON NOT NULL,
  updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
    ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (workspace_id, user_id),
  CONSTRAINT fk_shared_snapshot_workspace FOREIGN KEY (workspace_id)
    REFERENCES workspaces(id) ON DELETE CASCADE,
  CONSTRAINT fk_shared_snapshot_user FOREIGN KEY (user_id)
    REFERENCES sync_users(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- MySQL has no PostgreSQL-style RLS. All tables are private to the gateway DB
-- user and every row authorization check is performed inside main.ts. Do not
-- expose TCP/3306 publicly and do not grant this account global privileges.

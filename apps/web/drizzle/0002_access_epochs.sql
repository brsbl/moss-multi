CREATE TABLE `access_epochs` (
	`owner_user_id` text PRIMARY KEY NOT NULL,
	`epoch` integer DEFAULT 0 NOT NULL
);--> statement-breakpoint
-- Every write that can lower access in a vault owner's vaults bumps that owner's epoch in the same statement (A§8).
CREATE TRIGGER `doc_members_epoch_update` AFTER UPDATE OF role ON doc_members BEGIN
  INSERT OR IGNORE INTO access_epochs (owner_user_id, epoch) SELECT (SELECT owner_user_id FROM docs WHERE id = OLD.doc_id), 0 WHERE (SELECT owner_user_id FROM docs WHERE id = OLD.doc_id) IS NOT NULL;
  UPDATE access_epochs SET epoch = epoch + 1 WHERE owner_user_id = (SELECT owner_user_id FROM docs WHERE id = OLD.doc_id);
END;
--> statement-breakpoint
CREATE TRIGGER `doc_members_epoch_delete` AFTER DELETE ON doc_members BEGIN
  INSERT OR IGNORE INTO access_epochs (owner_user_id, epoch) SELECT (SELECT owner_user_id FROM docs WHERE id = OLD.doc_id), 0 WHERE (SELECT owner_user_id FROM docs WHERE id = OLD.doc_id) IS NOT NULL;
  UPDATE access_epochs SET epoch = epoch + 1 WHERE owner_user_id = (SELECT owner_user_id FROM docs WHERE id = OLD.doc_id);
END;
--> statement-breakpoint
CREATE TRIGGER `folder_members_epoch_update` AFTER UPDATE OF role ON folder_members BEGIN
  INSERT OR IGNORE INTO access_epochs (owner_user_id, epoch) SELECT (SELECT owner_user_id FROM folders WHERE id = OLD.folder_id), 0 WHERE (SELECT owner_user_id FROM folders WHERE id = OLD.folder_id) IS NOT NULL;
  UPDATE access_epochs SET epoch = epoch + 1 WHERE owner_user_id = (SELECT owner_user_id FROM folders WHERE id = OLD.folder_id);
END;
--> statement-breakpoint
CREATE TRIGGER `folder_members_epoch_delete` AFTER DELETE ON folder_members BEGIN
  INSERT OR IGNORE INTO access_epochs (owner_user_id, epoch) SELECT (SELECT owner_user_id FROM folders WHERE id = OLD.folder_id), 0 WHERE (SELECT owner_user_id FROM folders WHERE id = OLD.folder_id) IS NOT NULL;
  UPDATE access_epochs SET epoch = epoch + 1 WHERE owner_user_id = (SELECT owner_user_id FROM folders WHERE id = OLD.folder_id);
END;
--> statement-breakpoint
CREATE TRIGGER `share_links_epoch_update` AFTER UPDATE ON share_links BEGIN
  INSERT OR IGNORE INTO access_epochs (owner_user_id, epoch) SELECT (SELECT owner_user_id FROM docs WHERE OLD.target_type = 'doc' AND id = OLD.target_id UNION ALL SELECT owner_user_id FROM folders WHERE OLD.target_type = 'folder' AND id = OLD.target_id), 0 WHERE (SELECT owner_user_id FROM docs WHERE OLD.target_type = 'doc' AND id = OLD.target_id UNION ALL SELECT owner_user_id FROM folders WHERE OLD.target_type = 'folder' AND id = OLD.target_id) IS NOT NULL;
  UPDATE access_epochs SET epoch = epoch + 1 WHERE owner_user_id = (SELECT owner_user_id FROM docs WHERE OLD.target_type = 'doc' AND id = OLD.target_id UNION ALL SELECT owner_user_id FROM folders WHERE OLD.target_type = 'folder' AND id = OLD.target_id);
END;
--> statement-breakpoint
CREATE TRIGGER `share_links_epoch_delete` AFTER DELETE ON share_links BEGIN
  INSERT OR IGNORE INTO access_epochs (owner_user_id, epoch) SELECT (SELECT owner_user_id FROM docs WHERE OLD.target_type = 'doc' AND id = OLD.target_id UNION ALL SELECT owner_user_id FROM folders WHERE OLD.target_type = 'folder' AND id = OLD.target_id), 0 WHERE (SELECT owner_user_id FROM docs WHERE OLD.target_type = 'doc' AND id = OLD.target_id UNION ALL SELECT owner_user_id FROM folders WHERE OLD.target_type = 'folder' AND id = OLD.target_id) IS NOT NULL;
  UPDATE access_epochs SET epoch = epoch + 1 WHERE owner_user_id = (SELECT owner_user_id FROM docs WHERE OLD.target_type = 'doc' AND id = OLD.target_id UNION ALL SELECT owner_user_id FROM folders WHERE OLD.target_type = 'folder' AND id = OLD.target_id);
END;
--> statement-breakpoint
CREATE TRIGGER `docs_epoch_update` AFTER UPDATE OF folder_id, deleted_at, owner_user_id ON docs BEGIN
  INSERT OR IGNORE INTO access_epochs (owner_user_id, epoch) SELECT OLD.owner_user_id, 0 WHERE OLD.owner_user_id IS NOT NULL;
  UPDATE access_epochs SET epoch = epoch + 1 WHERE owner_user_id = OLD.owner_user_id;
  INSERT OR IGNORE INTO access_epochs (owner_user_id, epoch) SELECT NEW.owner_user_id, 0 WHERE NEW.owner_user_id IS NOT NULL;
  UPDATE access_epochs SET epoch = epoch + 1 WHERE owner_user_id = NEW.owner_user_id;
END;
--> statement-breakpoint
CREATE TRIGGER `docs_epoch_delete` AFTER DELETE ON docs BEGIN
  INSERT OR IGNORE INTO access_epochs (owner_user_id, epoch) SELECT OLD.owner_user_id, 0 WHERE OLD.owner_user_id IS NOT NULL;
  UPDATE access_epochs SET epoch = epoch + 1 WHERE owner_user_id = OLD.owner_user_id;
END;
--> statement-breakpoint
CREATE TRIGGER `folders_epoch_update` AFTER UPDATE OF parent_id, deleted_at, owner_user_id ON folders BEGIN
  INSERT OR IGNORE INTO access_epochs (owner_user_id, epoch) SELECT OLD.owner_user_id, 0 WHERE OLD.owner_user_id IS NOT NULL;
  UPDATE access_epochs SET epoch = epoch + 1 WHERE owner_user_id = OLD.owner_user_id;
  INSERT OR IGNORE INTO access_epochs (owner_user_id, epoch) SELECT NEW.owner_user_id, 0 WHERE NEW.owner_user_id IS NOT NULL;
  UPDATE access_epochs SET epoch = epoch + 1 WHERE owner_user_id = NEW.owner_user_id;
END;
--> statement-breakpoint
CREATE TRIGGER `folders_epoch_delete` AFTER DELETE ON folders BEGIN
  INSERT OR IGNORE INTO access_epochs (owner_user_id, epoch) SELECT OLD.owner_user_id, 0 WHERE OLD.owner_user_id IS NOT NULL;
  UPDATE access_epochs SET epoch = epoch + 1 WHERE owner_user_id = OLD.owner_user_id;
END;

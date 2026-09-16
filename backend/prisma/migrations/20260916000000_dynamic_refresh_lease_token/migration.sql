ALTER TABLE `contents`
  ADD COLUMN `dynamic_refresh_lease_token` VARCHAR(36) NULL;

CREATE INDEX `content_variants_storage_key_idx` ON `content_variants`(`storage_key`);

-- Persist the board/profile negotiated at registration. Defaults also backfill existing devices.
ALTER TABLE `devices`
    ADD COLUMN `board_id` VARCHAR(64) NOT NULL DEFAULT 'zectrix-note4',
    ADD COLUMN `display_profile_id` VARCHAR(64) NOT NULL DEFAULT 'zectrix-note4-400x300-mono',
    ADD COLUMN `protocol_version` INTEGER NOT NULL DEFAULT 2;

-- The original upload is optional because legacy static content retained only its rendered frame.
CREATE TABLE `content_sources` (
    `content_id` VARCHAR(191) NOT NULL,
    `status` ENUM('ready', 'unavailable') NOT NULL DEFAULT 'unavailable',
    `source_etag` VARCHAR(64) NULL,
    `mime_type` VARCHAR(127) NULL,
    `size` INTEGER NULL,
    `storage_key` VARCHAR(512) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    PRIMARY KEY (`content_id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `content_variants` (
    `id` VARCHAR(191) NOT NULL,
    `content_id` VARCHAR(191) NOT NULL,
    `profile_id` VARCHAR(64) NOT NULL,
    `status` ENUM('pending', 'ready', 'failed') NOT NULL DEFAULT 'pending',
    `pixel_format` VARCHAR(32) NOT NULL,
    `frame_codec` VARCHAR(32) NOT NULL,
    `width` INTEGER NOT NULL,
    `height` INTEGER NOT NULL,
    `frame_etag` VARCHAR(64) NULL,
    `frame_size` INTEGER NULL,
    `storage_key` VARCHAR(512) NULL,
    `render_version` INTEGER NOT NULL DEFAULT 1,
    `last_error` VARCHAR(512) NULL,
    `lease_until` DATETIME(3) NULL,
    `attempts` INTEGER NOT NULL DEFAULT 0,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    INDEX `content_variants_worker_idx`(`status`, `lease_until`),
    UNIQUE INDEX `content_variants_content_id_profile_id_key`(`content_id`, `profile_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- A legacy image has no recoverable original upload, so it cannot be rendered for a new profile.
-- Dynamic content keeps its config/data as its render source and needs no fabricated source row.
INSERT INTO `content_sources` (`content_id`, `status`, `created_at`, `updated_at`)
SELECT `id`, 'unavailable', `created_at`, `updated_at`
FROM `contents`
WHERE `kind` = 'image';

-- Preserve every currently rendered frame in place as the Note4 profile variant.
INSERT INTO `content_variants` (
    `id`,
    `content_id`,
    `profile_id`,
    `status`,
    `pixel_format`,
    `frame_codec`,
    `width`,
    `height`,
    `frame_etag`,
    `frame_size`,
    `storage_key`,
    `render_version`,
    `created_at`,
    `updated_at`
)
SELECT
    `id`,
    `id`,
    'zectrix-note4-400x300-mono',
    'ready',
    'mono1',
    'raw_mono1_msb',
    400,
    300,
    `image_etag`,
    `image_size`,
    CONCAT(`group_id`, '/', `id`, '.img'),
    1,
    `created_at`,
    `updated_at`
FROM `contents`;

ALTER TABLE `content_sources`
    ADD CONSTRAINT `content_sources_content_id_fkey`
    FOREIGN KEY (`content_id`) REFERENCES `contents`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `content_variants`
    ADD CONSTRAINT `content_variants_content_id_fkey`
    FOREIGN KEY (`content_id`) REFERENCES `contents`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

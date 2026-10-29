import type { MigrationInterface, QueryRunner } from 'typeorm';

export class M104InitialSchema1761670000000 implements MigrationInterface {
  readonly name = 'M104InitialSchema1761670000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE m104_records (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        attributes JSON NOT NULL,
        tenant_ref VARCHAR(96)
          AS (JSON_UNQUOTE(JSON_EXTRACT(attributes, '$.tenantRef'))) PERSISTENT,
        created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
        PRIMARY KEY (id),
        KEY idx_m104_records_tenant_ref (tenant_ref)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin
    `);

    await queryRunner.query(`
      CREATE TABLE m104_outbox_jobs (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        operation_key VARCHAR(128) NOT NULL,
        tenant_ref VARCHAR(96) NOT NULL,
        status ENUM('PENDING', 'RUNNING', 'DONE') NOT NULL DEFAULT 'PENDING',
        attempts INT UNSIGNED NOT NULL DEFAULT 0,
        claim_token CHAR(36) NULL,
        available_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
        lease_until DATETIME(6) NULL,
        created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
        PRIMARY KEY (id),
        UNIQUE KEY uq_m104_outbox_operation_key (operation_key),
        KEY idx_m104_outbox_pending (status, available_at, id),
        KEY idx_m104_outbox_lease (status, lease_until, id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin
    `);

    await queryRunner.query(`
      CREATE TABLE m104_fake_effects (
        operation_key VARCHAR(128) NOT NULL,
        effect_count TINYINT UNSIGNED NOT NULL DEFAULT 1,
        accepted_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
        PRIMARY KEY (operation_key)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE m104_fake_effects');
    await queryRunner.query('DROP TABLE m104_outbox_jobs');
    await queryRunner.query('DROP TABLE m104_records');
  }
}

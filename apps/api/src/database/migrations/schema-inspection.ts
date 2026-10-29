import type { QueryRunner } from 'typeorm';

function metadataString(value: string | Buffer | Uint8Array): string {
  if (Buffer.isBuffer(value)) return value.toString('utf8').trim();
  if (typeof value === 'string') return value.trim();
  return Buffer.from(value).toString('utf8').trim();
}

export async function tableExists(queryRunner: QueryRunner, tableName: string): Promise<boolean> {
  const rows = await queryRunner.query(
    'SELECT table_name AS `name` FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = ?',
    [tableName],
  ) as Array<{ name: string }>;
  return rows.length === 1;
}

export async function columnExists(
  queryRunner: QueryRunner,
  tableName: string,
  columnName: string,
): Promise<boolean> {
  const rows = await queryRunner.query(
    'SELECT column_name AS `name` FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?',
    [tableName, columnName],
  ) as Array<{ name: string }>;
  return rows.some((row) => row.name === columnName);
}

export async function tableColumns(queryRunner: QueryRunner, tableName: string): Promise<readonly string[]> {
  const rows = await queryRunner.query(
    'SELECT column_name AS `name` FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = ? ORDER BY ordinal_position',
    [tableName],
  ) as Array<{ name: string | Buffer | Uint8Array }>;
  return rows.map((row) => metadataString(row.name));
}

export async function assertExpectedColumns(
  queryRunner: QueryRunner,
  tableName: string,
  expected: readonly string[],
): Promise<boolean> {
  if (!(await tableExists(queryRunner, tableName))) return false;
  const actual = await tableColumns(queryRunner, tableName);
  if (actual.length !== expected.length || expected.some((column, index) => actual[index] !== column)) {
    throw new Error(
      `Migration preflight found an unexpected shape for table ${tableName} (expected ${expected.join(',')}; found ${actual.join(',')}).`,
    );
  }
  return true;
}

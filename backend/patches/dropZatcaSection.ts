import { DatabaseManager } from '../database/manager';

/**
 * Removes the stale `zatca_section` column which was accidentally
 * created as a Section Break UI field (which should never be persisted to DB).
 * SQLite doesn't support DROP COLUMN directly in older versions, so we use
 * a safe check before attempting the operation.
 */
async function execute(dm: DatabaseManager) {
    const knex = dm.db?.knex;
    if (!knex) return;

    // Check if the column exists before trying to drop it
    const columnInfo: Record<string, unknown>[] = await knex.raw(
        `PRAGMA table_info(SalesInvoice)`
    );

    const hasColumn = columnInfo.some(
        (col: any) => col.name === 'zatca_section'
    );

    if (!hasColumn) return;

    // SQLite >= 3.35 supports DROP COLUMN
    await knex.schema.alterTable('SalesInvoice', (table) => {
        table.dropColumn('zatca_section');
    });
}

export default { execute, beforeMigrate: false };

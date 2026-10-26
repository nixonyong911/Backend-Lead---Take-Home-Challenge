'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('wallet_txs', {
      id: {
        type: Sequelize.UUID,
        primaryKey: true,
        defaultValue: Sequelize.literal('gen_random_uuid()'),
      },
      wallet_id: { type: Sequelize.UUID, allowNull: false, references: { model: 'wallets', key: 'id' } },
      type: { type: Sequelize.STRING, allowNull: false },
      // Signed: + credit, - debit. SUM(amount) per wallet must equal wallets.balance.
      amount: { type: Sequelize.DECIMAL(36, 18), allowNull: false },
      balance_after: { type: Sequelize.DECIMAL(36, 18), allowNull: false },
      reference_id: { type: Sequelize.UUID, allowNull: false },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('now()') },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('now()') },
    });
    await queryInterface.sequelize.query(`
      ALTER TABLE wallet_txs
        ADD CONSTRAINT wallet_txs_type_valid CHECK (type IN ('deposit', 'wager', 'withdrawal')),
        ADD CONSTRAINT wallet_txs_amount_sign CHECK (
          (type = 'deposit' AND amount > 0) OR (type IN ('wager', 'withdrawal') AND amount < 0)
        ),
        ADD CONSTRAINT wallet_txs_balance_after_non_negative CHECK (balance_after >= 0),
        ADD CONSTRAINT wallet_txs_reference_type_unique UNIQUE (reference_id, type)
    `);
    await queryInterface.addIndex('wallet_txs', ['wallet_id', 'created_at']);

    // Append-only: the database itself refuses UPDATE and DELETE on ledger rows.
    await queryInterface.sequelize.query(`
      CREATE FUNCTION forbid_mutation() RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION '% is append-only', TG_TABLE_NAME;
      END;
      $$ LANGUAGE plpgsql
    `);
    await queryInterface.sequelize.query(`
      CREATE TRIGGER wallet_txs_append_only
        BEFORE UPDATE OR DELETE ON wallet_txs
        FOR EACH ROW EXECUTE FUNCTION forbid_mutation()
    `);
  },

  async down(queryInterface) {
    await queryInterface.dropTable('wallet_txs');
    await queryInterface.sequelize.query('DROP FUNCTION forbid_mutation()');
  },
};

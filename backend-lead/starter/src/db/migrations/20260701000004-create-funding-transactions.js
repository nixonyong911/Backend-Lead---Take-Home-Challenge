'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('funding_transactions', {
      id: {
        type: Sequelize.UUID,
        primaryKey: true,
        defaultValue: Sequelize.literal('gen_random_uuid()'),
      },
      member_id: { type: Sequelize.UUID, allowNull: false, references: { model: 'members', key: 'id' } },
      wallet_id: { type: Sequelize.UUID, allowNull: false, references: { model: 'wallets', key: 'id' } },
      type: { type: Sequelize.STRING, allowNull: false },
      status: { type: Sequelize.STRING, allowNull: false, defaultValue: 'Pending' },
      amount: { type: Sequelize.DECIMAL(36, 18), allowNull: false },
      psp_ref: { type: Sequelize.STRING, allowNull: true, unique: true },
      turnover_multiplier: { type: Sequelize.INTEGER, allowNull: true },
      failure_reason: { type: Sequelize.STRING, allowNull: true },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('now()') },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('now()') },
    });
    await queryInterface.sequelize.query(`
      ALTER TABLE funding_transactions
        ADD CONSTRAINT funding_transactions_type_valid CHECK (type IN ('deposit', 'withdrawal')),
        ADD CONSTRAINT funding_transactions_status_valid CHECK (status IN ('Pending', 'Completed', 'Failed')),
        ADD CONSTRAINT funding_transactions_amount_positive CHECK (amount > 0),
        ADD CONSTRAINT funding_transactions_deposit_fields CHECK (
          type <> 'deposit' OR (psp_ref IS NOT NULL AND turnover_multiplier IS NOT NULL AND turnover_multiplier >= 0)
        )
    `);
    // At most one Pending deposit per member. Concurrent POST /deposits race on this index; the loser gets 409.
    await queryInterface.sequelize.query(`
      CREATE UNIQUE INDEX funding_transactions_one_pending_deposit
        ON funding_transactions (member_id)
        WHERE type = 'deposit' AND status = 'Pending'
    `);
  },

  async down(queryInterface) {
    await queryInterface.dropTable('funding_transactions');
  },
};

'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    // Raw audit log of every callback delivery: known or unknown ref, duplicate or not.
    await queryInterface.createTable('psp_callbacks', {
      id: {
        type: Sequelize.UUID,
        primaryKey: true,
        defaultValue: Sequelize.literal('gen_random_uuid()'),
      },
      psp_ref: { type: Sequelize.STRING, allowNull: true },
      funding_transaction_id: {
        type: Sequelize.UUID,
        allowNull: true,
        references: { model: 'funding_transactions', key: 'id' },
      },
      payload: { type: Sequelize.JSONB, allowNull: false },
      outcome: { type: Sequelize.STRING, allowNull: false },
      received_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('now()') },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('now()') },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('now()') },
    });
    await queryInterface.sequelize.query(`
      ALTER TABLE psp_callbacks
        ADD CONSTRAINT psp_callbacks_outcome_valid CHECK (outcome IN (
          'credited', 'failed', 'duplicate', 'invalid_transition', 'amount_mismatch', 'unknown_ref', 'invalid_payload'
        ))
    `);
    await queryInterface.addIndex('psp_callbacks', ['psp_ref']);
    await queryInterface.sequelize.query(`
      CREATE TRIGGER psp_callbacks_append_only
        BEFORE UPDATE OR DELETE ON psp_callbacks
        FOR EACH ROW EXECUTE FUNCTION forbid_mutation()
    `);
  },

  async down(queryInterface) {
    await queryInterface.dropTable('psp_callbacks');
  },
};

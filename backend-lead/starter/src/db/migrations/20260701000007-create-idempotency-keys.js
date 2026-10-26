'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('idempotency_keys', {
      id: {
        type: Sequelize.UUID,
        primaryKey: true,
        defaultValue: Sequelize.literal('gen_random_uuid()'),
      },
      member_id: { type: Sequelize.UUID, allowNull: false, references: { model: 'members', key: 'id' } },
      key: { type: Sequelize.STRING, allowNull: false },
      request_hash: { type: Sequelize.STRING, allowNull: false },
      // Saved in the same DB transaction as the money change, so it is never null after commit.
      response_body: { type: Sequelize.JSONB, allowNull: true },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('now()') },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('now()') },
    });
    await queryInterface.addConstraint('idempotency_keys', {
      fields: ['member_id', 'key'],
      type: 'unique',
      name: 'idempotency_keys_member_key_unique',
    });
  },

  async down(queryInterface) {
    await queryInterface.dropTable('idempotency_keys');
  },
};

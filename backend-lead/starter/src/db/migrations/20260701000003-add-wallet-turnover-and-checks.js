'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    // Running turnover totals live on the wallet so they change under the same row lock as the balance.
    await queryInterface.addColumn('wallets', 'required_turnover', {
      type: Sequelize.DECIMAL(36, 18),
      allowNull: false,
      defaultValue: '0',
    });
    await queryInterface.addColumn('wallets', 'accrued_turnover', {
      type: Sequelize.DECIMAL(36, 18),
      allowNull: false,
      defaultValue: '0',
    });
    await queryInterface.sequelize.query(`
      ALTER TABLE wallets
        ADD CONSTRAINT wallets_balance_non_negative CHECK (balance >= 0),
        ADD CONSTRAINT wallets_required_turnover_non_negative CHECK (required_turnover >= 0),
        ADD CONSTRAINT wallets_accrued_turnover_non_negative CHECK (accrued_turnover >= 0)
    `);
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(`
      ALTER TABLE wallets
        DROP CONSTRAINT wallets_balance_non_negative,
        DROP CONSTRAINT wallets_required_turnover_non_negative,
        DROP CONSTRAINT wallets_accrued_turnover_non_negative
    `);
    await queryInterface.removeColumn('wallets', 'accrued_turnover');
    await queryInterface.removeColumn('wallets', 'required_turnover');
  },
};

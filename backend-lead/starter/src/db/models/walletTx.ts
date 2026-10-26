import { DataTypes, Model, Sequelize } from 'sequelize';

export type WalletTxType = 'deposit' | 'wager' | 'withdrawal';

// Append-only ledger. Rows are only ever created (by services/balance.ts); a DB trigger rejects UPDATE/DELETE.
export class WalletTx extends Model {
  declare id: string;
  declare walletId: string;
  declare type: WalletTxType;
  // Signed: + credit, - debit.
  declare amount: string;
  declare balanceAfter: string;
  declare referenceId: string;
  declare createdAt: Date;
}

export function initWalletTx(sequelize: Sequelize): void {
  WalletTx.init(
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      walletId: { type: DataTypes.UUID, allowNull: false },
      type: { type: DataTypes.STRING, allowNull: false },
      amount: { type: DataTypes.DECIMAL(36, 18), allowNull: false },
      balanceAfter: { type: DataTypes.DECIMAL(36, 18), allowNull: false },
      referenceId: { type: DataTypes.UUID, allowNull: false },
    },
    { sequelize, tableName: 'wallet_txs', underscored: true },
  );
}

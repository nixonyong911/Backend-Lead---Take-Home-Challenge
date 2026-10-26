import { DataTypes, Model, Sequelize } from 'sequelize';

export type FundingType = 'deposit' | 'withdrawal';
export type FundingStatus = 'Pending' | 'Completed' | 'Failed';

export class FundingTransaction extends Model {
  declare id: string;
  declare memberId: string;
  declare walletId: string;
  declare type: FundingType;
  declare status: FundingStatus;
  declare amount: string;
  declare pspRef: string | null;
  declare turnoverMultiplier: number | null;
  declare failureReason: string | null;
}

export function initFundingTransaction(sequelize: Sequelize): void {
  FundingTransaction.init(
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      memberId: { type: DataTypes.UUID, allowNull: false },
      walletId: { type: DataTypes.UUID, allowNull: false },
      type: { type: DataTypes.STRING, allowNull: false },
      status: { type: DataTypes.STRING, allowNull: false, defaultValue: 'Pending' },
      amount: { type: DataTypes.DECIMAL(36, 18), allowNull: false },
      pspRef: { type: DataTypes.STRING, allowNull: true, unique: true },
      turnoverMultiplier: { type: DataTypes.INTEGER, allowNull: true },
      failureReason: { type: DataTypes.STRING, allowNull: true },
    },
    { sequelize, tableName: 'funding_transactions', underscored: true },
  );
}

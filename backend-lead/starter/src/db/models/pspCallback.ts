import { DataTypes, Model, Sequelize } from 'sequelize';

export type CallbackOutcome =
  | 'credited'
  | 'failed'
  | 'duplicate'
  | 'invalid_transition'
  | 'amount_mismatch'
  | 'unknown_ref'
  | 'invalid_payload';

// Append-only audit of every callback delivery, stored exactly as received.
export class PspCallback extends Model {
  declare id: string;
  declare pspRef: string | null;
  declare fundingTransactionId: string | null;
  declare payload: unknown;
  declare outcome: CallbackOutcome;
  declare receivedAt: Date;
}

export function initPspCallback(sequelize: Sequelize): void {
  PspCallback.init(
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      pspRef: { type: DataTypes.STRING, allowNull: true },
      fundingTransactionId: { type: DataTypes.UUID, allowNull: true },
      payload: { type: DataTypes.JSONB, allowNull: false },
      outcome: { type: DataTypes.STRING, allowNull: false },
      receivedAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
    },
    { sequelize, tableName: 'psp_callbacks', underscored: true },
  );
}

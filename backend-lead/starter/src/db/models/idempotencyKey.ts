import { DataTypes, Model, Sequelize } from 'sequelize';

// Rows are written with raw INSERT ... ON CONFLICT in services/idempotency.ts; the model exists so tests truncate it.
export class IdempotencyKey extends Model {
  declare id: string;
  declare memberId: string;
  declare key: string;
  declare requestHash: string;
  declare responseBody: unknown;
}

export function initIdempotencyKey(sequelize: Sequelize): void {
  IdempotencyKey.init(
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      memberId: { type: DataTypes.UUID, allowNull: false },
      key: { type: DataTypes.STRING, allowNull: false },
      requestHash: { type: DataTypes.STRING, allowNull: false },
      responseBody: { type: DataTypes.JSONB, allowNull: true },
    },
    { sequelize, tableName: 'idempotency_keys', underscored: true },
  );
}

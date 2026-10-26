import { sequelize } from '../sequelize';
import { Member, initMember } from './member';
import { Wallet, initWallet } from './wallet';
import { FundingTransaction, initFundingTransaction } from './fundingTransaction';
import { WalletTx, initWalletTx } from './walletTx';
import { PspCallback, initPspCallback } from './pspCallback';
import { IdempotencyKey, initIdempotencyKey } from './idempotencyKey';

initMember(sequelize);
initWallet(sequelize);
initFundingTransaction(sequelize);
initWalletTx(sequelize);
initPspCallback(sequelize);
initIdempotencyKey(sequelize);

Member.hasOne(Wallet, { foreignKey: 'memberId', as: 'wallet' });
Wallet.belongsTo(Member, { foreignKey: 'memberId', as: 'member' });

export { Member, Wallet, FundingTransaction, WalletTx, PspCallback, IdempotencyKey };

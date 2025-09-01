import { Contract, nativeToScVal } from '@stellar/stellar-sdk';

export class InterestFillerContract extends Contract {
  constructor(address: string) {
    super(address);
  }

  /**
   * Invoke fill_interest function on interest filler contract
   * @param from - The address filling the interest auction
   * @param pool - The pool address for the auction being filled
   * @returns base64 encoded XDR of the operation
   */
  public fill_interest(from: string, pool: string): string {
    const invokeArgs = {
      method: 'fill_interest',
      args: [nativeToScVal(from, { type: 'address' }), nativeToScVal(pool, { type: 'address' })],
    };
    const operation = this.call(invokeArgs.method, ...invokeArgs.args);

    return operation.toXDR('base64');
  }
}

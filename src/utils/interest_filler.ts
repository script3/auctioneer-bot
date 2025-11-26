import { Contract, nativeToScVal, xdr } from '@stellar/stellar-sdk';

export class InterestFillerContract extends Contract {
  constructor(address: string) {
    super(address);
  }

  /**
   * Create operation for "fill_interest"
   *
   * Fill an interest auction.
   *
   * @param from - The address filling the interest auction
   * @param pool - The pool address for the auction being filled
   * @param fill_percent - The fill percentage for the auction
   * @param max_usdc_in - The maximum USDC input allowed for the fill
   * @returns base64 encoded XDR of the operation
   */
  public fill_interest(
    from: string,
    pool: string,
    fill_percent: number,
    max_usdc_in: bigint
  ): string {
    const invokeArgs = {
      method: 'fill_interest',
      args: [
        nativeToScVal(from, { type: 'address' }),
        nativeToScVal(pool, { type: 'address' }),
        nativeToScVal(fill_percent, { type: 'u32' }),
        nativeToScVal(max_usdc_in, { type: 'i128' }),
      ],
    };
    const operation = this.call(invokeArgs.method, ...invokeArgs.args);

    return operation.toXDR('base64');
  }

  /**
   * Create operation for "claim"
   *
   * (Only Owner) Claim all tokens of specified assets from the contract to a specified address.
   *
   * // to: Address, assets: Vec<Address>
   * @param to - The address to receive the claimed tokens
   * @param assets - The list of asset addresses to claim
   * @returns base64 encoded XDR of the operation
   */
  public claim(to: string, assets: string[]): string {
    const invokeArgs = {
      method: 'claim',
      args: [nativeToScVal(to, { type: 'address' }), nativeToScVal(assets, { type: 'address' })],
    };
    const operation = this.call(invokeArgs.method, ...invokeArgs.args);

    return operation.toXDR('base64');
  }

  /**
   * Create operation for "get_owner"
   *
   * Get the owner address
   *
   * @returns base64 encoded XDR of the operation
   */
  public get_owner(): string {
    const invokeArgs = {
      method: 'get_owner',
      args: [],
    };
    const operation = this.call(invokeArgs.method, ...invokeArgs.args);

    return operation.toXDR('base64');
  }
}

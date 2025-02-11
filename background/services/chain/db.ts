import Dexie from "dexie"

import { UNIXTime } from "../../types"
import { AccountBalance, AddressOnNetwork } from "../../accounts"
import {
  AnyEVMBlock,
  AnyEVMTransaction,
  AnyPOKTTransaction,
  Network,
  POKTBlock,
  POKTSkinnyBlock,
  EVMNetwork,
  POKTNetwork,
} from "../../networks"
import { FungibleAsset, AssetTransfer } from "../../assets"

type EVMTransaction = AnyEVMTransaction & {
  dataSource: "alchemy" | "local"
  firstSeen: UNIXTime
}

type POKTTransaction = AnyPOKTTransaction & {
  dataSource: "alchemy" | "local"
  firstSeen: UNIXTime
}

type AccountAssetTransferLookup = {
  addressNetwork: AddressOnNetwork
  retrievedAt: UNIXTime
  startBlock: bigint
  endBlock: bigint
}

interface Migration {
  id: number
  appliedAt: number
}

// TODO keep track of blocks invalidated by a reorg
// TODO keep track of transaction replacement / nonce invalidation

export class ChainDatabase extends Dexie {
  /*
   * Accounts whose transaction and balances should be tracked on a particular
   * network.
   *
   * Keyed by the [address, network name, network chain ID] triplet.
   */
  private accountsToTrack!: Dexie.Table<
    AddressOnNetwork,
    [string, string, string]
  >

  /**
   * Keep track of details of asset transfers we've looked up before per
   * account.
   */
  private accountAssetTransferLookups!: Dexie.Table<
    AccountAssetTransferLookup,
    [number]
  >

  private queuedTransactionToRetrieve!: Dexie.Table<
    {network: EVMNetwork | POKTNetwork, hash: string; firstSeen: UNIXTime, txData?: POKTTransaction | AssetTransfer},
    [number, string, string]
  >

  /*
   * Partial block headers cached to track reorgs and network status.
   *
   * Keyed by the [block hash, network name] pair.
   */
  private blocks!: Dexie.Table<AnyEVMBlock, [string, string]>

  /*
   * Historic and pending chain transactions relevant to tracked accounts.
   * chainTransaction is used in this context to distinguish from database
   * transactions.
   *
   * Keyed by the [transaction hash, network name] pair.
   */
  private chainTransactions!: Dexie.Table<EVMTransaction, [string, string]>

  /*
   * Historic and pending POKT chain transactions relevant to tracked accounts.
   * poktChainTransaction is used in this context to distinguish from database
   * transactions.
   *
   * Keyed by the [transaction hash, network name] pair.
   */
  private poktTransactions!: Dexie.Table<POKTTransaction, [string, string]>

  /*
   * Partial block headers cached to track reorgs and network status.
   *
   * Keyed by the [block hash, network name] pair.
   */
  private poktBlocks!: Dexie.Table<POKTBlock, [string, string]>

  /*
   * Partial block headers cached to track reorgs and network status.
   *
   * Keyed by the [block hash, network name] pair.
   */
  private poktSkinnyBlocks!: Dexie.Table<POKTSkinnyBlock, [string, string]>

  /*
   * Historic account balances.
   */
  private balances!: Dexie.Table<AccountBalance, number>

  private migrations!: Dexie.Table<Migration, number>

  constructor() {
    super("poktWallet/chain")
    this.version(2).stores({
      migrations: "++id,appliedAt",
      accountsToTrack:
        "&[address+network.name+network.chainID],address,network.family,network.chainID,network.name",
      accountAssetTransferLookups:
        "++id,[addressNetwork.address+addressNetwork.network.name+addressNetwork.network.chainID],[addressNetwork.address+addressNetwork.network.name+addressNetwork.network.chainID+startBlock],[addressNetwork.address+addressNetwork.network.name+addressNetwork.network.chainID+endBlock],addressNetwork.address,addressNetwork.network.chainID,addressNetwork.network.name,startBlock,endBlock",
      queuedTransactionToRetrieve:
        "&[firstSeen+hash+network.name],hash,network.name,firstSeen,txData",
      balances:
        "++id,address,assetAmount.amount,assetAmount.asset.symbol,network.name,blockHeight,retrievedAt",
      chainTransactions:
        "&[hash+network.name],hash,from,[from+network.name],to,[to+network.name],nonce,[nonce+from+network.name],blockHash,blockHeight,network.name,firstSeen,dataSource",
      blocks:
        "&[hash+network.name],[network.name+timestamp],hash,network.name,timestamp,parentHash,blockHeight,[blockHeight+network.name]",
      poktTransactions:
        "&[hash+network.name],hash,txResult.signer,[txResult.signer+network.name],txResult.recipient,[txResult.recipient+network.name],height,network.name,firstSeen,dataSource",
      poktBlocks:
        "&[header.last_block_id.hash+network.name],[network.name+timestamp],header.last_block_id.hash,network.name,timestamp,header.height,[header.height+network.name]",
      poktSkinnyBlocks:
        "&[header.height+network.name],header.height,network.name,timestamp",
    })

    this.chainTransactions.hook(
      "updating",
      (modifications, _, chainTransaction) => {
        // Only these properties can be updated on a stored transaction.
        // NOTE: Currently we do NOT throw if another property modification is
        // attempted; instead, we just ignore it.
        const allowedVariants = ["blockHeight", "blockHash", "firstSeen"]

        const filteredModifications = Object.fromEntries(
          Object.entries(modifications).filter(([k]) =>
            allowedVariants.includes(k)
          )
        )

        // If there is an attempt to modify `firstSeen`, prefer the earliest
        // first seen value between the update and the existing value.
        if ("firstSeen" in filteredModifications) {
          return {
            ...filteredModifications,
            firstSeen: Math.min(
              chainTransaction.firstSeen,
              filteredModifications.firstSeen
            ),
          }
        }

        return filteredModifications
      }
    )

    this.poktTransactions.hook(
      "updating",
      (modifications, _, poktTransaction) => {
        // Only these properties can be updated on a stored transaction.
        // NOTE: Currently we do NOT throw if another property modification is
        // attempted; instead, we just ignore it.
        const allowedVariants = ["height", "firstSeen"]

        const filteredModifications = Object.fromEntries(
          Object.entries(modifications).filter(([k]) =>
            allowedVariants.includes(k)
          )
        )

        // If there is an attempt to modify `firstSeen`, prefer the earliest
        // first seen value between the update and the existing value.
        if ("firstSeen" in filteredModifications) {
          return {
            ...filteredModifications,
            firstSeen: Math.min(
              poktTransaction.firstSeen,
              filteredModifications.firstSeen
            ),
          }
        }

        return filteredModifications
      }
    )
  }

  async getLatestBlock(network: Network): Promise<AnyEVMBlock | POKTBlock> {
    if (network.family === "EVM") {
      return (
        await this.blocks
          .where("[network.name+timestamp]")
          .above([network.name, Date.now() - 60 * 60 * 24])
          .reverse()
          .sortBy("timestamp")
      )[0]
    }

    return (
      await this.poktBlocks
        .where("[network.name+timestamp]")
        .above([network.name, Date.now() - 60 * 60 * 24])
        .reverse()
        .sortBy("timestamp")
    )[0]
  }

  async getTransaction(
    network: Network,
    txHash: string
  ): Promise<AnyEVMTransaction | AnyPOKTTransaction | null> {
    if (network.family === "EVM") {
      return (
        (
          await this.chainTransactions
            .where("[hash+network.name]")
            .equals([txHash, network.name])
            .toArray()
        )[0] || null
      )
    }
    return (
      (
        await this.poktTransactions
          .where("[hash+network.name]")
          .equals([txHash, network.name])
          .toArray()
      )[0] || null
    )
  }

  /**
   * Looks up and returns all pending transactions for the given network.
   */
  async getNetworkPendingTransactions(
    network: Network
  ): Promise<
    | (AnyEVMTransaction & { firstSeen: UNIXTime })[]
    | (AnyPOKTTransaction & { firstSeen: UNIXTime })[]
  > {
    if (network.family === "EVM") {
      return this.chainTransactions
        .where("network.name")
        .equals(network.name)
        .filter(
          (transaction) =>
            !("status" in transaction) &&
            (transaction.blockHash === null || transaction.blockHeight === null)
        )
        .toArray()
    }
    return this.poktTransactions
      .where("network.name")
      .equals(network.name)
      .filter(
        (transaction) => transaction.height === null || transaction.height === 0
      )
      .toArray()
  }

  async getBlock(
    network: Network,
    blockTag: string | number
  ): Promise<AnyEVMBlock | POKTSkinnyBlock | null> {
    if (network.family === "EVM") {
      return (
        (
          await this.blocks
            .where("[hash+network.name]")
            .equals([blockTag, network.name])
            .toArray()
        )[0] || null
      )
    }
    if (network.family === "POKT") {
      return (
        (
          await this.poktSkinnyBlocks
            .where("[header.height+network.name]")
            .equals([blockTag, network.name])
            .toArray()
        )[0] || null
      )
    }
    return null
  }

  async addOrUpdateTransaction(
    tx: AnyEVMTransaction | AnyPOKTTransaction,
    dataSource: EVMTransaction["dataSource"]
  ): Promise<void> {
    if (tx.network.family === "EVM") {
      await this.transaction("rw", this.chainTransactions, () => {
        const EVMTx = tx as AnyEVMTransaction
        return this.chainTransactions.put({
          ...EVMTx,
          firstSeen: Date.now(),
          dataSource,
        })
      })
    }
    await this.transaction("rw", this.poktTransactions, () => {
      const POKTTx = tx as AnyPOKTTransaction
      return this.poktTransactions.put({
        ...POKTTx,
        firstSeen: Date.now(),
        dataSource,
      })
    })
  }

  async getLatestAccountBalance(
    address: string,
    network: Network,
    asset: FungibleAsset
  ): Promise<AccountBalance | null> {
    // TODO this needs to be tightened up, both for performance and specificity
    const balanceCandidates = await this.balances
      .where("retrievedAt")
      .above(Date.now() - 7 * 24 * 60 * 60 * 1000)
      .filter(
        (balance) =>
          balance.address === address &&
          balance.assetAmount.asset.symbol === asset.symbol &&
          balance.network.name === network.name
      )
      .reverse()
      .sortBy("retrievedAt")
    return balanceCandidates.length > 0 ? balanceCandidates[0] : null
  }

  async addAccountToTrack(addressNetwork: AddressOnNetwork): Promise<void> {
    await this.accountsToTrack.put(addressNetwork)
  }

  async setAccountsToTrack(
    addressesAndNetworks: Set<AddressOnNetwork>
  ): Promise<void> {
    await this.transaction("rw", this.accountsToTrack, () => {
      this.accountsToTrack.clear()
      this.accountsToTrack.bulkAdd([...addressesAndNetworks])
    })
  }

  async getOldestAccountAssetTransferLookup(
    addressNetwork: AddressOnNetwork
  ): Promise<bigint | null> {
    // TODO this is inefficient, make proper use of indexing
    const lookups = await this.accountAssetTransferLookups
      .where("addressNetwork.address")
      .equals(addressNetwork.address)
      .toArray()
    return lookups.reduce(
      (oldestBlock: bigint | null, lookup) =>
        oldestBlock === null || lookup.startBlock < oldestBlock
          ? lookup.startBlock
          : oldestBlock,
      null
    )
  }

  async getNewestAccountAssetTransferLookup(
    addressNetwork: AddressOnNetwork
  ): Promise<bigint | null> {
    // TODO this is inefficient, make proper use of indexing
    const lookups = await this.accountAssetTransferLookups
      .where("addressNetwork.address")
      .equals(addressNetwork.address)
      .toArray()
    return lookups.reduce(
      (newestBlock: bigint | null, lookup) =>
        newestBlock === null || lookup.startBlock > newestBlock
          ? lookup.startBlock
          : newestBlock,
      null
    )
  }

  async recordAccountAssetTransferLookup(
    addressNetwork: AddressOnNetwork,
    startBlock: bigint,
    endBlock: bigint
  ): Promise<void> {
    await this.accountAssetTransferLookups.add({
      addressNetwork,
      startBlock,
      endBlock,
      retrievedAt: Date.now(),
    })
  }

  async addBlock(block: AnyEVMBlock | POKTBlock | POKTSkinnyBlock): Promise<void> {
    // TODO Consider exposing whether the block was added or updated.
    // TODO Consider tracking history of block changes, e.g. in case of reorg.

    if (block.network.family === "EVM") {
      await this.blocks.put(block as AnyEVMBlock)
    }

    if (block.network.family === "POKT") {
      if ((block as POKTBlock)?.header?.last_block_id) {
        await this.poktBlocks.put(block as POKTBlock)
      } else {
        await this.poktSkinnyBlocks.put(block as POKTSkinnyBlock)
      }
    }
  }

  async addBalance(accountBalance: AccountBalance): Promise<void> {
    await this.balances.add(accountBalance)
  }

  async getAccountsToTrack(): Promise<AddressOnNetwork[]> {
    return this.accountsToTrack.toArray()
  }

  async queueTransactionRetrieval(
    network: EVMNetwork | POKTNetwork,
    hash: string,
    firstSeen: UNIXTime,
    txData?: POKTTransaction | AssetTransfer
    ): Promise<void> {
      const queued = await this.queuedTransactionToRetrieve.toArray()
      const seen = new Set(queued.map(t => t.network.name+t.hash))
      if (!seen.has(network.name+hash)) {
        await this.queuedTransactionToRetrieve.add({
          network,
          hash,
          firstSeen,
          txData
        })
      }
    return
  }

  async deQueueTransactionRetrieval(
    count = 5
    ): Promise<{network: EVMNetwork | POKTNetwork, hash: string; firstSeen: UNIXTime, txData?: POKTTransaction | AssetTransfer}[]> {
      const queued = await this.queuedTransactionToRetrieve.limit(count).sortBy("firstSeen")
      
      // TODO need to remove the result from the db
      return queued
  }

  private async migrate() {
    const numMigrations = await this.migrations.count()
    if (numMigrations === 0) {
      await this.transaction("rw", this.migrations, async () => {
        this.migrations.add({ id: 0, appliedAt: Date.now() })
        // TODO decide migrations before the initial release
      })
    }
  }
}

export async function getOrCreateDB(): Promise<ChainDatabase> {
  const db = new ChainDatabase()

  // Call known-private migrate function, effectively treating it as
  // file-private.
  // eslint-disable-next-line @typescript-eslint/dot-notation
  await db["migrate"]()

  return db
}

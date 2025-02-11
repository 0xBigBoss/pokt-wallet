import { createSelector } from "@reduxjs/toolkit"
import { RootState } from ".."
import { AddressOnNetwork } from "../../accounts"
import {
  POCKET,
  ETHEREUM,
  ROPSTEN,
  RINKEBY,
  GOERLI,
  KOVAN,
  POLYGON,
} from "../../constants"
import { Network, NetworkBlockExplorerUrl } from "../../networks"
import { ActivityItem } from "../activities"

// FIXME Make this configurable.
const hardcodedMainCurrencySymbol = "USD"

export const selectShowingActivityDetail = createSelector(
  (state: RootState) => state.activities,
  (state: RootState) => state.ui.showingActivityDetailID,
  (state: RootState) => {
    const { network } = state.ui.selectedAccount
    if (network.family == "POKT" && state.networks.pokt[network.chainID] && state.networks.pokt[network.chainID].blocks)
      return state.networks.pokt[network.chainID].blocks
    else if (network.family == "EVM" && state.networks.evm[network.chainID] && state.networks.evm[network.chainID].blocks)
      return state.networks.evm[network.chainID].blocks
    else
      return []
  },
  (activities, showingActivityDetailID, blocks) => {

    return showingActivityDetailID === null
      ? null
      : Object.values(activities)
        .map<ActivityItem | undefined>(
          (accountActivities) =>
            accountActivities.entities[showingActivityDetailID]
        )
        // Filter/slice lets us use map after instead of assigning a var.
        .filter(
          (activity): activity is ActivityItem =>
            typeof activity !== "undefined"
        )
        .slice(0, 1)
        .map((activityItem) => ({
          ...activityItem,
          timestamp:
            activityItem.blockHeight === null
              ? undefined
              : blocks[activityItem.blockHeight]?.timestamp,
        }))[0]
  }
)

export const selectCurrentAccount = createSelector(
  (state: RootState) => state.ui.selectedAccount,
  ({ address, network }) => ({
    address,
    network,
    truncatedAddress: address.toLowerCase().slice(0, 7),
  })
)

export const selectCurrentAddressNetwork = createSelector(
  (state: RootState) => state.ui.selectedAccount,
  (selectedAccount) => selectedAccount
)

export const selectMainCurrencySymbol = createSelector(
  () => null,
  () => hardcodedMainCurrencySymbol
)

export const selectMainCurrency = createSelector(
  (state: RootState) => state.ui,
  (state: RootState) => state.assets,
  (state: RootState) => selectMainCurrencySymbol(state),
  (_, assets, mainCurrencySymbol) =>
    assets.find((asset) => asset.symbol === mainCurrencySymbol)
)

export const selectPopoutWindowId = createSelector(
  (state: RootState) => state.ui.popoutWindowId,
  (popoutWindowId) => popoutWindowId
)

export const selectActiveTab = createSelector(
  (state: RootState) => state.ui.activeTab,
  (activeTab) => activeTab
)

export const selectBlockExplorer = createSelector(
  (network: Network) => network,
  (network) => {
    if (
      network.family === POCKET.family &&
      network.chainID === POCKET.chainID
    ) {
      return POCKET.blockExplorerUrl
    }
    if (network.family === ETHEREUM.family) {
      if (network.chainID === ETHEREUM.chainID) {
        return ETHEREUM.blockExplorerUrl
      }
      if (network.chainID === ROPSTEN.chainID) {
        return ROPSTEN.blockExplorerUrl
      }
      if (network.chainID === RINKEBY.chainID) {
        return RINKEBY.blockExplorerUrl
      }
      if (network.chainID === GOERLI.chainID) {
        return GOERLI.blockExplorerUrl
      }
      if (network.chainID === KOVAN.chainID) {
        return KOVAN.blockExplorerUrl
      }
      if (network.chainID === POLYGON.chainID) {
        return POLYGON.blockExplorerUrl
      }
    }
  }
)

export const selectBlockExplorerForAddress = createSelector(
  (address: AddressOnNetwork) => address,
  (addressOnNetwork) => {
    // luckily they follow the same basic form
    const blockExplorerUrl = selectBlockExplorer(addressOnNetwork.network)
    return `${blockExplorerUrl}address/${addressOnNetwork.address}`
  }
)

export const selectBlockExplorerForTxHash = createSelector(
  ({ network, txHash }: { network: Network; txHash: string }) => ({
    network,
    txHash,
  }),
  ({ network, txHash }) => {
    // luckily they follow the same basic form
    const blockExplorerUrl = selectBlockExplorer(network)
    return `${blockExplorerUrl}tx/${txHash}`
  }
)
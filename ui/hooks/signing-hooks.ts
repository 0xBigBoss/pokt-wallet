import { selectKeyringStatus } from "@sendnodes/pokt-wallet-background/redux-slices/selectors"
import { SigningMethod } from "@sendnodes/pokt-wallet-background/utils/signing"
import { useEffect } from "react"
import { useHistory } from "react-router-dom"
import { useBackgroundSelector } from "./redux-hooks"

/**
 * Checks and returns whether the keyrings are currently unlocked, redirecting
 * to unlock if requested.
 *
 * If `redirectIfNot` is `true`, this hook will use react-router to redirect
 * the page to either the set-password page (if the keyrings are uninitialized)
 * or the unlock page (if the keyrings are initialized and locked).
 *
 * If `redirectIfNot` is `false`, or if the keyrings are unlocked, the unlocked
 * status is returned and no further action is taken.
 */
export const useAreKeyringsUnlocked = (redirectIfNot: boolean): boolean => {
  const keyringStatus = useBackgroundSelector(selectKeyringStatus)
  const history = useHistory()

  let redirectTarget: string | undefined
  if (keyringStatus === "uninitialized") {
    redirectTarget = "/keyring/set-password"
  } else if (keyringStatus === "locked") {
    redirectTarget = "/keyring/unlock"
  }

  useEffect(() => {
    if (
      redirectIfNot &&
      typeof redirectTarget !== "undefined" &&
      history.location.pathname !== redirectTarget
    ) {
      history.push(redirectTarget)
    }
  })

  return keyringStatus === "unlocked"
}

export function useIsSigningMethodLocked(
  signingMethod: SigningMethod | null
): boolean {
  const needsKeyrings = signingMethod?.type === "keyring"
  const areKeyringsUnlocked = useAreKeyringsUnlocked(needsKeyrings)
  return needsKeyrings && !areKeyringsUnlocked
}

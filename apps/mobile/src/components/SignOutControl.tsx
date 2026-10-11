import { useVault } from "../app-state/vault";
import { SignOutControlView } from "./SignOutControlView";

/**
 * Sign-out from Settings and the lock screen (clinical review C2), wired to the vault. What it
 * shows and asks is `SignOutControlView`.
 */
export function SignOutControl({
  variant,
  testID,
}: {
  readonly variant: "destructive" | "secondary";
  readonly testID: string;
}) {
  const vault = useVault();
  return <SignOutControlView actions={vault} variant={variant} testID={testID} />;
}

import { Navigate, useParams } from "react-router-dom";
import { keccak256, stringToHex } from "viem";
import { passportRegistryAbi } from "../abi/index.ts";
import { publicClient } from "../lib/chain.ts";
import { dep } from "../lib/data.ts";
import { useAsync } from "../lib/hooks.ts";
import { ErrorBox, Loading } from "../components/ui.tsx";
import { useStrings } from "../i18n/index.tsx";
import { common } from "../i18n/common.ts";

/** Issuer domain of the demo GS1 Digital Link identifiers (the canonical string is hashed on chain). */
export const GS1_DOMAIN = import.meta.env.VITE_GS1_DOMAIN ?? "https://id.kutle.example";

/** Resolves /01/<gtin>/21/<serial> to the passport registered under that identifier. */
export default function Gs1Resolver() {
  const { gtin, serial } = useParams();
  const c = useStrings(common);
  const q = useAsync(async () => {
    const canonical = `${GS1_DOMAIN}/01/${gtin}/21/${serial}`;
    return publicClient.readContract({ address: dep().passportRegistry, abi: passportRegistryAbi, functionName: "passportOfGs1", args: [keccak256(stringToHex(canonical))] });
  }, [gtin, serial]);
  if (q.loading) return <Loading />;
  if (q.error != null) return <ErrorBox error={q.error} onRetry={q.reload} />;
  if (!q.data) return <div className="notice notice--warn">{c.notFound}</div>;
  return <Navigate to={`/p/${q.data}`} replace />;
}

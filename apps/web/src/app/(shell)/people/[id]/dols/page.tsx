import { notFound, redirect } from "next/navigation";
import { tabHref } from "@/lib/care-record";
import { isUuid } from "@/lib/context-cookies";

/**
 * The address the API's DoLS expiry alerts link to (`/people/{id}/dols`, set in
 * apps/api/src/services/mca.ts; HZ-020): the register is on the consent, capacity and DoLS tab,
 * so the alert opens it there.
 */
export default async function DolsAlertPage({
  params,
}: {
  readonly params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  if (!isUuid(id)) notFound();
  redirect(tabHref(id, "capacity"));
}

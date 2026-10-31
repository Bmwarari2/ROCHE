import { redirect } from "next/navigation";
import { REQUESTS_PAGE } from "@/lib/data-rights";

/** The data rights section opens on its first register, the requests. */
export default function DataRightsPage(): never {
  redirect(REQUESTS_PAGE);
}

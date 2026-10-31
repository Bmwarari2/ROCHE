import { type ReactNode, Suspense } from "react";
import { WorkforceArrival } from "@/components/workforce/WorkforceArrival";

/** The workforce screens: each page opens again after a save and says what was done. */
export default function WorkforceLayout({ children }: { readonly children: ReactNode }) {
  return (
    <>
      <div className="mx-auto w-full max-w-content empty:hidden">
        <Suspense fallback={null}>
          <WorkforceArrival />
        </Suspense>
      </div>
      {children}
    </>
  );
}

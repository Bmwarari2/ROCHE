import { type ReactNode, Suspense } from "react";
import { DevelopmentArrival } from "@/components/development/DevelopmentArrival";

/** The training screens: each page opens again after a save and says what was done. */
export default function TrainingLayout({ children }: { readonly children: ReactNode }) {
  return (
    <>
      <div className="mx-auto w-full max-w-content empty:hidden">
        <Suspense fallback={null}>
          <DevelopmentArrival />
        </Suspense>
      </div>
      {children}
    </>
  );
}
